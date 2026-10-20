require 'rails_helper'

RSpec.describe '.github/workflows/dev-deploy.yml' do
  let(:jobs) { YAML.load_file(Rails.root.join('.github/workflows/dev-deploy.yml')).fetch('jobs') }

  let(:kamal_secrets) do
    output, status = Open3.capture2e('bash', '-c', 'source deploy/_common.sh && secret_names .kamal/secrets.dev', chdir: Rails.root)
    expect(status).to be_success
    output.split - %w[PROJECT_NAME KAMAL_REGISTRY_PASSWORD]
  end

  def step_env(job, step_name)
    jobs.fetch(job).fetch('steps').find { |step| step['name'] == step_name }.fetch('env')
  end

  # A variable .kamal/secrets.dev reads but a step does not map would reach Kamal as an empty string.
  {
    'preflight' => 'Check that every required secret is set',
    'deploy' => 'Deploy or roll back'
  }.each do |job, step_name|
    it "maps every secret .kamal/secrets.dev reads into the #{job} job" do
      env = step_env(job, step_name)

      expect(kamal_secrets).not_to be_empty
      kamal_secrets.each { |name| expect(env[name]).to eq("${{ secrets.#{name} }}") }
    end
  end

  def triggers(file)
    YAML.load_file(Rails.root.join('.github/workflows', file)).transform_keys { |key| key == true ? 'on' : key }.fetch('on')
  end

  it 'deploys pushes to develop and hotfix branches, never main' do
    expect(triggers('dev-deploy.yml').fetch('workflow_run')).to include(
      'workflows' => [ 'Rails Tests', 'Rails CI' ], 'branches' => [ 'develop', 'hotfix/*' ]
    )
  end

  it 'runs Rails Tests and Rails CI on pushes to every branch Dev Deploy follows' do
    %w[rails-test.yml rails-lint.yml].each do |file|
      expect(triggers(file).fetch('push').fetch('branches')).to include('main', 'develop', 'hotfix/*'), file
    end
    expect(triggers('rails-test.yml').fetch('pull_request').fetch('branches')).to include('main', 'develop')
  end

  describe 'the superseded check' do
    let(:step) do
      jobs.fetch('deploy').fetch('steps').find { |candidate| candidate['name'] == 'Check that the commit is still the head of its branch' } ||
        raise('no superseded check in job deploy')
    end

    # Answers from the ref fixture; a ref.fail fixture makes the call fail with its text as gh's error, a 404 (a
    # deleted branch) when it is empty.
    let(:gh_shim) do
      <<~'SH'
        #!/usr/bin/env bash
        echo "$*" >> "$SANDBOX/gh.log"
        if [[ -e "$SANDBOX/ref.fail" ]]; then
          if [[ -s "$SANDBOX/ref.fail" ]]; then cat "$SANDBOX/ref.fail" >&2; else echo 'gh: Not Found (HTTP 404)' >&2; fi
          exit 1
        fi
        cat "$SANDBOX/ref"
      SH
    end

    # Runs the step's script the way Actions does (bash -e); yields its output, GITHUB_OUTPUT and the gh call log.
    def superseded_check(branch:, files:, succeeds: true)
      Dir.mktmpdir do |root|
        write_executable(File.join(root, 'gh'), gh_shim)
        files.each { |name, content| File.write(File.join(root, name), content) }
        github_output = File.join(root, 'github_output')
        File.write(github_output, '')
        env = {
          'PATH' => "#{root}:#{ENV.fetch('PATH')}", 'SANDBOX' => root, 'GITHUB_OUTPUT' => github_output,
          'GITHUB_REPOSITORY' => 'owner/repo', 'SHA' => 'a' * 40, 'BRANCH' => branch
        }
        output, status = Open3.capture2e(env, 'bash', '-e', '-c', step.fetch('run'))
        expect(status.success?).to be(succeeds), output
        yield output, File.read(github_output), sandbox_log(root, 'gh.log')
      end
    end

    it 'reads the branch that triggered the run' do
      expect(step.fetch('env')).to include('BRANCH' => '${{ github.event.workflow_run.head_branch }}')
    end

    it 'deploys when the commit is still the head of its branch' do
      superseded_check(branch: 'develop', files: { 'ref' => "#{'a' * 40}\n" }) do |_output, github_output, gh_log|
        expect(github_output).not_to include('skip=true')
        expect(gh_log).to include('api repos/owner/repo/git/ref/heads/develop')
      end
    end

    it 'skips when the branch has a newer head' do
      superseded_check(branch: 'develop', files: { 'ref' => "#{'b' * 40}\n" }) do |output, github_output|
        expect(github_output).to include('skip=true')
        expect(output).to include("superseded: develop is now #{'b' * 40}")
      end
    end

    it 'skips when the branch is gone, as a merged hotfix branch is' do
      superseded_check(branch: 'hotfix/APP-1-x', files: { 'ref.fail' => '' }) do |output, github_output|
        expect(github_output).to include('skip=true')
        expect(output).to include('branch hotfix/APP-1-x no longer exists')
      end
    end

    {
      'GitHub is down' => 'gh: Server Error (HTTP 502)',
      'the token is refused or rate limited' => 'gh: API rate limit exceeded (HTTP 403)'
    }.each do |reason, error|
      it "fails, without skipping, when #{reason}" do
        superseded_check(branch: 'develop', files: { 'ref.fail' => "#{error}\n" }, succeeds: false) do |output, github_output|
          expect(github_output).not_to include('skip=true')
          expect(output).to include(error)
          expect(output).not_to include('no longer exists')
        end
      end
    end

    it 'keeps the slash of a hotfix branch in the ref it asks for' do
      superseded_check(branch: 'hotfix/APP-1-x', files: { 'ref' => "#{'a' * 40}\n" }) do |_output, github_output, gh_log|
        expect(github_output).not_to include('skip=true')
        expect(gh_log).to include('api repos/owner/repo/git/ref/heads/hotfix/APP-1-x')
      end
    end
  end
end
