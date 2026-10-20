require 'rails_helper'

RSpec.describe 'scripts/next-version.sh' do
  around { |example| in_git_repo { example.run } }

  def next_version(*args)
    run_in_repo3('scripts/next-version.sh', *args)
  end

  def released_v010
    squash('APP-1: start (#1)', 'feat')
    annotated_tag('v0.1.0')
  end

  it 'starts at 0.1.0 when there is no release tag yet, whatever the history' do
    commit('Bootstrap without a Type line')
    squash('APP-1: first (#1)', 'fix')

    stdout, stderr, status = next_version
    expect(status).to be_success, stderr
    expect(stdout).to eq("0.1.0\n")
  end

  it 'bumps MINOR for a Type: feat commit since the previous tag' do
    released_v010
    squash('APP-2: a fix (#2)', 'fix')
    squash('APP-3: a feature (#3)', 'feat')

    stdout, stderr, status = next_version
    expect(status).to be_success, stderr
    expect(stdout).to eq("0.2.0\n")
  end

  it 'bumps PATCH when there are only Type: fix commits (besides chore, docs and the like)' do
    released_v010
    squash('APP-2: a fix (#2)', 'fix')
    squash('APP-3: docs (#3)', 'docs')

    expect(next_version.first).to eq("0.1.1\n")
  end

  it 'bumps MAJOR for a BREAKING CHANGE footer' do
    released_v010
    squash('APP-2: a feature (#2)', 'feat')
    squash('APP-3: new contract (#3)', 'feat', body: "Summary.\n\nBREAKING CHANGE: the old field is gone")

    expect(next_version.first).to eq("1.0.0\n")
  end

  it 'ignores merge commits, which carry no Type: line' do
    released_v010
    git('switch', '-q', '-c', 'side')
    squash('APP-2: a fix (#2)', 'fix')
    git('switch', '-q', 'main')
    squash('APP-3: another fix (#3)', 'fix')
    git('merge', '-q', '--no-ff', '--no-edit', 'side')

    stdout, stderr, status = next_version
    expect(status).to be_success, stderr
    expect(stdout).to eq("0.1.1\n")
  end

  it 'leaves out a tag on the inspected commit itself, so it prints the version that tag should have' do
    released_v010
    squash('APP-2: a feature (#2)', 'feat')
    annotated_tag('v0.2.0')

    expect(next_version('v0.2.0^{commit}').first).to eq("0.2.0\n")
    expect(next_version('--previous', 'v0.2.0^{commit}').first).to eq("v0.1.0\n")
  end

  it 'reads the Type: line of a body with CRLF line ends' do
    released_v010
    commit("APP-2: from an edited body (#2)\r\n\r\nSummary.\r\n\r\nType: feat\r\n")

    expect(next_version.first).to eq("0.2.0\n")
  end

  it 'stops on commits without a Type: line or with several, listing each, and never guesses' do
    released_v010
    missing = commit('APP-2: no type (#2)')
    several = commit("APP-3: two types (#3)\n\nType: feat\nType: fix\n")
    squash('APP-4: fine (#4)', 'feat')

    stdout, stderr, status = next_version
    expect(status.exitstatus).to eq(1)
    expect(stdout).to be_empty
    expect(stderr).to include("#{missing[0, 7]} APP-2: no type (#2) (no Type: line)")
    expect(stderr).to include("#{several[0, 7]} APP-3: two types (#3) (2 Type: lines)")
  end

  it 'stops on an invalid Type: value' do
    released_v010
    bad = commit("APP-2: odd (#2)\n\nType: feature\n")

    _stdout, stderr, status = next_version
    expect(status.exitstatus).to eq(1)
    expect(stderr).to include("#{bad[0, 7]} APP-2: odd (#2) (invalid Type: feature)")
  end

  it 'exits 3 when nothing since the previous tag calls for a release' do
    released_v010
    squash('APP-2: tidy (#2)', 'chore')

    stdout, stderr, status = next_version
    expect(status.exitstatus).to eq(3)
    expect(stdout).to be_empty
    expect(stderr).to include('nothing to release since v0.1.0')
  end

  it 'takes the highest strict vX.Y.Z tag as the previous one and ignores other tags' do
    released_v010
    squash('APP-2: fix (#2)', 'fix')
    annotated_tag('v0.1.1')
    git('tag', 'v9.9')
    git('tag', 'v0.1.1-rc1')
    squash('APP-3: fix (#3)', 'fix')

    expect(next_version('--previous').first).to eq("v0.1.1\n")
    expect(next_version.first).to eq("0.1.2\n")
  end

  it 'prints an empty previous tag when there is none' do
    squash('APP-1: first (#1)', 'feat')

    stdout, _stderr, status = next_version('--previous')
    expect(status).to be_success
    expect(stdout).to eq("\n")
  end
end
