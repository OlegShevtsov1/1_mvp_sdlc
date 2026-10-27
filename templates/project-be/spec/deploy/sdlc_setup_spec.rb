require 'rails_helper'

# .claude/sdlc.local.md is per-developer and never committed, so CLAUDE.md is the committed copy of
# the commands the agents run; it must not drift from what CI runs.
RSpec.describe 'the committed Claude Code setup' do
  let(:claude_md) { Rails.root.join('CLAUDE.md').read }

  def section(title)
    claude_md[/^## #{Regexp.escape(title)}\n(.*?)(?=^## |\z)/m, 1] || raise("CLAUDE.md has no ## #{title}")
  end

  let(:ci_commands) do
    %w[rails-test.yml rails-lint.yml].flat_map do |file|
      YAML.load_file(Rails.root.join('.github/workflows', file)).fetch('jobs').values
        .flat_map { |job| job.fetch('steps') }.filter_map { |step| step['run']&.strip }
    end
  end

  it 'keeps CLAUDE.md short and in English' do
    expect(claude_md.lines.size).to be <= 200
    expect(claude_md).not_to match(/\p{Cyrillic}/)
  end

  it 'follows every Hard Rule with an indented Why: line' do
    rules = section('Hard Rules').scan(/^- .*?(?=^- |\z)/m)

    expect(rules.size).to be >= 11
    rules.each { |rule| expect(rule).to match(/^  Why: \S/), rule }
  end

  { 'Tests' => 'bundle exec rspec', 'Lint' => 'bundle exec rubocop --parallel', 'Security' => 'bundle exec brakeman --no-pager -q' }.each do |label, command|
    it "lists the #{label.downcase} command exactly as a CI step runs it" do
      listed = section('Commands')[/^- #{label}: `([^`]+)`/, 1]

      expect(listed).to eq(command)
      expect(ci_commands).to include(listed)
    end
  end

  it 'enables the course plugins and denies the dangerous commands and secret files' do
    settings = JSON.parse(Rails.root.join('.claude/settings.json').read)

    expect(settings.fetch('enabledPlugins')).to include('sdlc@mvp' => true, 'mvp-sdlc@mvp' => true)
    expect(settings.fetch('permissions').fetch('allow')).to eq(
      %w[mcp__plugin_mvp-sdlc_mvp-rag__search mcp__plugin_mvp-sdlc_mvp-rag__get]
    )
    expect(settings.fetch('permissions').fetch('deny')).to include(
      'Bash(git push --force*)', 'Bash(git push -f*)', 'Bash(git reset --hard*)',
      'Read(**/.env*)', 'Read(config/master.key)', 'Edit(config/credentials*)'
    )
  end

  it 'denies the forms of moving or deleting a published tag that the prefix rules miss' do
    deny = JSON.parse(Rails.root.join('.claude/settings.json').read).fetch('permissions').fetch('deny')

    expect(deny).to include(
      'Bash(git tag -d*)', 'Bash(git tag --delete*)', 'Bash(git push --delete*)', 'Bash(git push * --delete*)',
      'Bash(git push -d*)', 'Bash(git push * -d *)', 'Bash(git push * --force*)', 'Bash(git push * -f *)',
      'Bash(git push * :refs/tags/*)', 'Bash(git push * :v*)', 'Bash(git push * +refs/tags/*)', 'Bash(git push * +v*)',
      'Bash(git push --mirror*)', 'Bash(git push * --mirror*)', 'Bash(git push --no-verify*)',
      'Bash(git push * --no-verify*)', 'Bash(git -c core.hooksPath*)'
    )
  end

  it 'installs the repository git hooks in bin/setup' do
    expect(Rails.root.join('bin/setup').read).to include('git config core.hooksPath .githooks')
  end

  it 'keeps the factory on develop and leaves pull requests into main to the operator' do
    repo = YAML.load_file(Rails.root.join('.archon/factory-profile.yaml')).fetch('repo')

    expect(repo).to include('base_branch' => 'develop', 'merge_strategy' => 'squash', 'manual_merge_bases' => [ 'main' ])
  end

  it 'keeps the per-developer settings out of git' do
    expect(Rails.root.join('.gitignore').readlines(chomp: true)).to include('.claude/*.local.md')
  end
end
