require 'open3'
require 'tmpdir'
require 'fileutils'

# Throwaway git repositories for the release scripts, which read real history: tags, merges and
# commit bodies. Call `in_git_repo { ... }` around an example; `@repo` is the working tree.
module GitFixture
  # A clean identity and no global or system config, so a developer's signing or hooks cannot interfere.
  GIT_ENV = {
    'GIT_AUTHOR_NAME' => 'Spec', 'GIT_AUTHOR_EMAIL' => 'spec@example.com',
    'GIT_COMMITTER_NAME' => 'Spec', 'GIT_COMMITTER_EMAIL' => 'spec@example.com',
    'GIT_CONFIG_GLOBAL' => File::NULL, 'GIT_CONFIG_NOSYSTEM' => '1'
  }.freeze

  def in_git_repo
    Dir.mktmpdir do |dir|
      @repo = dir
      git('init', '-q', '-b', 'main')
      yield
    end
  end

  def git(*args, chdir: @repo, env: {})
    output, status = Open3.capture2e(GIT_ENV.merge(env), 'git', *args, chdir: chdir)
    raise "git #{args.join(' ')}: #{output}" unless status.success?

    output.strip
  end

  # Commits `files` (path => content) with `message` (subject, blank line, body) and returns the sha.
  # Braceless `'path' => content` arguments arrive as keywords in Ruby 3, hence **paths.
  def commit(message, files = {}, date: nil, **paths)
    files.merge(paths).each do |path, content|
      full = File.join(@repo, path)
      FileUtils.mkdir_p(File.dirname(full))
      File.write(full, content)
    end
    git('add', '-A')
    dated = date ? { 'GIT_AUTHOR_DATE' => date, 'GIT_COMMITTER_DATE' => date } : {}
    Tempfile.create('message') do |file|
      file.write(message)
      file.flush
      git('commit', '-q', '--allow-empty', '-F', file.path, env: dated)
    end
    git('rev-parse', 'HEAD')
  end

  # A squash commit as GitHub writes it: PR title as the subject, PR body (ending in Type:) as the body.
  def squash(subject, type, files = {}, body: 'Summary.', date: nil)
    commit("#{subject}\n\n#{body}\n\nType: #{type}\n", files.empty? ? { "#{subject.hash.abs}.txt" => subject } : files, date: date)
  end

  def annotated_tag(name, target = 'HEAD', date: nil)
    dated = date ? { 'GIT_COMMITTER_DATE' => date } : {}
    git('tag', '-a', name, '-m', name, target, env: dated)
  end

  # Runs a repository script against the fixture repo (cwd = @repo) and returns [output, status].
  def run_in_repo(script, *args, env: {})
    Open3.capture2e(GIT_ENV.merge(env), Rails.root.join(script).to_s, *args, chdir: @repo)
  end

  # Like run_in_repo, but stdout and stderr separately: [stdout, stderr, status].
  def run_in_repo3(script, *args, env: {})
    Open3.capture3(GIT_ENV.merge(env), Rails.root.join(script).to_s, *args, chdir: @repo)
  end
end

RSpec.configure do |config|
  config.include GitFixture, file_path: %r{spec/deploy/}
end
