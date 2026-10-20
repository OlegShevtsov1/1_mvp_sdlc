require 'rails_helper'

RSpec.describe 'bin/wait-dev-deploy' do
  let(:sha) { 'b' * 40 }

  # Answers every gh call from a fixture file named after it: run list → list-<workflow file>,
  # run view <id> → view-<id>, api → main, workflow run → dispatch. <key>.<n>, when it exists,
  # answers the n-th call instead, so a run can change state between polls.
  let(:gh_shim) do
    <<~'SH'
      #!/usr/bin/env bash
      echo "$*" >> "$SANDBOX/gh.log"
      answer() {
        local n
        n=$(( $(cat "$SANDBOX/$1.count" 2>/dev/null || echo 0) + 1 ))
        echo "${n}" > "$SANDBOX/$1.count"
        if [[ -e "$SANDBOX/$1.${n}" ]]; then cat "$SANDBOX/$1.${n}"
        elif [[ -e "$SANDBOX/$1" ]]; then cat "$SANDBOX/$1"
        else echo "gh shim: no fixture $1" >&2; exit 1
        fi
      }
      case "$1 $2" in
        'run list')
          while [[ $# -gt 0 && "$1" != '--workflow' ]]; do shift; done
          answer "list-$2" ;;
        'run view') answer "view-$3" ;;
        'workflow run') answer dispatch ;;
        api*) answer main ;;
        *) echo "gh shim: unexpected $*" >&2; exit 1 ;;
      esac
    SH
  end

  let(:deploy_jobs) { [ 'Preflight (secrets)', 'Probe (shared VPN actions)', 'Build once (ECR)', 'Deploy (VPN + Kamal)' ] }

  def url(id)
    "https://github.com/owner/repo/actions/runs/#{id}"
  end

  def job(name, conclusion, steps = [])
    { name: name, status: 'completed', conclusion: conclusion, steps: steps }
  end

  def view(id, jobs, status: 'completed', head_sha: sha)
    { status: status, conclusion: status == 'completed' ? 'success' : '', url: url(id), headSha: head_sha, jobs: jobs }.to_json
  end

  def gate_only(id)
    view(id, [ job('Gate', 'success'), *(deploy_jobs + [ 'Report', 'Notify (Telegram)' ]).map { |name| job(name, 'skipped') } ])
  end

  # A run the gate let through; `results` overrides job conclusions, `step` is "Deploy or roll back".
  def deploying(id, results = {}, step: 'success', status: 'completed', head_sha: sha)
    jobs = [ job('Gate', 'success') ] + deploy_jobs.map do |name|
      steps = name == 'Deploy (VPN + Kamal)' ? [ { name: 'Deploy or roll back', conclusion: step } ] : []
      job(name, results.fetch(name) { 'success' }, steps)
    end
    view(id, jobs + [ job('Report', results.fetch('Report') { 'success' }) ], status: status, head_sha: head_sha)
  end

  def ci(conclusion, status: 'completed')
    [ { status: status, conclusion: conclusion } ].to_json
  end

  def runs(*ids)
    ids.map { |id| { databaseId: id } }.to_json
  end

  # Yields the output, the exit status and the gh call log.
  def wait(*args, files: {}, env: {})
    Dir.mktmpdir do |root|
      write_executable(File.join(root, 'gh'), gh_shim)
      {
        'list-rails-test.yml' => ci('success'), 'list-rails-lint.yml' => ci('success'),
        'list-dev-deploy.yml' => '[]', 'main' => { sha: sha }.to_json
      }.merge(files).each { |name, content| File.write(File.join(root, name), content) }
      full_env = {
        'PATH' => "#{root}:#{ENV.fetch('PATH')}", 'SANDBOX' => root,
        'WAIT_DEV_DEPLOY_INTERVAL' => '0', 'WAIT_DEV_DEPLOY_GRACE' => '0', 'WAIT_DEV_DEPLOY_TIMEOUT' => '30'
      }.merge(env)
      output, status = Open3.capture2e(full_env, Rails.root.join('bin/wait-dev-deploy').to_s, *args)
      yield output, status, sandbox_log(root, 'gh.log')
    end
  end

  it 'succeeds once the deploying run deployed, ignoring the gate-only run of the other trigger' do
    files = {
      'list-dev-deploy.yml' => runs(11, 12), 'view-11' => gate_only(11),
      'view-12.1' => deploying(12, { 'Deploy (VPN + Kamal)' => '', 'Report' => '' }, step: '', status: 'in_progress'),
      'view-12' => deploying(12)
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to include("==> Dev Deploy deployed sha-#{sha}: #{url(12)}")
      expect(gh_log).to include("run list --workflow dev-deploy.yml --commit #{sha} --event workflow_run")
      expect(gh_log.scan('run view 12').size).to eq(2)
      expect(gh_log).not_to include('workflow run')
    end
  end

  it 'fails naming the first failed job and the run' do
    files = { 'list-dev-deploy.yml' => runs(12), 'view-12' => deploying(12, { 'Build once (ECR)' => 'failure', 'Deploy (VPN + Kamal)' => 'skipped' }) }

    wait(sha, files: files) do |output, status|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('Build once (ECR)', url(12))
    end
  end

  it 'fails as superseded when the deploy step was skipped for a newer main commit' do
    files = { 'list-dev-deploy.yml' => runs(12), 'view-12' => deploying(12, step: 'skipped') }

    wait(sha, files: files) do |output, status|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('superseded', url(12))
    end
  end

  { 'Rails Tests' => 'list-rails-test.yml', 'Rails CI' => 'list-rails-lint.yml' }.each do |workflow, fixture|
    it "fails without dispatching when #{workflow} did not succeed" do
      wait(sha, files: { fixture => ci('failure') }) do |output, status, gh_log|
        expect(status.exitstatus).to eq(1), output
        expect(output).to include(workflow)
        expect(gh_log).to include("run list --workflow #{fixture.delete_prefix('list-')} --commit #{sha} --event push")
        expect(gh_log).not_to include('workflow run')
      end
    end
  end

  it 'dispatches Dev Deploy once, with a warning, when the automatic trigger did not deploy' do
    files = {
      'list-dev-deploy.yml' => runs(11), 'view-11' => gate_only(11),
      'dispatch' => "#{url(99)}\n", 'view-99.1' => deploying(99, { 'Report' => '' }, step: '', status: 'in_progress'),
      'view-99' => deploying(99)
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to match(/^warning: .*automatic trigger did not deploy/)
      expect(output).to include("==> Dev Deploy deployed sha-#{sha}: #{url(99)}")
      expect(gh_log.scan('workflow run dev-deploy.yml --ref main -f action=deploy').size).to eq(1)
      expect(gh_log.lines.grep(/workflow run/).size).to eq(1)
    end
  end

  it 'dispatches when no Dev Deploy run exists for the commit at all' do
    wait(sha, files: { 'dispatch' => "#{url(99)}\n", 'view-99' => deploying(99) }) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(gh_log).to include('workflow run dev-deploy.yml --ref main -f action=deploy')
    end
  end

  it 'fails when the dispatched run deployed a different commit' do
    files = { 'dispatch' => "#{url(99)}\n", 'view-99' => deploying(99, head_sha: 'c' * 40) }

    wait(sha, files: files) do |output, status|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('c' * 40)
    end
  end

  it 'fails when the dispatch prints no run URL' do
    wait(sha, files: { 'dispatch' => "\n" }) do |output, status|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('no run URL')
    end
  end

  it "shows gh's own error when the dispatch fails" do
    wait('--rollback') do |output, status|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('gh workflow run failed', 'gh shim: no fixture dispatch')
    end
  end

  it 'does not dispatch when main has moved past the commit' do
    wait(sha, files: { 'main' => { sha: 'c' * 40 }.to_json }) do |output, status, gh_log|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('superseded by a newer main commit')
      expect(gh_log).not_to include('workflow run')
    end
  end

  it 'times out while the deploying run is still in progress' do
    files = { 'list-dev-deploy.yml' => runs(12), 'view-12' => deploying(12, { 'Report' => '' }, step: '', status: 'in_progress') }

    wait(sha, files: files, env: { 'WAIT_DEV_DEPLOY_TIMEOUT' => '0' }) do |output, status, gh_log|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('timed out', url(12))
      expect(gh_log).not_to include('workflow run')
    end
  end

  it 'rolls back through Dev Deploy and waits for that run' do
    files = { 'dispatch' => "#{url(77)}\n", 'view-77' => deploying(77, { 'Build once (ECR)' => 'skipped' }, head_sha: 'c' * 40) }

    wait('--rollback', files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to include("==> Dev Deploy rolled back: #{url(77)}")
      expect(gh_log).to include('workflow run dev-deploy.yml --ref main -f action=rollback')
      expect(gh_log).not_to include('action=deploy')
    end
  end

  it 'fails when the rollback run failed' do
    files = { 'dispatch' => "#{url(77)}\n", 'view-77' => deploying(77, { 'Build once (ECR)' => 'skipped', 'Deploy (VPN + Kamal)' => 'failure' }, step: 'failure') }

    wait('--rollback', files: files) do |output, status|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('Deploy (VPN + Kamal)', url(77))
    end
  end

  [ 'abc', 'B' * 40, "#{'b' * 40}x" ].each do |bad|
    it "rejects the malformed sha #{bad.inspect}" do
      wait(bad) do |output, status, gh_log|
        expect(status.exitstatus).to eq(2), output
        expect(gh_log).to be_empty
      end
    end
  end

  it 'reads only job and step names that exist in dev-deploy.yml' do
    jobs = YAML.load_file(Rails.root.join('.github/workflows/dev-deploy.yml')).fetch('jobs').values
    deploy = jobs.find { |candidate| candidate['name'] == 'Deploy (VPN + Kamal)' }

    expect(jobs.map { |candidate| candidate['name'] }).to include(*deploy_jobs, 'Report')
    expect(deploy.fetch('steps').map { |step| step['name'] }).to include('Deploy or roll back')
  end
end
