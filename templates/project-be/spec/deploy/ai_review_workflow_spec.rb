require 'rails_helper'

RSpec.describe 'AI PR review (decision 32)' do
  describe '.github/workflows/ai-review.yml' do
    let(:file) { Rails.root.join('.github/workflows/ai-review.yml') }
    let(:text) { file.read }
    let(:workflow) { YAML.load_file(file).transform_keys { |key| key == true ? 'on' : key } }
    let(:job) { workflow.fetch('jobs').fetch('ai-review') }
    let(:steps) { job.fetch('steps') }
    let(:review) { steps.find { |step| step['uses'] == 'anthropics/claude-code-action@v1' } }
    let(:gate) { steps.find { |step| step['run'] == 'bin/ai-review-gate' } }
    let(:skip) { steps.find { |step| step['run'] == 'bin/ai-review-skip ai-review/pr.json' } }
    let(:collect) { steps.find { |step| step['name'] == 'Collect the pull request' } }
    let(:base_checkout) { steps.find { |step| step.dig('with', 'path') == '.ai-review-base' } }
    let(:submit) { steps.find { |step| step['run'] == '.ai-review-base/bin/ai-review-submit ai-review' } }

    it 'runs on the five pull_request types and on new comments' do
      triggers = workflow.fetch('on')

      expect(triggers.keys).to match_array(%w[pull_request issue_comment])
      expect(triggers.fetch('pull_request').fetch('types'))
        .to match_array(%w[opened reopened ready_for_review synchronize review_requested])
      expect(triggers.fetch('issue_comment').fetch('types')).to eq([ 'created' ])
    end

    it 'starts the job only for a reviewable PR or an @claude review comment on a PR' do
      expect(job.fetch('if')).to include(
        'github.event.pull_request.draft',
        'dependabot[bot]',
        "github.event.pull_request.head.ref == 'develop'",
        "github.event.pull_request.base.ref == 'main'",
        'github.event.issue.pull_request',
        "contains(github.event.comment.body, '@claude review')"
      )
      expect(job.fetch('if')).not_to include('archon/task-factory-')
    end

    it 'runs on the RUNS_ON runner like the other workflows' do
      expect(job.fetch('runs-on')).to eq("${{ vars.RUNS_ON || 'ubuntu-latest' }}")
    end

    it 'asks only for the permissions it uses' do
      expect(workflow.fetch('permissions')).to eq('contents' => 'read', 'pull-requests' => 'write', 'issues' => 'write')
      expect(job).not_to have_key('permissions')
    end

    it 'reads the switch first and says it is disabled' do
      switch = steps.first

      expect(switch['id']).to eq('switch')
      expect(switch).not_to have_key('uses')
      expect(switch.fetch('env')).to include('AI_REVIEW' => '${{ vars.AI_REVIEW }}')
      expect(switch.fetch('run')).to include('AI review disabled (AI_REVIEW=off)', 'enabled=true')
    end

    it 'reaches no other step while the switch is off' do
      expect(steps.size).to be > 1
      steps.drop(1).each do |step|
        expect(step['if'].to_s).to include("steps.switch.outputs.enabled == 'true'"), step['name'] || step['uses']
      end
    end

    it 'reviews only PRs that bin/ai-review-skip lets through' do
      expect(skip).to be_present
      expect(skip['id']).to eq('skip')
      [ review, gate, base_checkout, submit ].each do |step|
        expect(step['if'].to_s).to include("steps.skip.outputs.skip == 'false'")
      end
    end

    it 'reviews with claude-code-action, read-only and with modest limits' do
      expect(review).to be_present
      expect(review['id']).to eq('review')
      inputs = review.fetch('with')

      expect(inputs).to include(
        '{{AI_REVIEW_AUTH_INPUT}}' => '${{ secrets.{{AI_REVIEW_SECRET}} }}',
        'github_token' => '${{ github.token }}'
      )
      expect(inputs.fetch('claude_args')).to include(
        '--model {{AI_REVIEW_MODEL}}', '--max-turns 25', '--json-schema', '--allowedTools "Read,Glob,Grep"'
      )
      disallowed = inputs.fetch('claude_args')[/--disallowedTools "([^"]+)"/, 1].to_s.split(',')
      expect(disallowed).to include('Bash', 'Write', 'Edit', 'mcp__github_inline_comment__create_inline_comment')
    end

    it 'asks the model for findings that match its counts' do
      schema = JSON.parse(review.fetch('with').fetch('claude_args')[/--json-schema '([^']+)'/, 1])
      finding = schema.dig('properties', 'findings', 'items')

      expect(schema.fetch('required')).to include('p0', 'p1', 'p2', 'comment', 'findings')
      expect(finding.fetch('required')).to match_array(%w[severity path line title body])
      expect(finding.dig('properties', 'severity', 'enum')).to eq(%w[P0 P1 P2])
      expect(finding.dig('properties', 'line')).to eq('type' => 'integer', 'minimum' => 0)
    end

    it 'prompts for the review areas with P0/P1/P2 severities' do
      expect(review.fetch('with').fetch('prompt')).to include(
        'P0', 'P1', 'P2', 'ai-review/pr.diff', 'ai-review/pr.json', 'expand', 'contract', 'strong parameters',
        'mass assignment', 'N+1', 'SQL injection', 'Type:', 'CHANGELOG', 'internal host', 'weakened',
        'findings', 'line'
      )
    end

    it 'asks for a summary without the findings list, which the workflow posts' do
      prompt = review.fetch('with').fetch('prompt')
      expect(prompt).to include('do not list the findings')
      expect(prompt).not_to include('one bullet per finding')
    end

    it "accepts the factory's branch name in the review's conventions" do
      expect(review.fetch('with').fetch('prompt'))
        .to include('feature/{{PROJECT_KEY}}-<n>-<slug>', 'hotfix/{{PROJECT_KEY}}-<n>-<slug>', 'archon/task-factory-<n>')
    end

    it 'blocks the merge from the structured summary, also when the review step failed' do
      expect(gate).to be_present
      expect(steps.index(gate)).to be > steps.index(review)
      expect(gate.fetch('if')).to include('!cancelled()')
      expect(gate.fetch('env')).to include('STRUCTURED_OUTPUT' => '${{ steps.review.outputs.structured_output }}')
    end

    it 'records the head the model reads for the review' do
      expect(collect.fetch('run')).to include('git rev-parse HEAD > ai-review/head_sha', '> ai-review/pr.diff')
      expect(steps.index(collect)).to be < steps.index(review)
    end

    it "checks out the workflow's own scripts after the gate, so the PR head never runs with the write token" do
      expect(base_checkout).to be_present
      expect(steps.index(base_checkout)).to be > steps.index(gate)
      expect(base_checkout).to include('uses' => 'actions/checkout@v4', 'continue-on-error' => true)
      expect(base_checkout.fetch('with')).to include('sparse-checkout' => 'bin', 'persist-credentials' => false)
      expect(base_checkout.fetch('with')).not_to have_key('ref')
    end

    it 'posts the review after a red gate too, and a posting failure never changes the check' do
      expect(submit).to be_present
      expect(steps.index(submit)).to be > steps.index(base_checkout)
      expect(submit.fetch('if')).to include('!cancelled()', "hashFiles('ai-review/findings.json')")
      expect(submit['continue-on-error']).to be(true)
      expect(submit.fetch('env')).to include('GH_TOKEN' => '${{ github.token }}')
    end

    it 'posts no issue comment' do
      steps.each { |step| expect(step['run'].to_s).not_to include('issues/') }
    end

    it 'says in its header that factory PRs are reviewed' do
      expect(text).not_to include('Factory PRs are skipped')
      expect(text).to include('Factory PRs are reviewed')
    end

    it 'passes untrusted PR text only through env' do
      steps.each { |step| expect(step['run'].to_s).not_to include('${{') }
    end

    it 'cancels a stale review on push but never on a comment' do
      concurrency = job.fetch('concurrency')

      expect(concurrency.fetch('group')).to include('github.event.pull_request.number || github.event.issue.number')
      expect(concurrency.fetch('cancel-in-progress')).to eq("${{ github.event_name == 'pull_request' }}")
      expect(workflow).not_to have_key('concurrency')
    end

    it 'hard-codes no secret, token or address' do
      expect(text.scan(/secrets\.(\w+)/).flatten.uniq).to eq([ '{{AI_REVIEW_SECRET}}' ])
      expect(text).not_to match(/sk-ant-/)
      expect(text).not_to match(/gh[pousr]_[A-Za-z0-9]{20,}/)
      expect(text).not_to match(/github_pat_/)
      expect(text).not_to match(/\b\d{1,3}(\.\d{1,3}){3}\b/)
    end

    it 'skips at job level exactly the pull requests bin/ai-review-skip skips' do
      logins = [ 'OlegShevtsov1', 'dependabot[bot]', 'app/dependabot' ]
      refs = [
        %w[feature/APP-12-login-page develop], %w[archon/task-factory-1792126613128 develop],
        %w[develop main], %w[hotfix/APP-7-x main]
      ]
      mismatches = logins.product(refs, [ false, true ]).filter_map do |login, (head, base), draft|
        event = {
          'event_name' => 'pull_request', 'actor' => login,
          'event' => {
            'pull_request' => {
              'draft' => draft, 'head' => { 'ref' => head }, 'base' => { 'ref' => base }, 'user' => { 'login' => login }
            }
          }
        }
        job_runs = GithubExpression.evaluate(job.fetch('if'), 'github' => event)
        pr = { 'headRefName' => head, 'baseRefName' => base, 'isDraft' => draft, 'author' => { 'login' => login } }
        script_reviews = Dir.mktmpdir do |dir|
          File.write(File.join(dir, 'pr.json'), pr.to_json)
          Open3.capture2e(Rails.root.join('bin/ai-review-skip').to_s, File.join(dir, 'pr.json')).first.include?('skip=false')
        end
        "#{pr.inspect}: job-level #{job_runs}, bin/ai-review-skip #{script_reviews}" if job_runs != script_reviews
      end

      expect(mismatches).to be_empty, mismatches.join("\n")
    end
  end

  describe 'bin/ai-review-skip' do
    let(:script) { Rails.root.join('bin/ai-review-skip').to_s }

    # Yields the output, the exit status and the GITHUB_OUTPUT text for a feature PR into develop with `overrides`.
    def skip_check(overrides = {})
      Dir.mktmpdir do |dir|
        pr = {
          'headRefName' => 'feature/APP-12-login-page', 'baseRefName' => 'develop',
          'isDraft' => false, 'author' => { 'login' => 'OlegShevtsov1' }
        }.merge(overrides)
        json_path = File.join(dir, 'pr.json')
        out_path = File.join(dir, 'github_output')
        File.write(json_path, pr.to_json)
        File.write(out_path, '')
        output, status = Open3.capture2e({ 'GITHUB_OUTPUT' => out_path }, script, json_path)
        yield output, status, File.read(out_path)
      end
    end

    it 'reviews a feature PR into develop' do
      skip_check do |output, status, github_output|
        expect(status).to be_success, output
        expect(github_output).to include('skip=false')
      end
    end

    {
      { 'isDraft' => true } => 'draft',
      { 'headRefName' => 'develop', 'baseRefName' => 'main' } => 'release PR',
      { 'author' => { 'login' => 'app/dependabot' } } => 'dependabot',
      { 'author' => { 'login' => 'dependabot[bot]' } } => 'dependabot'
    }.each do |overrides, reason|
      it "skips #{overrides.inspect} as #{reason}" do
        skip_check(overrides) do |output, status, github_output|
          expect(status).to be_success, output
          expect(github_output).to include('skip=true')
          expect(output).to include("AI review skipped: #{reason}")
        end
      end
    end

    it 'reviews a factory PR' do
      skip_check('headRefName' => 'archon/task-factory-1792126613128') do |output, status, github_output|
        expect(status).to be_success, output
        expect(github_output).to include('skip=false')
      end
    end

    it 'still reviews a hotfix into main' do
      skip_check('headRefName' => 'hotfix/APP-7-x', 'baseRefName' => 'main') do |output, status, github_output|
        expect(status).to be_success, output
        expect(github_output).to include('skip=false')
      end
    end

    it 'exits 2 with a usage message for a missing file' do
      output, status = Open3.capture2e(script, '/nonexistent/pr.json')

      expect(status.exitstatus).to eq(2)
      expect(output).to include('usage')
    end
  end

  describe 'bin/ai-review-gate' do
    let(:script) { Rails.root.join('bin/ai-review-gate').to_s }

    def finding(severity, path: 'app/x.rb', line: 11, title: "#{severity} title", body: "#{severity} body")
      { severity: severity, path: path, line: line, title: title, body: body }
    end

    # The structured output for `findings`, with the counts that match them.
    def summary(findings)
      counts = %w[P0 P1 P2].to_h { |severity| [ severity.downcase, findings.count { |f| f[:severity] == severity } ] }
      counts.merge('comment' => 'x', 'findings' => findings).to_json
    end

    # Yields the output, the exit status and the summary directory after a run with `structured_output`.
    def gate(structured_output)
      Dir.mktmpdir do |dir|
        yield(*Open3.capture2e({ 'STRUCTURED_OUTPUT' => structured_output }, script, dir), dir)
      end
    end

    it 'passes with only P2 findings and writes the summary, the comment and the findings' do
      findings = [ finding('P2'), finding('P2', line: 12) ]
      gate(summary(findings)) do |output, status, dir|
        expect(status).to be_success, output
        expect(JSON.parse(File.read(File.join(dir, 'result.json')))).to eq('p0' => 0, 'p1' => 0, 'p2' => 2)
        expect(JSON.parse(File.read(File.join(dir, 'findings.json')))).to eq(JSON.parse(findings.to_json))
        comment = File.read(File.join(dir, 'comment.md'))
        expect(comment).to start_with('<!-- ai-review -->')
        expect(comment.lines.last).to eq("AI-REVIEW: P0=0 P1=0 P2=2\n")
      end
    end

    %w[P1 P0].each do |severity|
      it "fails with a #{severity} finding: review required before merge" do
        gate(summary([ finding(severity) ])) do |output, status, dir|
          expect(status.exitstatus).to eq(1)
          expect(output).to include('::error::', 'review required before merge (decision 32)')
          %w[result.json comment.md findings.json].each { |name| expect(File).to exist(File.join(dir, name)) }
        end
      end
    end

    it 'prints every P0/P1 finding to the log for the factory, with model text kept inert' do
      findings = [ finding('P1', title: "Unsafe\nquery", body: "SQL from params.\nUse a bind."), finding('P2', title: 'Rename') ]
      gate(summary(findings)) do |output, status, _dir|
        expect(status.exitstatus).to eq(1)
        lines = output.lines(chomp: true)
        expect(lines).to include('AI review P1 app/x.rb:11 - Unsafe query', '  | SQL from params.', '  | Use a bind.')
        expect(output).not_to include('Rename')
        token = lines.find { |line| line.start_with?('::stop-commands::') }.to_s.delete_prefix('::stop-commands::')
        expect(token).not_to be_empty
        expect(lines.index("::#{token}::")).to be > lines.index('  | Use a bind.')
        expect(lines.index("::stop-commands::#{token}")).to be < lines.index('AI review P1 app/x.rb:11 - Unsafe query')
        expect(lines.index("::#{token}::")).to be < lines.index { |line| line.start_with?('::error::') }
      end
    end

    it 'names a finding on no file line as PR' do
      gate(summary([ finding('P1', path: '', line: 0, title: 'Title convention') ])) do |output, _status, _dir|
        expect(output.lines(chomp: true)).to include('AI review P1 PR - Title convention')
      end
    end

    it 'fails closed when the summary is missing' do
      Dir.mktmpdir do |dir|
        stale = %w[result.json comment.md findings.json].map { |name| File.join(dir, name) }
        stale.each { |path| File.write(path, '{}') }
        output, status = Open3.capture2e({ 'STRUCTURED_OUTPUT' => '' }, script, dir)

        expect(status.exitstatus).to eq(1)
        expect(output).to include('AI review summary missing')
        stale.each { |path| expect(File).not_to exist(path) }
      end
    end

    [
      'not json',
      '{"p0":"0","p1":0,"p2":0,"comment":"x","findings":[]}',
      '{"p0":-1,"p1":0,"p2":0,"comment":"x","findings":[]}',
      '{"p0":0,"p1":0,"p2":0,"findings":[]}',
      '{"p0":0,"p1":0,"p2":0,"comment":"x"}',
      '{"p0":0,"p1":0,"p2":0,"comment":"x","findings":"none"}',
      '{"p0":0,"p1":1,"p2":0,"comment":"x","findings":[]}',
      '{"p0":0,"p1":0,"p2":1,"comment":"x","findings":[{"severity":"P3","path":"a","line":1,"title":"t","body":"b"}]}',
      '{"p0":0,"p1":0,"p2":1,"comment":"x","findings":[{"severity":"P2","path":"a","line":-1,"title":"t","body":"b"}]}',
      '{"p0":0,"p1":0,"p2":1,"comment":"x","findings":[{"severity":"P2","path":"a","line":1.5,"title":"t","body":"b"}]}',
      '{"p0":0,"p1":0,"p2":1,"comment":"x","findings":[{"severity":"P2","path":"a","title":"t","body":"b"}]}',
      '{"p0":0,"p1":0,"p2":1,"comment":"x","findings":[{"severity":"P2","line":1,"title":"t","body":"b"}]}',
      '{"p0":0,"p1":0,"p2":1,"comment":"x","findings":[{"severity":"P2","path":"a","line":1,"title":"t"}]}'
    ].each do |json|
      it "fails closed on the invalid summary #{json.inspect}" do
        gate(json) do |output, status, _dir|
          expect(status.exitstatus).to eq(1)
          expect(output).to include('AI review summary missing or invalid')
        end
      end
    end
  end
end
