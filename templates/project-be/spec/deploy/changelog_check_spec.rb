require 'rails_helper'

RSpec.describe 'bin/changelog-check' do
  let(:template) do
    <<~MD
      # Changelog

      ## [Unreleased]

      ### Added

      ### Changed

      ### Deprecated

      ### Removed

      ### Fixed

      ### Security
    MD
  end

  around do |example|
    in_git_repo do
      @base = commit('chore: start', 'CHANGELOG.md' => template)
      git('switch', '-q', '-c', 'feature/APP-1-x')
      example.run
    end
  end

  def with_entry(category, entry, text = template)
    text.sub("### #{category}\n", "### #{category}\n\n- #{entry}\n")
  end

  def check(type:, labels: [], head_ref: 'feature/APP-1-x', base_ref: 'develop', base: @base)
    env = {
      'BASE_SHA' => base, 'HEAD_SHA' => git('rev-parse', 'HEAD'), 'HEAD_REF' => head_ref, 'BASE_REF' => base_ref,
      'PR_BODY' => "Summary.\r\n\r\nType: #{type}\r\n", 'PR_LABELS' => labels.to_json
    }
    run_in_repo('bin/changelog-check', env: env)
  end

  it 'fails a Type: feat pull request that leaves [Unreleased] unchanged, naming the fix' do
    commit('feat(x): code', 'app/a.rb' => "a\n")

    output, status = check(type: 'feat')
    expect(status.exitstatus).to eq(1)
    expect(output).to include('::error::', 'Type: feat', 'does not change [Unreleased]', 'skip-changelog')
  end

  it 'fails a Type: fix pull request that changes CHANGELOG.md outside [Unreleased] only' do
    commit('fix(x): code', 'app/a.rb' => "a\n", 'CHANGELOG.md' => template.sub('# Changelog', '# Changelog of x'))

    _output, status = check(type: 'fix')
    expect(status.exitstatus).to eq(1)
  end

  it 'passes the same pull request with the label skip-changelog' do
    commit('feat(x): code', 'app/a.rb' => "a\n")

    output, status = check(type: 'feat', labels: %w[bug skip-changelog])
    expect(status).to be_success, output
    expect(output).to include('skip-changelog')
  end

  it 'passes a Type: fix pull request with an entry under [Unreleased]' do
    commit('fix(x): code', 'app/a.rb' => "a\n", 'CHANGELOG.md' => with_entry('Fixed', 'A bug.'))

    output, status = check(type: 'fix')
    expect(status).to be_success, output
  end

  it 'does not require an entry for chore, docs, ci, refactor and test' do
    commit('chore(x): tidy', 'app/a.rb' => "a\n")

    %w[chore docs ci refactor test].each do |type|
      output, status = check(type: type)
      expect(status).to be_success, "#{type}: #{output}"
    end
  end

  it 'leaves a missing or repeated Type: line to pr-conventions-check' do
    commit('feat(x): code', 'app/a.rb' => "a\n")
    env = { 'BASE_SHA' => @base, 'HEAD_SHA' => git('rev-parse', 'HEAD'), 'HEAD_REF' => 'feature/APP-1-x',
            'BASE_REF' => 'develop', 'PR_LABELS' => '[]' }

    [ 'No type.', "Type: feat\nType: fix" ].each do |body|
      output, status = run_in_repo('bin/changelog-check', env: env.merge('PR_BODY' => body))
      expect(status).to be_success, output
      expect(output).to include('pr-conventions-check')
    end
  end

  it 'passes the release pull request develop into main' do
    commit('feat(x): code', 'app/a.rb' => "a\n")

    output, status = check(type: 'feat', head_ref: 'develop', base_ref: 'main')
    expect(status).to be_success, output
  end

  it 'passes a hotfix that adds a new version section directly' do
    hotfixed = template.sub("### Security\n", "### Security\n\n## [0.1.1] - 2026-10-20\n\n### Fixed\n\n- A bug.\n")
    commit('fix(x): hotfix', 'app/a.rb' => "a\n", 'CHANGELOG.md' => hotfixed)

    output, status = check(type: 'fix', head_ref: 'hotfix/APP-2-x', base_ref: 'main')
    expect(status).to be_success, output
  end

  it 'passes a feat pull request that creates CHANGELOG.md with an entry' do
    git('switch', '-q', '--orphan', 'empty')
    base = commit('chore: nothing yet', 'README.md' => "r\n")
    commit('feat(x): code', 'app/a.rb' => "a\n", 'CHANGELOG.md' => with_entry('Added', 'A feature.'))

    output, status = check(type: 'feat', base: base)
    expect(status).to be_success, output
  end

  it 'compares with the merge base, so an entry added to the base branch later does not count' do
    commit('feat(x): code', 'app/a.rb' => "a\n")
    git('switch', '-q', 'main')
    moved = commit('feat(y): elsewhere', 'CHANGELOG.md' => with_entry('Added', 'Another feature.'))
    git('switch', '-q', 'feature/APP-1-x')

    _output, status = check(type: 'feat', base: moved)
    expect(status.exitstatus).to eq(1)
  end
end

RSpec.describe '.github/workflows/changelog-check.yml' do
  let(:workflow) do
    YAML.load_file(Rails.root.join('.github/workflows/changelog-check.yml')).transform_keys { |key| key == true ? 'on' : key }
  end
  let(:job) { workflow.fetch('jobs').values.first }
  let(:check) { job.fetch('steps').find { |step| step['run'].to_s.include?('bin/changelog-check') } }

  it 'runs on pull requests into develop and main, also when labels or the body change' do
    trigger = workflow.fetch('on').fetch('pull_request')
    expect(trigger.fetch('branches')).to contain_exactly('develop', 'main')
    expect(trigger.fetch('types')).to include('opened', 'synchronize', 'edited', 'labeled', 'unlabeled', 'reopened')
  end

  it 'is one short job with read-only permissions on the shared runner' do
    expect(workflow.fetch('jobs').size).to eq(1)
    expect(workflow.fetch('permissions')).to eq('contents' => 'read')
    expect(job.fetch('timeout-minutes')).to be <= 5
    expect(job.fetch('runs-on')).to eq("${{ vars.RUNS_ON || 'ubuntu-latest' }}")
  end

  it 'checks out the head with full history and passes the untrusted body and labels only through env' do
    checkout = job.fetch('steps').find { |step| step['uses'].to_s.start_with?('actions/checkout@') }
    expect(checkout.fetch('with')).to include('fetch-depth' => 0, 'ref' => '${{ github.event.pull_request.head.sha }}')
    expect(check.fetch('run')).to eq('bin/changelog-check')
    expect(check.fetch('env')).to include(
      'PR_BODY' => '${{ github.event.pull_request.body }}',
      'PR_LABELS' => '${{ toJSON(github.event.pull_request.labels.*.name) }}',
      'BASE_SHA' => '${{ github.event.pull_request.base.sha }}',
      'HEAD_SHA' => '${{ github.event.pull_request.head.sha }}',
      'HEAD_REF' => '${{ github.event.pull_request.head.ref }}',
      'BASE_REF' => '${{ github.event.pull_request.base.ref }}'
    )
  end
end
