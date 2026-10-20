require 'rails_helper'

RSpec.describe 'bin/main-guard' do
  let(:sha) { 'd' * 40 }

  # Answers the n-th call from pulls.<n> (else pulls); a pulls.fail fixture makes every call fail.
  let(:gh_shim) do
    <<~'SH'
      #!/usr/bin/env bash
      echo "$*" >> "$SANDBOX/gh.log"
      [[ -e "$SANDBOX/pulls.fail" ]] && { echo 'HTTP 502' >&2; exit 1; }
      n=$(( $(grep -c . "$SANDBOX/gh.log") ))
      if [[ -e "$SANDBOX/pulls.${n}" ]]; then cat "$SANDBOX/pulls.${n}"; else cat "$SANDBOX/pulls" 2>/dev/null; fi
    SH
  end

  # Yields the output, the exit status, the gh call log and what the script wrote to GITHUB_OUTPUT.
  def guard(files: {}, env: {})
    Dir.mktmpdir do |root|
      write_executable(File.join(root, 'gh'), gh_shim)
      files.each { |name, content| File.write(File.join(root, name), content) }
      github_output = File.join(root, 'github_output')
      File.write(github_output, '')
      full_env = {
        'PATH' => "#{root}:#{ENV.fetch('PATH')}", 'SANDBOX' => root, 'GITHUB_OUTPUT' => github_output,
        'REPO' => 'owner/repo', 'SHA' => sha, 'MAIN_GUARD_SLEEP' => '0'
      }.merge(env)
      output, status = Open3.capture2e(full_env, Rails.root.join('bin/main-guard').to_s)
      yield output, status, sandbox_log(root, 'gh.log'), File.read(github_output)
    end
  end

  it 'passes when the commit came from a merged pull request' do
    guard(files: { 'pulls' => "21\n" }) do |output, status, gh_log, github_output|
      expect(status).to be_success, output
      expect(output).to include('ddddddd came from merged PR #21')
      expect(gh_log).to include("api repos/owner/repo/commits/#{sha}/pulls")
      expect(github_output).to be_empty
    end
  end

  it 'retries an empty answer, because GitHub links a fresh squash commit to its PR with a delay' do
    guard(files: { 'pulls.1' => "\n", 'pulls.2' => "\n", 'pulls' => "21\n" }) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(gh_log.lines.size).to eq(3)
    end
  end

  it 'fails and writes the alert message when no merged pull request contains the commit' do
    guard(files: { 'pulls' => "\n" }) do |output, status, gh_log, github_output|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::main-guard: commit ddddddd reached main without a merged PR')
      expect(gh_log.lines.size).to eq(5)
      expect(github_output).to eq("message=❌ owner/repo: commit ddddddd reached main without a merged PR\n")
    end
  end

  it 'names develop in the log and the alert when BRANCH is develop' do
    guard(files: { 'pulls' => "\n" }, env: { 'BRANCH' => 'develop' }) do |output, status, _gh_log, github_output|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::main-guard: commit ddddddd reached develop without a merged PR')
      expect(github_output).to eq("message=❌ owner/repo: commit ddddddd reached develop without a merged PR\n")
    end
  end

  it 'cannot decide on a persistent GitHub API error' do
    guard(files: { 'pulls.fail' => '' }) do |output, status, gh_log, github_output|
      expect(status.exitstatus).to eq(2)
      expect(gh_log.lines.size).to eq(5)
      expect(output).to include('cannot decide')
      expect(github_output).to start_with('message=❌ owner/repo: main-guard could not decide for commit ddddddd')
    end
  end

  {
    'SHA' => [ 'abc', 'D' * 40, "#{'d' * 40}\nmessage=forged" ],
    'REPO' => [ 'owner', 'owner/repo;rm' ],
    'BRANCH' => [ 'release', "main\nmessage=forged" ]
  }.each do |name, values|
    values.each do |value|
      it "rejects the invalid #{name} #{value.inspect} without calling GitHub" do
        guard(env: { name => value }) do |output, status, gh_log, github_output|
          expect(status.exitstatus).to eq(2)
          expect(output).to include("invalid #{name}")
          expect(gh_log).to be_empty
          expect(github_output.lines.size).to eq(1)
          expect(github_output).to start_with('message=❌ main-guard could not decide')
        end
      end
    end
  end

  describe '.github/workflows/main-guard.yml' do
    let(:workflow) { YAML.load_file(Rails.root.join('.github/workflows/main-guard.yml')).transform_keys { |key| key == true ? 'on' : key } }
    let(:job) { workflow.fetch('jobs').values.sole }
    let(:steps) { job.fetch('steps') }
    let(:check) { steps.find { |step| step['id'] == 'check' } }
    let(:alert) { steps.find { |step| step['name'] == 'Alert DEV_ALERTS' } }

    it 'runs on every push to main and on dispatch with an optional sha' do
      expect(workflow.fetch('on').fetch('push')).to eq('branches' => [ 'main' ])
      expect(workflow.fetch('on').fetch('workflow_dispatch').fetch('inputs').fetch('sha')).to include('type' => 'string', 'required' => false)
    end

    it 'checks the commit with bin/main-guard' do
      expect(check.fetch('run')).to eq('bin/main-guard')
      expect(check.fetch('env')).to include('REPO' => '${{ github.repository }}', 'SHA' => '${{ inputs.sha || github.sha }}')
    end

    it 'alerts DEV_ALERTS through the shared action only when the check failed' do
      expect(job.fetch('environment')).to eq('dev')
      expect(alert.fetch('uses')).to eq('OlegShevtsov1/1_mvp_infra/.github/actions/notify-telegram@env/dev')
      expect(alert.fetch('if')).to eq("failure() && steps.check.outcome == 'failure'")
      expect(alert.fetch('with').fetch('topic')).to eq('DEV_ALERTS')
      expect(alert.fetch('with').fetch('message')).to include('steps.check.outputs.message')
      %w[BOT_TOKEN CHAT_ID THREAD_ID].each do |part|
        name = "TELEGRAM_DEV_ALERTS_#{part}"
        expect(alert.fetch('env')[name]).to eq("${{ secrets.#{name} }}")
      end
    end
  end

  describe '.github/workflows/develop-guard.yml' do
    def load_workflow(name)
      YAML.load_file(Rails.root.join('.github/workflows', name)).transform_keys { |key| key == true ? 'on' : key }
    end

    def check_step(workflow)
      workflow.fetch('jobs').values.sole.fetch('steps').find { |step| step['id'] == 'check' }
    end

    def alert_step(workflow)
      workflow.fetch('jobs').values.sole.fetch('steps').find { |step| step['name'] == 'Alert DEV_ALERTS' }
    end

    let(:workflow) { load_workflow('develop-guard.yml') }
    let(:main_guard) { load_workflow('main-guard.yml') }

    it 'runs on every push to develop and on dispatch with an optional sha' do
      expect(workflow.fetch('on').fetch('push')).to eq('branches' => [ 'develop' ])
      expect(workflow.fetch('on').fetch('workflow_dispatch').fetch('inputs').fetch('sha')).to include('type' => 'string', 'required' => false)
    end

    it 'checks the commit with bin/main-guard for develop' do
      check = check_step(workflow)

      expect(check.fetch('run')).to eq('bin/main-guard')
      expect(check.fetch('env')).to include('BRANCH' => 'develop')
      expect(check.fetch('env').slice('REPO', 'SHA')).to eq(check_step(main_guard).fetch('env').slice('REPO', 'SHA'))
    end

    it 'alerts exactly like main-guard' do
      expect(alert_step(workflow)).to eq(alert_step(main_guard))
      expect(workflow.fetch('jobs').values.sole.fetch('environment')).to eq('dev')
      expect(workflow.fetch('permissions')).to eq(main_guard.fetch('permissions'))
    end
  end
end
