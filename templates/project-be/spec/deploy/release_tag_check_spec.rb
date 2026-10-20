require 'rails_helper'

RSpec.describe 'deploy/release_tag_check.sh' do
  around do |example|
    in_git_repo do
      Dir.mktmpdir do |origin|
        @origin = origin
        git('init', '-q', '--bare', '-b', 'main', chdir: origin)
        git('remote', 'add', 'origin', origin)
        @main_sha = squash('APP-1: first (#1)', 'feat')
        git('push', '-q', 'origin', 'main')
        example.run
      end
    end
  end

  def check(tag)
    run_in_repo3('deploy/release_tag_check.sh', tag)
  end

  it 'prints the sha version of an annotated tag on main' do
    annotated_tag('v0.1.0')
    git('push', '-q', 'origin', 'v0.1.0')

    stdout, stderr, status = check('v0.1.0')
    expect(status).to be_success, stderr
    expect(stdout).to eq("version=sha-#{@main_sha}\n")
  end

  it 'accepts a tag on an older commit of main' do
    annotated_tag('v0.1.0')
    squash('APP-2: later (#2)', 'fix')
    git('push', '-q', 'origin', 'main', 'v0.1.0')

    expect(check('v0.1.0').first).to eq("version=sha-#{@main_sha}\n")
  end

  it 'refuses a lightweight tag' do
    git('tag', 'v0.1.0')
    git('push', '-q', 'origin', 'v0.1.0')

    stdout, stderr, status = check('v0.1.0')
    expect(status.exitstatus).to eq(1)
    expect(stdout).to be_empty
    expect(stderr).to include('lightweight')
  end

  it 'refuses an annotated tag on a commit that is not on main' do
    git('switch', '-q', '-c', 'side')
    squash('APP-2: side (#2)', 'feat')
    annotated_tag('v0.2.0')
    git('push', '-q', 'origin', 'v0.2.0')

    _stdout, stderr, status = check('v0.2.0')
    expect(status.exitstatus).to eq(1)
    expect(stderr).to include('not on main')
  end

  it 'refuses a tag that exists only locally' do
    annotated_tag('v0.1.0')

    _stdout, stderr, status = check('v0.1.0')
    expect(status.exitstatus).to eq(1)
    expect(stderr).to include('not published')
  end

  it 'checks the published tag, not a local one of the same name' do
    git('tag', 'v0.1.0')
    git('push', '-q', 'origin', 'v0.1.0')
    git('tag', '-f', '-a', 'v0.1.0', '-m', 'local look-alike')

    _stdout, stderr, status = check('v0.1.0')
    expect(status.exitstatus).to eq(1)
    expect(stderr).to include('lightweight')
  end

  it 'refuses anything that is not vX.Y.Z with a usage error' do
    [ "sha-#{@main_sha}", @main_sha, 'v1.2', 'v01.2.3', '1.2.3', '' ].each do |version|
      stdout, _stderr, status = check(version)
      expect(status.exitstatus).to eq(2), version
      expect(stdout).to be_empty
    end
  end
end
