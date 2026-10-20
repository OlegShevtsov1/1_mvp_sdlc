require 'rails_helper'

RSpec.describe 'deploy/release_watch.sh' do
  let(:version) { "sha-#{DeploySandbox::SHA}" }
  let(:zone) { project_env.fetch('PROJECT_ZONE') }
  let(:slug) { "#{project_env.fetch('PROJECT_NAME')}-be-prod" }
  let(:watch_env) { { 'WATCH_SECONDS' => '90', 'WATCH_INTERVAL' => '30' } }

  describe 'health' do
    it 'checks the public /health once per interval for the whole window and counts the failures' do
      run_script('release_watch.sh', 'health', version, env: watch_env) do |output, status, root|
        expect(status).to be_success, output
        expect(sandbox_log(root, 'curl.log').lines(chomp: true)).to eq([ "-fsS --max-time 10 https://#{zone}/health" ] * 3)
        expect(output).to match(/^since=\d{10}$/)
        expect(output).to include("checks=3\n", "failed=0\n")
      end
    end

    it 'counts a check as failed while /health reports another release' do
      run_script('release_watch.sh', 'health', version, env: watch_env, release: 'b' * 40) do |output, status|
        expect(status).to be_success, output
        expect(output).to include("checks=3\n", "failed=3\n")
      end
    end

    it 'refuses a version that is not sha-<40 hex>' do
      run_script('release_watch.sh', 'health', 'v0.1.0', env: watch_env) do |_output, status, root|
        expect(status.exitstatus).to eq(2)
        expect(sandbox_log(root, 'curl.log')).to be_empty
      end
    end
  end

  describe 'verdict' do
    def verdict(issues: '', **env)
      Tempfile.create('issues') do |file|
        file.write(issues)
        file.flush
        defaults = {
          'TAG' => 'v0.1.0', 'VERSION' => version, 'CHECKS' => '20', 'FAILED' => '0', 'ISSUES_FILE' => file.path,
          'GLITCHTIP_OUTCOME' => 'success', 'RUN_URL' => 'https://example.test/run/1'
        }
        run_script('release_watch.sh', 'verdict', env: defaults.merge(env.transform_keys(&:to_s))) do |output, status|
          return [ output, status ]
        end
      end
    end

    def issue(short_id, title)
      %({"id":"1","shortId":"#{short_id}","title":"#{title}","firstSeen":"2026-10-16T10:00:00Z"}\n)
    end

    it 'is ✅ for a clean window, naming the tag and the GlitchTip project' do
      output, status = verdict
      expect(status).to be_success, output
      expect(output).to include("result=ok\n")
      message = output[/^message=(.*)$/, 1]
      expect(message).to start_with('✅')
      expect(message).to include('v0.1.0', slug, '20/20', 'https://example.test/run/1')
    end

    it 'is ❌ for failed health checks, and says prod was not rolled back' do
      output, = verdict(FAILED: '2')
      expect(output).to include("result=fail\n")
      message = output[/^message=(.*)$/, 1]
      expect(message).to start_with('❌')
      expect(message).to include('2/20', 'not rolled back', 'confirm=ROLLBACK-prod', 'deploy/rollback.sh prod')
    end

    it 'is ❌ for new GlitchTip issues, naming at most three with titles cut to 80 characters' do
      issues = issue('APP-BE-PROD-1', 'glitchtip smoke unhandled c4') + issue('X-2', 'b' * 100) +
               issue('X-3', 'third') + issue('X-4', 'fourth')
      output, = verdict(issues: issues)
      expect(output).to include("result=fail\n")
      message = output[/^message=(.*)$/, 1]
      expect(message).to include('4 new GlitchTip issues', 'APP-BE-PROD-1 glitchtip smoke unhandled c4', "X-2 #{'b' * 80}", 'X-3 third')
      expect(message).not_to include('b' * 81, 'X-4')
    end

    it 'is ❌ when the GlitchTip query failed, never a silent ✅' do
      output, = verdict(GLITCHTIP_OUTCOME: 'failure')
      expect(output).to include("result=fail\n")
      expect(output[/^message=(.*)$/, 1]).to include('GlitchTip check failed')
    end

    it 'is ❌ when the health watch did not run' do
      output, = verdict(CHECKS: '', FAILED: '')
      expect(output).to include("result=fail\n")
    end

    it 'keeps issue titles out of the log: in Actions they are masked' do
      output, = verdict(issues: issue('X-1', 'a user email somewhere'), GITHUB_ACTIONS: 'true')
      expect(output).to include("::add-mask::a user email somewhere\n")
    end

    it 'never rolls back' do
      text = Rails.root.join('deploy/release_watch.sh').read
      expect(text).not_to match(%r{^\s*(deploy/)?rollback\.sh|kamal rollback})
    end
  end
end

RSpec.describe 'deploy/glitchtip_issues.sh' do
  let(:name) { project_env.fetch('PROJECT_NAME') }
  let(:token) { 'glitchtip-token-from-spec' }
  let(:since) { Time.utc(2026, 10, 16, 10, 0, 0).to_i }
  let(:base_env) { { 'GLITCHTIP_API_TOKEN' => token, 'SENTRY_DSN' => 'http://pubkey@192.0.2.50:8000/3' } }
  let(:page1) do
    [
      { id: '11', shortId: 'P-11', title: 'old', firstSeen: '2026-10-16T09:59:59.999999Z' },
      { id: '12', shortId: 'P-12', title: 'new one', firstSeen: '2026-10-16T10:00:00.250000Z' }
    ].to_json
  end
  let(:page2) { [ { id: '13', shortId: 'P-13', title: 'newer', firstSeen: '2026-10-16T10:05:00+00:00' } ].to_json }
  let(:next_link) do
    "HTTP/1.1 200 OK\r\nLink: <http://glitchtip.internal/api/0/projects/#{name}/#{name}-be-prod/issues/?cursor=abc>; " \
      "rel=\"previous\"; results=\"false\", <http://glitchtip.internal/api/0/projects/#{name}/#{name}-be-prod/issues/?cursor=def>; " \
      "rel=\"next\"; results=\"true\"; cursor=\"def\"\r\n\r\n"
  end

  # Yields (output, status, sandbox root) while the sandbox still exists.
  def issues(*args, env: base_env, files: {}, &block)
    run_script('glitchtip_issues.sh', *args, env: env, files: files, &block)
  end

  it 'lists the issues of <name>-be-prod first seen since the start, following the next page' do
    issues(since.to_s, files: { 'glitchtip-page1.json' => page1, 'glitchtip-page1.headers' => next_link,
                                'glitchtip-page2.json' => page2 }) do |output, status, root|
      expect(status).to be_success, output
      expect(output.lines.map { |line| JSON.parse(line)['shortId'] }).to eq(%w[P-12 P-13])
      expect(JSON.parse(output.lines.first).keys).to eq(%w[id shortId title firstSeen])
      calls = sandbox_log(root, 'curl.log').lines(chomp: true)
      expect(calls.size).to eq(2)
      expect(calls.first).to end_with("http://192.0.2.50:8000/api/0/projects/#{name}/#{name}-be-prod/issues/")
      expect(calls.last).to end_with("http://192.0.2.50:8000/api/0/projects/#{name}/#{name}-be-prod/issues/?cursor=def")
    end
  end

  it 'leaves out issues first seen at or after the end of the window' do
    issues(since.to_s, (since + 60).to_s, files: { 'glitchtip-page1.json' => page1, 'glitchtip-page1.headers' => next_link,
                                                 'glitchtip-page2.json' => page2 }) do |output, status|
      expect(status).to be_success, output
      expect(output.lines.map { |line| JSON.parse(line)['shortId'] }).to eq(%w[P-12])
    end
  end

  it 'prefers GLITCHTIP_API_URL over the DSN' do
    issues(since.to_s, env: base_env.merge('GLITCHTIP_API_URL' => 'https://gt.example.test'),
                       files: { 'glitchtip-page1.json' => '[]' }) do |output, status, root|
      expect(status).to be_success, output
      expect(sandbox_log(root, 'curl.log')).to include("https://gt.example.test/api/0/projects/#{name}/#{name}-be-prod/issues/")
    end
  end

  it 'sends the token only as a header on stdin, never in argv or output' do
    issues(since.to_s, files: { 'glitchtip-page1.json' => page1 }) do |output, _status, root|
      expect(sandbox_log(root, 'curl.stdin')).to include("Authorization: Bearer #{token}")
      expect(sandbox_log(root, 'curl.log')).not_to be_empty
      expect(sandbox_log(root, 'curl.log')).not_to include(token)
      expect(output).not_to include(token)
    end
  end

  it 'never prints the GlitchTip address unmasked' do
    [ {}, { 'GITHUB_ACTIONS' => 'true' } ].each do |extra|
      issues(since.to_s, env: base_env.merge(extra), files: { 'glitchtip-page1.json' => page1 }) do |output, status|
        expect(status).to be_success, output
        expect(output.lines.grep(/192\.0\.2\.50/)).to all(start_with('::add-mask::'))
      end
    end
  end

  {
    'not an array' => '{"detail":"nope"}',
    'an issue without firstSeen' => '[{"id":"1","shortId":"P-1","title":"t"}]',
    'an issue with a numeric id' => '[{"id":1,"shortId":"P-1","title":"t","firstSeen":"2026-10-16T10:00:00Z"}]'
  }.each do |what, body|
    it "fails the shape check for #{what}" do
      issues(since.to_s, files: { 'glitchtip-page1.json' => body }) do |output, status|
        expect(status.exitstatus).to eq(3)
        expect(output).to include('GlitchTip API shape check failed')
      end
    end
  end

  it 'fails the shape check for an HTTP error' do
    issues(since.to_s, files: { 'glitchtip-page1.json' => '{"detail":"auth"}', 'glitchtip-code' => '401' }) do |output, status|
      expect(status.exitstatus).to eq(3)
      expect(output).to include('HTTP 401')
    end
  end

  it 'needs the token' do
    issues(since.to_s, env: base_env.merge('GLITCHTIP_API_TOKEN' => nil)) do |output, status|
      expect(status.exitstatus).to eq(2)
      expect(output).to include('GLITCHTIP_API_TOKEN is not set')
    end
  end

  it 'needs a start time in epoch seconds' do
    issues('yesterday') { |_output, status| expect(status.exitstatus).to eq(2) }
  end
end
