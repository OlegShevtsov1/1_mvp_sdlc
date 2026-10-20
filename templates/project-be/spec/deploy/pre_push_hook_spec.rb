require 'rails_helper'

RSpec.describe '.githooks/pre-push' do
  around do |example|
    in_git_repo do
      Dir.mktmpdir do |origin|
        @origin = origin
        git('init', '-q', '--bare', '-b', 'main', chdir: origin)
        git('remote', 'add', 'origin', origin)
        @first = squash('APP-1: first (#1)', 'feat')
        git('push', '-q', 'origin', 'main')
        example.run
      end
    end
  end

  # git with the repository's hooks, as `git config core.hooksPath .githooks` sets up a clone.
  def hooked_git(*args)
    Open3.capture2e(GitFixture::GIT_ENV, 'git', '-c', "core.hooksPath=#{Rails.root.join('.githooks')}", *args, chdir: @repo)
  end

  def remote_tag(name)
    git('ls-remote', 'origin', "refs/tags/#{name}")
  end

  def publish_v010
    annotated_tag('v0.1.0')
    output, status = hooked_git('push', 'origin', 'v0.1.0')
    expect(status).to be_success, output
    remote_tag('v0.1.0')
  end

  it 'lets a new release tag through' do
    expect(publish_v010).to include('refs/tags/v0.1.0')
  end

  it 'refuses git push --force of a moved release tag' do
    published = publish_v010
    squash('APP-2: second (#2)', 'fix')
    git('tag', '-f', '-a', 'v0.1.0', '-m', 'moved')

    output, status = hooked_git('push', '--force', 'origin', 'v0.1.0')
    expect(status).not_to be_success
    expect(output).to include('pre-push: refusing', 'v0.1.0')
    expect(remote_tag('v0.1.0')).to eq(published)
  end

  it 'refuses git push --delete origin of a release tag' do
    published = publish_v010

    output, status = hooked_git('push', '--delete', 'origin', 'v0.1.0')
    expect(status).not_to be_success
    expect(output).to include('pre-push: refusing')
    expect(remote_tag('v0.1.0')).to eq(published)
  end

  it 'refuses pushing the deletion after git tag -d' do
    published = publish_v010
    git('tag', '-d', 'v0.1.0')

    output, status = hooked_git('push', 'origin', ':refs/tags/v0.1.0')
    expect(status).not_to be_success
    expect(output).to include('pre-push: refusing')
    expect(remote_tag('v0.1.0')).to eq(published)
  end

  it 'refuses re-pushing a recreated release tag after git tag -d' do
    published = publish_v010
    git('tag', '-d', 'v0.1.0')
    squash('APP-2: second (#2)', 'fix')
    annotated_tag('v0.1.0')

    _output, status = hooked_git('push', '--force', 'origin', 'refs/tags/v0.1.0')
    expect(status).not_to be_success
    expect(remote_tag('v0.1.0')).to eq(published)
  end

  it 'leaves branches and other tags alone' do
    git('tag', 'probe')
    expect(hooked_git('push', 'origin', 'probe').last).to be_success
    expect(hooked_git('push', '--delete', 'origin', 'probe').last).to be_success

    git('switch', '-q', '-c', 'feature/APP-2-x')
    squash('APP-2: second (#2)', 'fix')
    expect(hooked_git('push', 'origin', 'feature/APP-2-x').last).to be_success
    expect(hooked_git('push', '--delete', 'origin', 'feature/APP-2-x').last).to be_success
  end
end
