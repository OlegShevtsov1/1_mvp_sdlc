require 'rails_helper'

RSpec.describe 'bin/pr-conventions-check' do
  let(:template) { Rails.root.join('.github/pull_request_template.md').read }

  # The ticket key is PROJECT_NAME from config/project.env in capitals, as the script derives it.
  KEY = Rails.root.join('config/project.env').read[/^PROJECT_NAME=(.*)$/, 1].upcase

  # Yields the output and the exit status; `env` overrides a valid feature PR into develop.
  def conventions(env = {})
    full_env = {
      'HEAD_REF' => "feature/#{KEY}-12-login-page", 'BASE_REF' => 'develop',
      'PR_TITLE' => "#{KEY}-12: Login page", 'PR_BODY' => "What and why\n\nType: feat\n"
    }.merge(env)
    output, status = Open3.capture2e(full_env, Rails.root.join('bin/pr-conventions-check').to_s)
    yield output, status
  end

  it 'passes a feature branch into develop with a <KEY>-<n> title and one Type: line' do
    conventions { |output, status| expect(status).to be_success, output }
  end

  {
    'a hotfix into main' => { 'HEAD_REF' => "hotfix/#{KEY}-7-token-expiry", 'BASE_REF' => 'main' },
    'the factory branch exception' => { 'HEAD_REF' => 'archon/task-factory-1792086449006', 'BASE_REF' => 'develop' },
    'the release PR from develop into main' => { 'HEAD_REF' => 'develop', 'BASE_REF' => 'main' }
  }.each do |label, env|
    it "passes #{label}" do
      conventions(env) { |output, status| expect(status).to be_success, output }
    end
  end

  [
    [ 'wip-test', 'develop' ], [ 'feature/login', 'develop' ], [ "feature/#{KEY}-12-Login_Page", 'develop' ],
    [ "bugfix/#{KEY}-12-x", 'develop' ], [ 'feature/APP-12-x', 'develop' ], [ 'develop', 'develop' ]
  ].each do |head, base|
    it "fails condition 1 for the branch #{head.inspect} into #{base}" do
      conventions('HEAD_REF' => head, 'BASE_REF' => base) do |output, status|
        expect(status.exitstatus).to eq(1)
        expect(output).to include("::error::condition 1 failed: branch '#{head}'")
        expect(output).to include("feature/#{KEY}-<n>-<slug>", "hotfix/#{KEY}-<n>-<slug>", 'archon/task-factory-*', 'develop (into main)')
        expect(output).not_to include('condition 2', 'condition 3')
      end
    end
  end

  [ 'Add login', "#{KEY}-12 Add login", "#{KEY.downcase}-12: x", "#{KEY}-12: ", "[#{KEY}-12]: x", 'APP-12: x' ].each do |title|
    it "fails condition 2 for the title #{title.inspect}" do
      conventions('PR_TITLE' => title) do |output, status|
        expect(status.exitstatus).to eq(1)
        expect(output).to include('::error::condition 2 failed: title', "#{KEY}-<n>: <card title>")
        expect(output).not_to include('condition 1', 'condition 3')
      end
    end
  end

  {
    "What and why\n" => 'the body has no Type: line',
    "What\n\n Type: feat\n" => 'the body has no Type: line',
    "Type: feat\n\nType: fix\n" => 'has 2 Type: lines',
    "What\n\nType: feature\n" => 'invalid value',
    "What\n\nType: \n" => 'invalid value'
  }.each do |body, reason|
    it "fails condition 3 (#{reason}) for the body #{body.inspect}" do
      conventions('PR_BODY' => body) do |output, status|
        expect(status.exitstatus).to eq(1)
        expect(output).to include('::error::condition 3 failed:', reason)
        expect(output).not_to include('condition 1', 'condition 2')
      end
    end
  end

  it 'passes a body with CRLF line ends, as GitHub sends edited bodies' do
    conventions('PR_BODY' => "What\r\n\r\nType: fix\r\n") { |output, status| expect(status).to be_success, output }
  end

  it 'reports every failed condition at once' do
    conventions('HEAD_REF' => 'wip-test', 'PR_TITLE' => 'Add login', 'PR_BODY' => '') do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output.scan(/^::error::condition (\d) failed/).flatten).to eq(%w[1 2 3])
    end
  end

  it 'accepts the key of the project and no other' do
    conventions('PR_TITLE' => "#{KEY}-12: x") { |output, status| expect(status).to be_success, output }
    conventions('PR_TITLE' => 'APP-12: x') { |_output, status| expect(status.exitstatus).to eq(1) } unless KEY == 'APP'
  end

  context 'with a copy of the script next to another config/project.env' do
    # Yields the output and the exit status of the copied script for the given project.env text.
    def conventions_for(project_env)
      Dir.mktmpdir do |dir|
        FileUtils.mkdir_p(File.join(dir, 'bin'))
        FileUtils.mkdir_p(File.join(dir, 'config'))
        FileUtils.cp(Rails.root.join('bin/pr-conventions-check'), File.join(dir, 'bin'))
        File.write(File.join(dir, 'config/project.env'), project_env) unless project_env.nil?
        env = { 'HEAD_REF' => 'feature/SHOP2-3-cart', 'BASE_REF' => 'develop', 'PR_TITLE' => 'SHOP2-3: Cart', 'PR_BODY' => "Type: feat\n" }
        yield(*Open3.capture2e(env, File.join(dir, 'bin/pr-conventions-check')))
      end
    end

    it 'derives the key from PROJECT_NAME in capitals' do
      conventions_for("# comment\nPROJECT_NAME=shop2\nPROJECT_ZONE=shop2.example.test\n") do |output, status|
        expect(status).to be_success, output
      end
    end

    { 'an invalid name' => "PROJECT_NAME=my-app\n", 'a name starting with a digit' => "PROJECT_NAME=2shop\n",
      'no PROJECT_NAME' => "PROJECT_ZONE=x.example.test\n", 'no config/project.env' => nil }.each do |label, project_env|
      it "exits 2 with #{label}" do
        conventions_for(project_env) do |output, status|
          expect(status.exitstatus).to eq(2)
          expect(output).to include('no valid ticket key')
        end
      end
    end
  end

  %w[HEAD_REF BASE_REF].each do |name|
    it "exits 2 with a usage message when #{name} is empty" do
      conventions(name => '') do |output, status|
        expect(status.exitstatus).to eq(2)
        expect(output).to include('usage', name)
      end
    end
  end

  describe '.github/pull_request_template.md' do
    it 'fails only condition 3 with an invalid value while the Type: line is unfilled' do
      conventions('PR_BODY' => template) do |output, status|
        expect(status.exitstatus).to eq(1)
        expect(output).to include('::error::condition 3 failed:', 'invalid value')
        expect(output).not_to include('condition 1', 'condition 2')
      end
    end

    it 'passes once the Type: line is filled' do
      conventions('PR_BODY' => template.sub(/^Type: *$/, 'Type: ci')) { |output, status| expect(status).to be_success, output }
    end

    it 'has exactly one Type: line, as its last non-empty line' do
      lines = template.lines(chomp: true)

      expect(lines.grep(/^Type:/).size).to eq(1)
      expect(lines.reject(&:blank?).last).to match(/^Type:/)
    end
  end

  describe '.github/workflows/pr-conventions-check.yml' do
    let(:workflow) { YAML.load_file(Rails.root.join('.github/workflows/pr-conventions-check.yml')).transform_keys { |key| key == true ? 'on' : key } }
    let(:steps) { workflow.fetch('jobs').values.sole.fetch('steps') }
    let(:check) { steps.find { |step| step['run'] == 'bin/pr-conventions-check' } }

    it 'runs on pull requests into main and develop, again when the title or body is edited' do
      pull_request = workflow.fetch('on').fetch('pull_request')

      expect(pull_request.fetch('branches')).to eq(%w[main develop])
      expect(pull_request.fetch('types')).to include('opened', 'edited', 'reopened', 'synchronize')
    end

    it 'checks the pull request with bin/pr-conventions-check, passing its fields only through env' do
      expect(check).to be_present
      expect(check.fetch('env')).to include(
        'HEAD_REF' => '${{ github.event.pull_request.head.ref }}',
        'BASE_REF' => '${{ github.event.pull_request.base.ref }}',
        'PR_TITLE' => '${{ github.event.pull_request.title }}',
        'PR_BODY' => '${{ github.event.pull_request.body }}'
      )
      steps.each { |step| expect(step['run'].to_s).not_to include('${{') }
    end

    it 'only reads the repository' do
      expect(workflow.fetch('permissions')).to eq('contents' => 'read')
    end
  end
end
