require 'rails_helper'

RSpec.describe 'bin/wait-dev-deploy' do
  let(:sha) { 'b' * 40 }

  # Answers every gh call from a fixture file named after it: run list → list-<workflow file>,
  # run view <id> → view-<id>, run view --job <id> --log → log-<id>, api …/compare/<sha>...<run sha>
  # → compare-<run sha>, api …/commits/<branch> → head-<branch>, workflow run → dispatch.
  # <key>.<n>, when it exists, answers the n-th call instead, so a run can change state between polls;
  # <key>.<n>.fail makes the n-th call fail with that file as gh's stderr.
  let(:gh_shim) do
    <<~'SH'
      #!/usr/bin/env bash
      echo "$*" >> "$SANDBOX/gh.log"
      answer() {
        local n
        n=$(( $(cat "$SANDBOX/$1.count" 2>/dev/null || echo 0) + 1 ))
        echo "${n}" > "$SANDBOX/$1.count"
        if [[ -e "$SANDBOX/$1.${n}.fail" ]]; then cat "$SANDBOX/$1.${n}.fail" >&2; exit 1; fi
        if [[ -e "$SANDBOX/$1.${n}" ]]; then cat "$SANDBOX/$1.${n}"
        elif [[ -e "$SANDBOX/$1" ]]; then cat "$SANDBOX/$1"
        else echo "gh shim: no fixture $1" >&2; exit 1
        fi
      }
      case "$1 $2" in
        'run list')
          while [[ $# -gt 0 && "$1" != '--workflow' ]]; do shift; done
          answer "list-$2" ;;
        'run view')
          if [[ "$3" == --job ]]; then answer "log-$4"; else answer "view-$3"; fi ;;
        'workflow run') answer dispatch ;;
        api*)
          case "$2" in
            */compare/*) answer "compare-${2##*...}" ;;
            */commits/*) answer "head-${2##*/commits/}" ;;
            *) echo "gh shim: unexpected $*" >&2; exit 1 ;;
          esac ;;
        *) echo "gh shim: unexpected $*" >&2; exit 1 ;;
      esac
    SH
  end

  # A `date +%s` that advances one second per reading (or the seconds in date.step, when it exists),
  # so the number of polls before a timeout does not depend on wall time.
  let(:clock_shim) do
    <<~'SH'
      #!/usr/bin/env bash
      [[ "$*" == +%s ]] || { echo "date shim: unexpected $*" >&2; exit 1; }
      n=$(( $(cat "$SANDBOX/date.count" 2>/dev/null || echo 0) + 1 ))
      echo "${n}" > "$SANDBOX/date.count"
      echo $(( n * $(cat "$SANDBOX/date.step" 2>/dev/null || echo 1) ))
    SH
  end

  let(:deploy_jobs) { [ 'Preflight (secrets)', 'Probe (shared VPN actions)', 'Build once (ECR)', 'Deploy (VPN + Kamal)' ] }

  def url(id)
    "https://github.com/owner/repo/actions/runs/#{id}"
  end

  def job(name, conclusion, steps = [], id: nil, status: 'completed')
    { name: name, status: status, conclusion: conclusion, steps: steps, databaseId: id }.compact
  end

  def gate(id, status)
    job('Gate', status == 'completed' ? 'success' : '', id: id * 10 + 1, status: status)
  end

  def view(id, jobs, status: 'completed', head_sha: sha, conclusion: status == 'completed' ? 'success' : '')
    { status: status, conclusion: conclusion, url: url(id), headSha: head_sha, jobs: jobs }.to_json
  end

  def gate_only(id, gate_status: 'completed')
    view(id, [ gate(id, gate_status), *(deploy_jobs + [ 'Report', 'Notify (Telegram)' ]).map { |name| job(name, 'skipped') } ])
  end

  # A run the gate let through; `results` overrides job conclusions, `step` is "Deploy or roll back".
  def deploying(id, results = {}, step: 'success', status: 'completed', head_sha: sha, gate_status: 'completed')
    jobs = [ gate(id, gate_status) ] + deploy_jobs.map do |name|
      steps = name == 'Deploy (VPN + Kamal)' ? [ { name: 'Deploy or roll back', conclusion: step } ] : []
      job(name, results.fetch(name) { 'success' }, steps)
    end
    view(id, jobs + [ job('Report', results.fetch('Report') { 'success' }) ], status: status, head_sha: head_sha)
  end

  def ci(conclusion, status: 'completed', branch: 'develop')
    [ { status: status, conclusion: conclusion, headBranch: branch } ].to_json
  end

  # The title dev-deploy.yml's run-name gives a workflow_run run of the commit run_sha.
  def workflow_run_title(run_sha)
    run_name = YAML.load_file(Rails.root.join('.github/workflows/dev-deploy.yml')).fetch('run-name')
    format = run_name[/format\('([^']*)', github\.event\.workflow_run\.head_sha\)/, 1]
    raise "no workflow_run title in run-name: #{run_name}" unless format

    format.sub('{0}', run_sha)
  end

  def row(id, run_sha = sha, title: workflow_run_title(run_sha))
    { databaseId: id, displayTitle: title }
  end

  # An Integer is a run titled with the commit under test.
  def runs(*rows)
    rows.map { |run| run.is_a?(Integer) ? row(run) : run }.to_json
  end

  # Yields the output, the exit status and the gh call log.
  def wait(*args, files: {}, env: {})
    Dir.mktmpdir do |root|
      write_executable(File.join(root, 'gh'), gh_shim)
      write_executable(File.join(root, 'date'), clock_shim)
      {
        'list-rails-test.yml' => ci('success'), 'list-rails-lint.yml' => ci('success'),
        'list-dev-deploy.yml' => '[]', 'head-develop' => { sha: sha }.to_json
      }.merge(files).each { |name, content| File.write(File.join(root, name), content) }
      full_env = {
        'PATH' => "#{root}:#{ENV.fetch('PATH')}", 'SANDBOX' => root,
        'WAIT_DEV_DEPLOY_INTERVAL' => '0', 'WAIT_DEV_DEPLOY_GRACE' => '0', 'WAIT_DEV_DEPLOY_TIMEOUT' => '30',
        'WAIT_DEV_DEPLOY_RETRY_SECONDS' => '0'
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
      expect(gh_log).to include('run list --workflow dev-deploy.yml --event workflow_run')
      expect(gh_log).not_to match(/run list --workflow dev-deploy.yml --commit/)
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

  it 'names the failed job and the run once a duplicate run of the commit it waited for finished' do
    files = {
      'list-dev-deploy.yml' => runs(12, 11),
      'view-12' => deploying(12, { 'Build once (ECR)' => 'failure', 'Deploy (VPN + Kamal)' => 'skipped' }),
      'view-11.1' => view(11, [ gate(11, 'in_progress') ], status: 'in_progress'), 'view-11' => gate_only(11)
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include("error: Dev Deploy failed in Build once (ECR): #{url(12)}\n")
      expect(gh_log.scan('run view 12').size).to eq(1)
    end
  end

  it 'reads an unreadable Gate log of another run again on the next poll instead of failing' do
    files = {
      'list-dev-deploy.yml' => runs(12, row(10, title: 'Dev Deploy')),
      'view-12.1' => deploying(12, { 'Deploy (VPN + Kamal)' => '', 'Report' => '' }, step: '', status: 'in_progress'),
      'view-12' => deploying(12), 'view-10' => deploying(10, head_sha: 'a' * 40),
      'log-101.1.fail' => "failed to get run log: log not found\n"
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to include("==> Dev Deploy deployed sha-#{sha}: #{url(12)}")
      expect(gh_log.scan('run view --job 101 --log').size).to eq(1)
    end
  end

  it 'succeeds for a workflow_run run that GitHub reports on main when its title names the commit' do
    files = { 'list-dev-deploy.yml' => runs(12), 'view-12' => deploying(12, head_sha: 'c' * 40) }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to include("==> Dev Deploy deployed sha-#{sha}: #{url(12)}")
      expect(gh_log).not_to include('workflow run')
    end
  end

  it 'matches a run titled only "Dev Deploy" by the HEAD_SHA in its Gate log' do
    running = { 'Deploy (VPN + Kamal)' => '', 'Report' => '' }
    files = {
      'list-dev-deploy.yml' => runs(row(12, title: 'Dev Deploy')),
      'view-12.1' => deploying(12, running, step: '', status: 'in_progress', head_sha: 'c' * 40, gate_status: 'in_progress'),
      'view-12.2' => deploying(12, running, step: '', status: 'in_progress', head_sha: 'c' * 40),
      'view-12' => deploying(12, head_sha: 'c' * 40),
      'log-121' => "Gate\tDecide whether to deploy\t2026-10-20T10:31:19.2434883Z   HEAD_SHA: #{sha}\n"
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to include("==> Dev Deploy deployed sha-#{sha}: #{url(12)}")
      expect(gh_log.scan('run view --job 121 --log').size).to eq(1)
      expect(gh_log).not_to include('workflow run')
    end
  end

  context 'with a run titled only "Dev Deploy" whose Gate completed' do
    let(:running) { deploying(12, { 'Deploy (VPN + Kamal)' => '', 'Report' => '' }, step: '', status: 'in_progress', head_sha: 'c' * 40) }
    let(:gate_files) do
      {
        'list-dev-deploy.yml' => runs(row(12, title: 'Dev Deploy')),
        'log-121' => "Gate\tDecide whether to deploy\t2026-10-20T10:31:19.2434883Z   HEAD_SHA: #{sha}\n"
      }
    end

    it 'keeps polling the run while it is running without reading any log' do
      files = gate_files.merge('view-12' => running)

      # The clock reads 1 for the deadline (4) and 2, 3, 4 after each poll, so the third poll times out.
      wait(sha, files: files, env: { 'WAIT_DEV_DEPLOY_TIMEOUT' => '3' }) do |output, status, gh_log|
        expect(status.exitstatus).to eq(1), output
        expect(output).to include('timed out', url(12), 'commit not known yet')
        expect(gh_log.scan('run view 12 --json').size).to eq(3)
        expect(gh_log).not_to include('--log')
        expect(gh_log).not_to include('workflow run')
      end
    end

    it 'reads the Gate log only once the run completed, and succeeds when it deployed' do
      files = gate_files.merge('view-12.1' => running, 'view-12.2' => running, 'view-12' => deploying(12, head_sha: 'c' * 40))

      wait(sha, files: files) do |output, status, gh_log|
        expect(status).to be_success, output
        expect(output).to include("==> Dev Deploy deployed sha-#{sha}: #{url(12)}")
        expect(gh_log.scan('run view 12 --json').size).to eq(3)
        expect(gh_log.scan('run view --job 121 --log').size).to eq(1)
        expect(gh_log.lines.last).to include('run view --job 121 --log')
      end
    end

    it 'fails with the failed job once the run completed with a failure' do
      failed = deploying(12, { 'Deploy (VPN + Kamal)' => 'failure' }, step: 'failure', head_sha: 'c' * 40)
      files = gate_files.merge('view-12.1' => running, 'view-12' => failed)

      wait(sha, files: files) do |output, status, gh_log|
        expect(status.exitstatus).to eq(1), output
        expect(output).to include('Dev Deploy failed in Deploy (VPN + Kamal)', url(12))
        expect(gh_log.scan('run view --job 121 --log').size).to eq(1)
        expect(gh_log.lines.last).to include('run view --job 121 --log')
      end
    end
  end

  it 'keeps waiting past its run whose deploy step was skipped and succeeds when a later run for the commit deploys' do
    files = {
      'list-dev-deploy.yml.1' => runs(12), 'list-dev-deploy.yml' => runs(13, 12),
      'view-12' => deploying(12, step: 'skipped'), 'view-13' => deploying(13),
      'head-develop' => { sha: 'c' * 40 }.to_json
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to include("==> Dev Deploy deployed sha-#{sha}: #{url(13)}")
      expect(output).not_to include('superseded')
      expect(gh_log).not_to include('workflow run')
    end
  end

  it 'succeeds when its own run was superseded and a newer run deployed a commit that contains it' do
    files = {
      'list-dev-deploy.yml' => runs(row(13, 'c' * 40), 12),
      'view-13' => deploying(13, head_sha: 'c' * 40), 'view-12' => deploying(12, step: 'skipped'),
      "compare-#{'c' * 40}" => { status: 'ahead' }.to_json
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to include("==> Dev Deploy deployed sha-#{sha} via #{'c' * 40}, a newer commit that contains it: #{url(13)}")
      expect(output).not_to include('superseded')
      expect(gh_log).not_to include('workflow run')
    end
  end

  it 'succeeds via a newer commit when its own run was cancelled' do
    cancelled = view(12, [
      gate(12, 'completed'), *deploy_jobs[0..2].map { |name| job(name, 'success') },
      job('Deploy (VPN + Kamal)', 'cancelled', [ { name: 'Deploy or roll back', conclusion: '' } ]), job('Report', 'success')
    ], conclusion: 'cancelled')
    files = {
      'list-dev-deploy.yml' => runs(row(13, 'c' * 40), 12),
      'view-13' => deploying(13, head_sha: 'c' * 40), 'view-12' => cancelled,
      "compare-#{'c' * 40}" => { status: 'ahead' }.to_json
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to include("==> Dev Deploy deployed sha-#{sha} via #{'c' * 40}, a newer commit that contains it: #{url(13)}")
      expect(gh_log).not_to include('workflow run')
    end
  end

  it 'retries a GitHub 5xx and then succeeds' do
    files = {
      'list-dev-deploy.yml' => runs(12), 'view-12' => deploying(12),
      'list-dev-deploy.yml.1.fail' => "HTTP 502: Bad Gateway (https://api.github.com/repos/owner/repo/actions/runs)\n"
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to include("==> Dev Deploy deployed sha-#{sha}: #{url(12)}")
      expect(gh_log.lines.grep(/run list --workflow dev-deploy.yml/).size).to eq(2)
    end
  end

  it 'retries a network error' do
    files = {
      'list-dev-deploy.yml' => runs(12), 'view-12' => deploying(12),
      'view-12.1.fail' => "error connecting to api.github.com\n"
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(gh_log.scan('run view 12 --json').size).to eq(2)
    end
  end

  it 'gives up after 3 tries of a GitHub 5xx' do
    files = { 'list-dev-deploy.yml' => runs(12) }
    (1..3).each { |n| files["view-12.#{n}.fail"] = "HTTP 503: Service Unavailable\n" }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('HTTP 503', '3 tries')
      expect(gh_log.scan('run view 12').size).to eq(3)
    end
  end

  it 'does not retry a non-transient gh error' do
    files = { 'list-dev-deploy.yml.1.fail' => "HTTP 404: Not Found\n" }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('HTTP 404')
      expect(gh_log.lines.grep(/run list --workflow dev-deploy.yml/).size).to eq(1)
    end
  end

  it 'does not retry a failed dispatch' do
    wait(sha, files: { 'dispatch.1.fail' => "HTTP 502: Bad Gateway\n" }) do |output, status, gh_log|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('gh workflow run failed', 'HTTP 502')
      expect(gh_log.lines.grep(/workflow run/).size).to eq(1)
    end
  end

  it 'keeps waiting while a newer run of a commit that contains it deploys, then succeeds' do
    files = {
      'list-dev-deploy.yml' => runs(row(14, 'c' * 40), row(13, 'c' * 40), 12, 11),
      'view-14' => gate_only(14), 'view-11' => gate_only(11), 'view-12' => deploying(12, step: 'skipped'),
      'view-13.1' => deploying(13, { 'Deploy (VPN + Kamal)' => '', 'Report' => '' }, step: '', status: 'in_progress', head_sha: 'c' * 40),
      'view-13' => deploying(13, head_sha: 'c' * 40),
      "compare-#{'c' * 40}" => { status: 'ahead' }.to_json, 'head-develop' => { sha: 'c' * 40 }.to_json
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to include("deployed sha-#{sha} via #{'c' * 40}", url(13))
      expect(gh_log.scan('run view 13 --json').size).to eq(2)
      expect(gh_log).not_to include('workflow run')
    end
  end

  it 'succeeds as soon as the Deploy job deployed, before Report and Notify finished' do
    files = {
      'list-dev-deploy.yml' => runs(12, 11), 'view-11' => gate_only(11),
      'view-12' => deploying(12, { 'Report' => '' }, status: 'in_progress')
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(output).to include("==> Dev Deploy deployed sha-#{sha}: #{url(12)}")
      expect(gh_log.scan('run view 12').size).to eq(1)
    end
  end

  it 'fails on its own failed run even when a newer run deployed a commit that contains it' do
    files = {
      'list-dev-deploy.yml' => runs(row(13, 'c' * 40), 12),
      'view-13' => deploying(13, head_sha: 'c' * 40),
      'view-12' => deploying(12, { 'Deploy (VPN + Kamal)' => 'failure' }, step: 'failure'),
      "compare-#{'c' * 40}" => { status: 'ahead' }.to_json
    }

    wait(sha, files: files) do |output, status|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('Dev Deploy failed in Deploy (VPN + Kamal)', url(12))
      expect(output).not_to include('==>')
    end
  end

  it 'times out after 1440 s by default, inside the factory 1500 s limit on its deploy command' do
    files = { 'date.step' => '1000', 'head-develop' => { sha: 'c' * 40 }.to_json }

    wait(sha, files: files, env: { 'WAIT_DEV_DEPLOY_TIMEOUT' => nil }) do |output, status, gh_log|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('timed out after 1440s')
      expect(gh_log).not_to include('workflow run')
    end
  end

  it 'succeeds when its own run deployed even though a newer run listed first deployed a commit that contains it' do
    files = {
      'list-dev-deploy.yml' => runs(row(13, 'c' * 40), 12),
      'view-13' => deploying(13, head_sha: 'c' * 40), 'view-12' => deploying(12),
      "compare-#{'c' * 40}" => { status: 'ahead' }.to_json
    }

    wait(sha, files: files) do |output, status|
      expect(status).to be_success, output
      expect(output).to include("==> Dev Deploy deployed sha-#{sha}: #{url(12)}")
      expect(output).not_to include('superseded')
    end
  end

  %w[behind identical diverged].each do |compare_status|
    it "does not accept a deployed run whose commit is #{compare_status} against the target" do
      files = {
        'list-dev-deploy.yml' => runs(row(13, 'c' * 40)), 'view-13' => deploying(13, head_sha: 'c' * 40),
        "compare-#{'c' * 40}" => { status: compare_status }.to_json, 'head-develop' => { sha: 'd' * 40 }.to_json
      }

      wait(sha, files: files, env: { 'WAIT_DEV_DEPLOY_TIMEOUT' => '0' }) do |output, status, gh_log|
        expect(status.exitstatus).to eq(1), output
        expect(output).to include('timed out')
        expect(output).not_to include('==>')
        expect(output).not_to include('superseded')
        expect(gh_log).not_to include('workflow run')
      end
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
      expect(gh_log.scan('workflow run dev-deploy.yml --ref develop -f action=deploy').size).to eq(1)
      expect(gh_log.lines.grep(/workflow run/).size).to eq(1)
    end
  end

  it 'dispatches only once the commit has stayed undeployed for the whole grace period' do
    files = { 'list-dev-deploy.yml' => runs(11), 'view-11' => gate_only(11), 'dispatch' => "#{url(99)}\n", 'view-99' => deploying(99) }

    # The clock reads 1 for the deadline; the first quiet poll starts the grace period at 2 and sees 3,
    # the deadline check reads 4, and the second poll sees 5, two seconds after the grace period started.
    wait(sha, files: files, env: { 'WAIT_DEV_DEPLOY_GRACE' => '2' }) do |output, status, gh_log|
      expect(status).to be_success, output
      before_dispatch = gh_log.lines.take_while { |line| !line.include?('workflow run') }
      expect(before_dispatch.grep(/run list --workflow dev-deploy.yml/).size).to eq(2)
      expect(gh_log.lines.grep(/workflow run/).size).to eq(1)
    end
  end

  it 'dispatches when no Dev Deploy run exists for the commit at all' do
    wait(sha, files: { 'dispatch' => "#{url(99)}\n", 'view-99' => deploying(99) }) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(gh_log).to include('workflow run dev-deploy.yml --ref develop -f action=deploy')
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

  it 'dispatches on main for a commit whose CI ran on main' do
    files = {
      'list-rails-test.yml' => ci('success', branch: 'main'), 'head-main' => { sha: sha }.to_json,
      'dispatch' => "#{url(99)}\n", 'view-99' => deploying(99)
    }

    wait(sha, files: files) do |output, status, gh_log|
      expect(status).to be_success, output
      expect(gh_log).to include('workflow run dev-deploy.yml --ref main -f action=deploy')
    end
  end

  it 'does not dispatch, and keeps waiting, while its branch has moved past the commit' do
    files = { 'head-develop' => { sha: 'c' * 40 }.to_json }

    wait(sha, files: files, env: { 'WAIT_DEV_DEPLOY_TIMEOUT' => '0' }) do |output, status, gh_log|
      expect(status.exitstatus).to eq(1), output
      expect(output).to include('timed out')
      expect(output).not_to include('superseded by a newer main commit')
      expect(gh_log).to include('api repos/{owner}/{repo}/commits/develop')
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
    workflow = YAML.load_file(Rails.root.join('.github/workflows/dev-deploy.yml'))
    jobs = workflow.fetch('jobs').values
    deploy = jobs.find { |candidate| candidate['name'] == 'Deploy (VPN + Kamal)' }

    expect(workflow['run-name']).to include("format('Dev Deploy sha-{0}', github.event.workflow_run.head_sha)")
    expect(jobs.map { |candidate| candidate['name'] }).to include('Gate', *deploy_jobs, 'Report')
    expect(deploy.fetch('steps').map { |step| step['name'] }).to include('Deploy or roll back')
  end
end
