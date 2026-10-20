require 'rails_helper'

RSpec.describe 'bin/tdd-check' do
  # A clean identity and no global or system config, so a developer's signing or hooks cannot interfere.
  let(:git_env) do
    {
      'GIT_AUTHOR_NAME' => 'Spec', 'GIT_AUTHOR_EMAIL' => 'spec@example.com',
      'GIT_COMMITTER_NAME' => 'Spec', 'GIT_COMMITTER_EMAIL' => 'spec@example.com',
      'GIT_CONFIG_GLOBAL' => File::NULL, 'GIT_CONFIG_NOSYSTEM' => '1'
    }
  end

  around do |example|
    Dir.mktmpdir do |dir|
      @repo = dir
      git('init', '-q', '-b', 'main')
      @base = commit('chore: start', 'README.md' => "start\n")
      git('switch', '-q', '-c', 'work')
      example.run
    end
  end

  def git(*args)
    output, status = Open3.capture2e(git_env, 'git', *args, chdir: @repo)
    raise output unless status.success?

    output.strip
  end

  def commit(subject, files)
    files.each do |path, content|
      full = File.join(@repo, path)
      FileUtils.mkdir_p(File.dirname(full))
      File.write(full, content)
    end
    git('add', '-A')
    git('commit', '-q', '-m', subject)
    git('rev-parse', 'HEAD')
  end

  # Yields the output, the exit status and what the script wrote to GITHUB_OUTPUT.
  def tdd_check(base = @base, head = git('rev-parse', 'HEAD'), body: nil, main_ref: nil, env: {})
    Tempfile.create('github_output') do |github_output|
      env = git_env.merge('GITHUB_OUTPUT' => github_output.path, 'MAIN_REF' => main_ref).merge(env)
      env['PR_BODY'] = body unless body.nil?
      output, status = Open3.capture2e(env, Rails.root.join('bin/tdd-check').to_s, base, head, chdir: @repo)
      yield output, status, File.read(github_output.path)
    end
  end

  it 'passes test( then feat( and outputs the test commit' do
    test_sha = commit('test(x): failing spec', 'spec/a_spec.rb' => "red\n")
    commit('feat(x): make it pass', 'app/a.rb' => "green\n")

    tdd_check do |output, status, github_output|
      expect(status).to be_success, output
      expect(github_output).to eq("test_sha=#{test_sha}\n")
    end
  end

  it 'accepts fix( as the GREEN commit and a refactor( after it that changes spec/' do
    commit('test(x): failing spec', 'spec/a_spec.rb' => "red\n")
    commit('fix(x): make it pass', 'app/a.rb' => "green\n")
    commit('refactor(x): tidy', 'spec/a_spec.rb' => "red, tidied\n")

    tdd_check { |output, status| expect(status).to be_success, output }
  end

  it 'ignores a merge from the base branch, and the spec changes it brings, between test( and feat(' do
    test_sha = commit('test(x): failing spec', 'spec/a_spec.rb' => "red\n")
    git('switch', '-q', 'main')
    base = commit('feat(y): elsewhere', 'spec/b_spec.rb' => "other\n")
    git('switch', '-q', 'work')
    git('merge', '-q', '--no-edit', 'main')
    commit('feat(x): make it pass', 'app/a.rb' => "green\n")

    tdd_check(base) do |output, status, github_output|
      expect(status).to be_success, output
      expect(github_output).to eq("test_sha=#{test_sha}\n")
    end
  end

  it 'fails condition 1 when the first commit is not test(' do
    commit('feat(x): code first', 'app/a.rb' => "green\n")
    commit('test(x): spec later', 'spec/a_spec.rb' => "red\n")
    commit('fix(x): follow-up', 'app/a.rb' => "green again\n")

    tdd_check do |output, status, github_output|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::condition 1 failed', 'feat(x): code first')
      expect(output).not_to include('condition 3 failed')
      expect(github_output).to be_empty
    end
  end

  it 'fails condition 3 when no feat( or fix( commit follows the test commit' do
    commit('test(x): failing spec', 'spec/a_spec.rb' => "red\n")
    commit('chore(x): something else', 'app/a.rb' => "green\n")

    tdd_check do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::condition 3 failed')
    end
  end

  it 'fails condition 3 when a commit between test( and feat( changes spec/' do
    commit('test(x): failing spec', 'spec/a_spec.rb' => "red\n")
    commit('test(x): adjust the spec', 'spec/a_spec.rb' => "weakened\n")
    commit('feat(x): make it pass', 'app/a.rb' => "green\n")

    tdd_check do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::condition 3 failed', 'spec/a_spec.rb')
    end
  end

  it 'fails condition 3 when the feat( commit itself changes spec/' do
    commit('test(x): failing spec', 'spec/a_spec.rb' => "red\n")
    commit('feat(x): make it pass', 'app/a.rb' => "green\n", 'spec/a_spec.rb' => "weakened\n")

    tdd_check do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::condition 3 failed', 'spec/a_spec.rb')
    end
  end

  it 'reports every failing condition in one run' do
    commit('feat(x): code first', 'app/a.rb' => "green\n")
    commit('test(x): spec later', 'spec/a_spec.rb' => "red\n")

    tdd_check do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::condition 1 failed', '::error::condition 3 failed')
    end
  end

  it 'fails conditions 1 and 3 when there is no test( commit' do
    commit('feat(x): no tests', 'app/a.rb' => "green\n")

    tdd_check do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::condition 1 failed', '::error::condition 3 failed')
    end
  end

  it 'exempts a Type: ci pull request that changes only .github/, .archon/, docs/ and Markdown files' do
    commit('APP-0: switch runners', '.github/workflows/a.yml' => "a\n", '.archon/p.yaml' => "p\n",
                                      'docs/a.txt' => "a\n", 'NOTES.md' => "n\n")

    tdd_check(body: "Summary.\n\nType: ci\n") do |output, status, github_output|
      expect(status).to be_success, output
      expect(output).to include('exempt')
      expect(output).not_to include('::error::')
      expect(github_output).to be_empty
    end
  end

  it 'exempts Type: chore and Type: docs, with CRLF line ends' do
    commit('APP-0: update the docs', 'docs/a.md' => "a\n")

    %w[chore docs].each do |type|
      tdd_check(body: "Summary.\r\n\r\nType: #{type}\r\n") do |output, status, github_output|
        expect(status).to be_success, output
        expect(github_output).to be_empty
      end
    end
  end

  it 'keeps the strict order for a Type: ci pull request that changes other files' do
    commit('APP-0: switch runners', '.github/workflows/a.yml' => "a\n", 'app/a.rb' => "code\n")

    tdd_check(body: "Type: ci\n") do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::condition 1 failed')
    end
  end

  it 'keeps the strict order for Type: feat, fix and refactor, even when only docs change' do
    commit('APP-0: docs only', 'docs/a.md' => "a\n")

    %w[feat fix refactor].each do |type|
      tdd_check(body: "Type: #{type}\n") do |output, status|
        expect(status.exitstatus).to eq(1), "Type: #{type}: #{output}"
        expect(output).to include('::error::condition 1 failed')
      end
    end
  end

  it 'keeps the strict order for Type: test, even when only docs change' do
    commit('APP-0: docs only', 'docs/a.md' => "a\n")

    tdd_check(body: "Type: test\n") do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::condition 1 failed')
    end
  end

  it 'passes a back-merge whose every commit is already on main, writing no test commit' do
    git('switch', '-q', 'main')
    commit('APP-2: hotfix (#2)', 'app/a.rb' => "fixed\n")
    git('switch', '-q', 'work')
    git('merge', '-q', '--no-ff', '--no-edit', 'main')

    tdd_check(main_ref: 'main') do |output, status, github_output|
      expect(status).to be_success, output
      expect(output).to include('already on main')
      expect(github_output).to be_empty
    end
  end

  it 'fails, never passes as already on main, when the commits not on main cannot be listed' do
    commit('test(x): failing spec', 'spec/a_spec.rb' => "red\n")
    commit('feat(x): make it pass', 'app/a.rb' => "green\n")
    real_git = ENV.fetch('PATH').split(':').map { |dir| File.join(dir, 'git') }.find { |path| File.executable?(path) }

    Dir.mktmpdir do |shims|
      write_executable(File.join(shims, 'git'), <<~SH)
        #!/usr/bin/env bash
        for arg; do [[ "$arg" == ^* ]] && { echo 'fatal: simulated failure' >&2; exit 128; }; done
        exec #{real_git} "$@"
      SH
      tdd_check(main_ref: 'main', env: { 'PATH' => "#{shims}:#{ENV.fetch('PATH')}" }) do |output, status|
        expect(status).not_to be_success
        expect(output).not_to include('already on main')
      end
    end
  end

  it 'still checks the commits of a back-merge that are not on main' do
    git('switch', '-q', 'main')
    commit('APP-2: hotfix (#2)', 'app/a.rb' => "fixed\n")
    git('switch', '-q', 'work')
    git('merge', '-q', '--no-ff', '--no-edit', 'main')
    commit('feat(x): code first', 'app/b.rb' => "b\n")

    tdd_check(main_ref: 'main') do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::condition 1 failed', 'feat(x): code first')
    end
  end

  it 'keeps the strict order when the body has more than one Type: line' do
    commit('APP-0: docs only', 'docs/a.md' => "a\n")

    tdd_check(body: "Type: ci\nType: docs\n") do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::condition 1 failed')
    end
  end
end

RSpec.describe '.github/workflows/tdd-check.yml' do
  def load_workflow(file)
    YAML.load_file(Rails.root.join('.github/workflows', file)).transform_keys { |key| key == true ? 'on' : key }
  end

  let(:workflow) { load_workflow('tdd-check.yml') }
  let(:order) { workflow.fetch('jobs').fetch('order') }
  let(:red) { workflow.fetch('jobs').fetch('red') }
  let(:rails_tests) { load_workflow('rails-test.yml') }

  it 'runs on pull requests and checks the order with bin/tdd-check' do
    expect(workflow.fetch('on')).to have_key('pull_request')
    expect(order.fetch('steps').map { |step| step['run'].to_s }).to include(a_string_including('bin/tdd-check'))
    expect(order.fetch('outputs')).to have_key('test_sha')
  end

  it 'passes the pull request body to bin/tdd-check only through env, and runs RED only for a test commit' do
    check = order.fetch('steps').find { |step| step['run'].to_s.include?('bin/tdd-check') }

    expect(workflow.fetch('on').fetch('pull_request').fetch('types')).to include('edited')
    expect(check.fetch('env').fetch('PR_BODY')).to eq('${{ github.event.pull_request.body }}')
    expect(check.fetch('run')).not_to include('github.event')
    expect(red.fetch('if')).to include("needs.order.outputs.test_sha != ''")
  end

  it 'drops commits already on main and skips the release pull request develop into main' do
    check = order.fetch('steps').find { |step| step['run'].to_s.include?('bin/tdd-check') }

    expect(check.fetch('env').fetch('MAIN_REF')).to eq('origin/main')
    expect(order.fetch('if')).to include("github.event.pull_request.head.ref == 'develop'", "github.event.pull_request.base.ref == 'main'")
  end

  it 'runs the suite on the test commit in the same environment as Rails Tests' do
    checkout = red.fetch('steps').find { |step| step['uses'].to_s.start_with?('actions/checkout@') }

    expect(red.fetch('needs')).to eq('order')
    expect(checkout.fetch('with').fetch('ref')).to eq('${{ needs.order.outputs.test_sha }}')
    expect(red.fetch('services')).to eq(rails_tests.fetch('jobs').fetch('test').fetch('services'))
    expect(red.fetch('env')).to eq(rails_tests.fetch('env'))
    expect(red.fetch('steps').map { |step| step['run'].to_s }).to include(a_string_including('bundle exec rspec'))
  end

  it 'records the RED result as a commit status on the test commit' do
    expect(red.fetch('permissions')).to include('statuses' => 'write')
    runs = red.fetch('steps').map { |step| step['run'].to_s }
    expect(runs).to include(a_string_including('statuses/').and(a_string_including('tdd-check/red')))
  end

  describe 'deciding whether RED is proven' do
    def step(name)
      red.fetch('steps').find { |candidate| candidate['name'] == name } || raise("no step #{name.inspect}")
    end

    # Runs a step's script the way Actions does (bash -e); yields its output, exit status and GITHUB_OUTPUT.
    def run_step(name, env)
      Dir.mktmpdir do |dir|
        github_output = File.join(dir, 'github_output')
        File.write(github_output, '')
        output, status = Open3.capture2e(
          { 'GITHUB_OUTPUT' => github_output, 'GITHUB_REPOSITORY' => 'owner/repo' }.merge(env),
          'bash', '-e', '-c', step(name).fetch('run')
        )
        yield output, status, File.read(github_output)
      end
    end

    # The RSpec run step writes its JSON report to RUNNER_TEMP; this produces a real one from `spec_source`.
    def classify(spec_source)
      Dir.mktmpdir do |dir|
        File.write(File.join(dir, 'probe_spec.rb'), spec_source)
        _, status = Open3.capture2e(
          RbConfig.ruby, Gem.bin_path('rspec-core', 'rspec'),
          '--format', 'json', '--out', File.join(dir, 'rspec.json'), 'probe_spec.rb', chdir: dir
        )
        run_step('Classify the result', 'EXIT_CODE' => status.exitstatus.to_s, 'RUNNER_TEMP' => dir) do |output, step_status, outputs|
          expect(step_status).to be_success, output
          return outputs[/^result=(.*)$/, 1]
        end
      end
    end

    it 'writes the RSpec report where the classification reads it' do
      expect(step('RSpec on the test commit').fetch('run')).to include('--format json --out "${RUNNER_TEMP}/rspec.json"')
    end

    it 'is red when an example failed' do
      expect(classify("RSpec.describe('a') { it('fails') { expect(1).to eq(2) } }\n")).to eq('red')
    end

    it 'is green when every example passed' do
      expect(classify("RSpec.describe('a') { it('passes') { expect(1).to eq(1) } }\n")).to eq('green')
    end

    it 'is broken when RSpec failed while loading the files, before any example ran' do
      expect(classify("RSpec.describe('a') { it('passes') { expect(1).to eq(1) } }\nundefined_name\n")).to eq('broken')
    end

    it 'is broken when RSpec failed without writing a report' do
      Dir.mktmpdir do |dir|
        run_step('Classify the result', 'EXIT_CODE' => '1', 'RUNNER_TEMP' => dir) do |output, status, outputs|
          expect(status).to be_success, output
          expect(outputs).to include("result=broken\n")
        end
      end
    end

    it 'passes Require RED only for a red result' do
      run_step('Require RED', 'RESULT' => 'red', 'TEST_SHA' => 'a' * 40) do |output, status|
        expect(status).to be_success, output
      end
    end

    it 'fails Require RED with condition 2 when the test commit is green' do
      run_step('Require RED', 'RESULT' => 'green', 'TEST_SHA' => 'a' * 40) do |output, status|
        expect(status.exitstatus).to eq(1)
        expect(output).to include('::error::condition 2 failed: the test commit aaaaaaa is green')
      end
    end

    it 'fails Require RED with condition 2, naming the load failure, when no example failed' do
      run_step('Require RED', 'RESULT' => 'broken', 'TEST_SHA' => 'a' * 40) do |output, status|
        expect(status.exitstatus).to eq(1)
        expect(output).to include('::error::condition 2 failed:', 'without a failing example')
      end
    end

    it 'records a load failure as an error status, not as RED' do
      Dir.mktmpdir do |bin|
        write_executable(File.join(bin, 'gh'), "#!/usr/bin/env bash\necho \"$*\" > \"#{bin}/gh.log\"\n")
        env = { 'PATH' => "#{bin}:#{ENV.fetch('PATH')}", 'RESULT' => 'broken', 'TEST_SHA' => 'a' * 40, 'RUN_URL' => 'https://example.com/run' }
        run_step('Record the result as the tdd-check/red status', env) do |output, status|
          expect(status).to be_success, output
          expect(File.read(File.join(bin, 'gh.log'))).to include('state=error', 'context=tdd-check/red')
        end
      end
    end
  end
end
