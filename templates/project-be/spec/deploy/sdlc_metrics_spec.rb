require 'rails_helper'

RSpec.describe 'bin/sdlc-metrics' do
  # Answers `gh api <path> --jq <expr>` from <path with / as _>.json in GH_DIR, like the real gh.
  let(:gh_shim) do
    <<~'SH'
      #!/usr/bin/env bash
      echo "$*" >> "$GH_DIR/gh.log"
      path='' expr='.'
      while (( $# )); do
        case "$1" in
          api) ;;
          --jq) expr="$2"; shift ;;
          -*) ;;
          *) [[ -n "$path" ]] || path="$1" ;;
        esac
        shift
      done
      file="$GH_DIR/$(tr '/' '_' <<< "${path%%\?*}").json"
      [[ -e "$file" ]] || { echo 'gh: Not Found (HTTP 404)' >&2; exit 1; }
      jq -r "$expr" "$file"
    SH
  end

  let(:runs) do
    [
      { conclusion: 'success', created_at: '2026-10-05T08:00:00Z', display_title: 'Kamal Manage rollback' },
      { conclusion: 'failure', created_at: '2026-10-05T09:00:00Z', display_title: 'Kamal Manage rollback' },
      { conclusion: 'success', created_at: '2026-10-06T08:00:00Z', display_title: 'Kamal Manage restart' },
      { conclusion: 'success', created_at: '2026-08-01T08:00:00Z', display_title: 'Kamal Manage rollback' }
    ]
  end

  around do |example|
    in_git_repo do
      Dir.mktmpdir do |gh_dir|
        @gh_dir = gh_dir
        write_executable(File.join(gh_dir, 'gh'), gh_shim)
        {
          'repos_owner_repo_pulls_2' => { created_at: '2026-10-01T00:00:00Z', merged_at: '2026-10-02T00:00:00Z', user: { login: 'someone' } },
          'repos_owner_repo_pulls_3' => { created_at: '2026-10-05T00:00:00Z', merged_at: '2026-10-05T12:00:00Z', user: { login: 'someone' } },
          'repos_owner_repo_actions_workflows_kamal-manage.yml_runs' => { workflow_runs: runs }
        }.each { |file, json| File.write(File.join(gh_dir, "#{file}.json"), json.to_json) }
        build_history
        example.run
      end
    end
  end

  def build_history
    commit("Bootstrap\n", { 'docs/old.md' => "---\nstatus: Draft\n---\n# Old\n", 'docs/approved.md' => "---\nstatus: Approved\n---\n" },
           date: '2026-09-01T10:00:00Z')
    annotated_tag('v0.1.0', date: '2026-09-01T12:00:00Z')
    squash('APP-2: a feature (#2)', 'feat', date: '2026-10-02T00:00:00Z')
    squash('APP-3: a fix (#3)', 'fix', { 'docs/recent.md' => "---\nstatus: Draft\n---\n" }, date: '2026-10-05T12:00:00Z')
    annotated_tag('v0.2.0', date: '2026-10-10T12:00:00Z')
  end

  def write_run(dir, name, report:, findings: nil, mtime:)
    run = File.join(dir, name)
    FileUtils.mkdir_p(File.join(run, 'review'))
    File.write(File.join(run, 'report.json'), report.to_json)
    File.write(File.join(run, 'review', 'findings.json'), findings.map { |s| { severity: s } }.to_json) if findings
    File.utime(Time.iso8601(mtime), Time.iso8601(mtime), File.join(run, 'report.json'))
  end

  def metrics(*args, env: {})
    full_env = { 'PATH' => "#{@gh_dir}:#{ENV.fetch('PATH')}", 'GH_DIR' => @gh_dir, 'GH_REPO' => 'owner/repo',
                 'GITHUB_STEP_SUMMARY' => nil }.merge(env)
    run_in_repo3('bin/sdlc-metrics', *args, env: full_env)
  end

  it 'prints one line of team metrics for the release, from PR dates, rollbacks, runs and drafts' do
    Dir.mktmpdir do |runs_dir|
      write_run(runs_dir, 'a', report: { delivered: true }, findings: %w[Critical Important Minor], mtime: '2026-10-03T00:00:00Z')
      write_run(runs_dir, 'b', report: { delivered: false }, mtime: '2026-10-04T00:00:00Z')
      write_run(runs_dir, 'c', report: { delivered: false }, findings: %w[Critical], mtime: '2026-08-01T00:00:00Z')

      stdout, stderr, status = metrics('v0.2.0', '--runs', runs_dir)
      expect(status).to be_success, stderr
      expect(stdout).to eq(
        'sdlc-metrics v0.2.0 date=2026-10-10 prev=v0.1.0 prs=2 lead_time_h=228 pr_lead_median_h=18 ' \
        "prod_rollbacks=1 delivered_false=1/2 findings=P0:1,P1:1,P2:1 stale_drafts=1\n"
      )
    end
  end

  it 'reports n/a for the factory figures without --runs' do
    stdout, stderr, status = metrics('v0.2.0')
    expect(status).to be_success, stderr
    expect(stdout).to include('delivered_false=n/a findings=n/a')
  end

  it 'never names a person' do
    stdout, = metrics('v0.2.0')
    expect(stdout).not_to include('someone', 'Spec', 'spec@example.com', 'author', 'login')
  end

  it 'appends the line to the job summary when there is one' do
    Tempfile.create('summary') do |summary|
      stdout, = metrics('v0.2.0', env: { 'GITHUB_STEP_SUMMARY' => summary.path })
      expect(File.read(summary.path)).to include(stdout.strip)
    end
  end

  it 'covers everything before the first release tag' do
    stdout, stderr, status = metrics('v0.1.0')
    expect(status).to be_success, stderr
    expect(stdout).to start_with('sdlc-metrics v0.1.0 date=2026-09-01 prev=none prs=0 ')
    expect(stdout).to include('prod_rollbacks=1')
  end

  it 'fails for a tag that does not exist' do
    _stdout, _stderr, status = metrics('v9.9.9')
    expect(status.exitstatus).to eq(1)
  end

  describe 'a failed query' do
    it 'fails instead of counting no rollbacks when the Actions runs cannot be read' do
      File.delete(File.join(@gh_dir, 'repos_owner_repo_actions_workflows_kamal-manage.yml_runs.json'))
      stdout, stderr, status = metrics('v0.2.0')
      expect(status.exitstatus).to eq(1)
      expect(stdout).to be_empty
      expect(stderr).to include('error:')
    end

    it 'fails instead of counting no pull requests when the release history cannot be read' do
      real_git = ENV.fetch('PATH').split(':').map { |dir| File.join(dir, 'git') }.find { |path| File.executable?(path) }
      write_executable(File.join(@gh_dir, 'git'), <<~SH)
        #!/usr/bin/env bash
        [[ "$1" == log && "$2" == --no-merges ]] && { echo 'fatal: simulated failure' >&2; exit 128; }
        exec #{real_git} "$@"
      SH
      stdout, stderr, status = metrics('v0.2.0')
      expect(status.exitstatus).to eq(1)
      expect(stdout).to be_empty
      expect(stderr).to include('error:')
    end

    it "fails instead of dropping a run's findings when they cannot be read" do
      Dir.mktmpdir do |runs_dir|
        write_run(runs_dir, 'a', report: { delivered: true }, findings: %w[Critical], mtime: '2026-10-03T00:00:00Z')
        File.write(File.join(runs_dir, 'a', 'review', 'findings.json'), '{ not json')
        stdout, stderr, status = metrics('v0.2.0', '--runs', runs_dir)
        expect(status.exitstatus).to eq(1)
        expect(stdout).to be_empty
        expect(stderr).to include('error:')
      end
    end
  end

  describe '--escaped' do
    it 'refuses to count before seven days have passed since the tag' do
      annotated_tag('v0.3.0')
      _stdout, stderr, status = metrics('--escaped', 'v0.3.0')
      expect(status.exitstatus).to eq(2)
      expect(stderr).to include('7 days')
    end

    it 'counts the GlitchTip issues first seen in the seven days after the tag' do
      Dir.mktmpdir do |sandbox|
        write_executable(File.join(@gh_dir, 'curl'), DeploySandbox::SHIMS.fetch('curl'))
        File.write(File.join(sandbox, 'glitchtip-page1.json'), [
          { id: '1', shortId: 'P-1', title: 'in', firstSeen: '2026-09-02T00:00:00Z' },
          { id: '2', shortId: 'P-2', title: 'in too', firstSeen: '2026-09-08T11:59:59Z' },
          { id: '3', shortId: 'P-3', title: 'later', firstSeen: '2026-09-08T12:00:00Z' },
          { id: '4', shortId: 'P-4', title: 'earlier', firstSeen: '2026-09-01T11:00:00Z' }
        ].to_json)
        env = { 'SANDBOX' => sandbox, 'GLITCHTIP_API_TOKEN' => 'token', 'GLITCHTIP_API_URL' => 'https://gt.example.test',
                'SENTRY_DSN' => nil, 'GITHUB_ACTIONS' => nil }

        stdout, stderr, status = metrics('--escaped', 'v0.1.0', env: env)
        expect(status).to be_success, stderr
        expect(stdout).to eq("sdlc-metrics v0.1.0 escaped_defects=2 window=2026-09-01..2026-09-08\n")
      end
    end
  end
end
