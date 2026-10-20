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
        "startsWith(github.event.pull_request.head.ref, 'archon/task-factory-')",
        'dependabot[bot]',
        "github.event.pull_request.head.ref == 'develop'",
        "github.event.pull_request.base.ref == 'main'",
        'github.event.issue.pull_request',
        "contains(github.event.comment.body, '@claude review')"
      )
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
      [ review, gate, steps.last ].each do |step|
        expect(step['if'].to_s).to include("steps.skip.outputs.skip == 'false'")
      end
    end

    it 'reviews with claude-code-action, read-only and with modest limits' do
      expect(review).to be_present
      expect(review['id']).to eq('review')
      inputs = review.fetch('with')

      expect(inputs).to include(
        'anthropic_api_key' => '${{ secrets.ANTHROPIC_API_KEY }}',
        'github_token' => '${{ github.token }}'
      )
      expect(inputs.fetch('claude_args')).to include(
        '--model claude-sonnet-5', '--max-turns 25', '--json-schema', '--allowedTools "Read,Glob,Grep"'
      )
      disallowed = inputs.fetch('claude_args')[/--disallowedTools "([^"]+)"/, 1].to_s.split(',')
      expect(disallowed).to include('Bash', 'Write', 'Edit')
    end

    it 'prompts for the review areas with P0/P1/P2 severities' do
      expect(review.fetch('with').fetch('prompt')).to include(
        'P0', 'P1', 'P2', 'ai-review/pr.diff', 'ai-review/pr.json', 'expand', 'contract', 'strong parameters',
        'mass assignment', 'N+1', 'SQL injection', 'Type:', 'CHANGELOG', 'internal host', 'weakened'
      )
    end

    it 'blocks the merge from the structured summary, also when the review step failed' do
      expect(gate).to be_present
      expect(steps.index(gate)).to be > steps.index(review)
      expect(gate.fetch('if')).to include('!cancelled()')
      expect(gate.fetch('env')).to include('STRUCTURED_OUTPUT' => '${{ steps.review.outputs.structured_output }}')
    end

    it 'posts one comment, updating the previous one' do
      comment = steps.last

      expect(comment.fetch('if')).to include('!cancelled()', 'hashFiles(')
      expect(comment.fetch('if')).to include('ai-review/comment.md')
      expect(comment.fetch('run')).to include('<!-- ai-review -->', '-X PATCH', 'comments')
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
      expect(text.scan(/secrets\.(\w+)/).flatten.uniq).to eq([ 'ANTHROPIC_API_KEY' ])
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

    describe 'the comment step' do
      # Runs the step's own script as GitHub does, with a gh shim that logs its arguments and answers
      # the lookup of the previous AI review comment with `previous_id` (empty: none yet).
      def post_comment(previous_id)
        Dir.mktmpdir do |dir|
          shim = File.join(dir, 'bin/gh')
          log = File.join(dir, 'gh.log')
          FileUtils.mkdir_p(File.dirname(shim))
          File.write(shim, <<~'SH')
            #!/usr/bin/env bash
            echo "$*" >> "$GH_LOG"
            if [[ "$*" == *--paginate* && -n "$PREVIOUS_ID" ]]; then echo "$PREVIOUS_ID"; fi
          SH
          File.chmod(0o755, shim)
          FileUtils.mkdir_p(File.join(dir, 'ai-review'))
          File.write(File.join(dir, 'ai-review/comment.md'), "<!-- ai-review -->\n")
          env = {
            'PATH' => "#{File.dirname(shim)}:#{ENV.fetch('PATH')}", 'GH_LOG' => log, 'PREVIOUS_ID' => previous_id,
            'GH_TOKEN' => 'test', 'GITHUB_REPOSITORY' => 'owner/repo', 'PR_NUMBER' => '38'
          }
          output, status = Open3.capture2e(env, 'bash', '--noprofile', '--norc', '-eo', 'pipefail', '-c',
                                           steps.last.fetch('run'), chdir: dir)
          yield output, status, File.exist?(log) ? File.readlines(log, chomp: true) : []
        end
      end

      it 'posts a new comment on the first review' do
        post_comment('') do |output, status, calls|
          expect(status).to be_success, output
          expect(calls).to include('api -X POST repos/owner/repo/issues/38/comments -F body=@ai-review/comment.md')
          expect(calls.grep(/-X PATCH/)).to be_empty
        end
      end

      it 'updates the previous comment on a re-review' do
        post_comment('4242') do |output, status, calls|
          expect(status).to be_success, output
          expect(calls).to include('api -X PATCH repos/owner/repo/issues/comments/4242 -F body=@ai-review/comment.md')
          expect(calls.grep(/-X POST/)).to be_empty
        end
      end
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
      { 'headRefName' => 'archon/task-factory-1792126613128' } => 'factory branch',
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

    # Yields the output, the exit status and the summary directory after a run with `structured_output`.
    def gate(structured_output)
      Dir.mktmpdir do |dir|
        yield(*Open3.capture2e({ 'STRUCTURED_OUTPUT' => structured_output }, script, dir), dir)
      end
    end

    it 'passes with only P2 findings and writes the summary and the comment' do
      gate('{"p0":0,"p1":0,"p2":2,"comment":"x"}') do |output, status, dir|
        expect(status).to be_success, output
        expect(JSON.parse(File.read(File.join(dir, 'result.json')))).to eq('p0' => 0, 'p1' => 0, 'p2' => 2)
        comment = File.read(File.join(dir, 'comment.md'))
        expect(comment).to start_with('<!-- ai-review -->')
        expect(comment).to include('AI-REVIEW: P0=0 P1=0 P2=2')
      end
    end

    {
      'P1' => '{"p0":0,"p1":1,"p2":0,"comment":"x"}',
      'P0' => '{"p0":1,"p1":0,"p2":0,"comment":"x"}'
    }.each do |severity, json|
      it "fails with a #{severity} finding: review required before merge" do
        gate(json) do |output, status, dir|
          expect(status.exitstatus).to eq(1)
          expect(output).to include('::error::', 'review required before merge (decision 32)')
          expect(File).to exist(File.join(dir, 'result.json'))
          expect(File).to exist(File.join(dir, 'comment.md'))
        end
      end
    end

    it 'fails closed when the summary is missing' do
      Dir.mktmpdir do |dir|
        stale = File.join(dir, 'result.json')
        File.write(stale, '{"p0":0,"p1":0,"p2":0}')
        output, status = Open3.capture2e({ 'STRUCTURED_OUTPUT' => '' }, script, dir)

        expect(status.exitstatus).to eq(1)
        expect(output).to include('AI review summary missing')
        expect(File).not_to exist(stale)
      end
    end

    [
      'not json',
      '{"p0":"0","p1":0,"p2":0,"comment":"x"}',
      '{"p0":-1,"p1":0,"p2":0,"comment":"x"}',
      '{"p0":0,"p1":0,"p2":0}'
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
