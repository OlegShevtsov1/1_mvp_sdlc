require 'rails_helper'

RSpec.describe '.github/workflows/release.yml' do
  let(:workflow) do
    YAML.load_file(Rails.root.join('.github/workflows/release.yml')).transform_keys { |key| key == true ? 'on' : key }
  end
  let(:release) { workflow.fetch('jobs').fetch('release') }
  let(:steps) { release.fetch('steps') }
  let(:notify) { workflow.fetch('jobs').fetch('notify') }

  def step(name)
    steps.find { |candidate| candidate['name'] == name } || raise("no step #{name.inspect}")
  end

  def index_of(text)
    steps.index { |candidate| candidate['run'].to_s.include?(text) } || raise("no step runs #{text}")
  end

  it 'runs only when a v* tag is pushed' do
    expect(workflow.fetch('on')).to eq('push' => { 'tags' => [ 'v*' ] })
  end

  it 'checks out the full history, so the tag, main and the previous tag are all there' do
    checkout = steps.find { |candidate| candidate['uses'].to_s.start_with?('actions/checkout@') }
    expect(checkout.fetch('with')).to include('fetch-depth' => 0)
  end

  it 'checks the tag, then its number, then builds the notes and creates a draft release, then the metrics' do
    order = [ 'deploy/release_tag_check.sh', 'scripts/next-version.sh', 'scripts/release-notes.sh', 'gh release create', 'bin/sdlc-metrics' ]
    expect(order.map { |text| index_of(text) }).to eq(order.map { |text| index_of(text) }.sort)
    expect(index_of('bin/sdlc-metrics')).to eq(steps.size - 2)
    expect(steps.last['if']).to eq('always()')
  end

  it 'creates the release as a draft from the CHANGELOG section of the existing tag' do
    create = steps[index_of('gh release create')].fetch('run')
    expect(create).to include('--draft', '--verify-tag', '--notes-file')
    expect(steps[index_of('scripts/release-notes.sh')].fetch('run')).to include('scripts/release-notes.sh "${TAG}"')
  end

  it 'passes the tag to the scripts through env, never as an expression inside run' do
    expect(release.fetch('env')).to include('TAG' => '${{ github.ref_name }}')
    steps.each { |candidate| expect(candidate['run'].to_s).not_to include('${{'), candidate['name'] }
  end

  it 'uses no LLM' do
    text = Rails.root.join('.github/workflows/release.yml').read
    expect(text).not_to match(/claude|anthropic|openai/i)
  end

  it 'reads by default and writes only what the release job needs' do
    expect(workflow.fetch('permissions')).to eq('contents' => 'read')
    expect(release.fetch('permissions')).to include('contents' => 'write')
  end

  it 'sends ✅ or ❌ to the prod alerts topic, whatever happened' do
    telegram = notify.fetch('steps').find { |candidate| candidate['uses'].to_s.include?('/notify-telegram@env/dev') }
    expect(notify).to include('environment' => 'prod', 'if' => 'always()')
    expect(Array(notify.fetch('needs'))).to eq(%w[release])
    expect(telegram.dig('with', 'topic')).to eq('PROD_ALERTS')
    expect(telegram.dig('with', 'message')).to include('needs.release.outputs.message')
  end

  describe 'the version number check' do
    def run_number_check(tag, next_version)
      Dir.mktmpdir do |dir|
        FileUtils.mkdir_p(File.join(dir, 'scripts'))
        write_executable(File.join(dir, 'scripts/next-version.sh'), "#!/usr/bin/env bash\necho \"$*\" > args\necho #{next_version}\n")
        output, status = Open3.capture2e({ 'TAG' => tag }, 'bash', '-e', '-c', steps[index_of('scripts/next-version.sh')].fetch('run'), chdir: dir)
        return [ output, status, File.read(File.join(dir, 'args')) ]
      end
    end

    it 'passes when the tag is the next version of the tagged commit' do
      output, status, args = run_number_check('v0.2.0', '0.2.0')
      expect(status).to be_success, output
      expect(args).to eq("v0.2.0^{commit}\n")
    end

    it 'fails, naming both numbers, when the tag is another number' do
      output, status = run_number_check('v0.1.0', '0.2.0')
      expect(status.exitstatus).to eq(1)
      expect(output).to include('::error::', 'v0.1.0', 'v0.2.0')
    end
  end

  describe 'the summary' do
    def summarize(outcomes)
      Tempfile.create('github_output') do |file|
        env = { 'GITHUB_OUTPUT' => file.path, 'GITHUB_STEP_SUMMARY' => File::NULL, 'TAG' => 'v0.1.0',
                'RUN_URL' => 'https://example.test/run/1' }.merge(outcomes)
        output, status = Open3.capture2e(env, 'bash', '-e', '-c', steps.last.fetch('run'))
        return [ output, status, File.read(file.path)[/^message=(.*)$/, 1] ]
      end
    end

    let(:all_success) { %w[TAG_CHECK NUMBER NOTES CREATE METRICS].index_with('success') }

    it 'is ✅ once the draft release exists' do
      _output, _status, message = summarize(all_success)
      expect(message).to start_with('✅').and include('v0.1.0', 'draft release')
    end

    it 'stays ✅ but names a failed bin/sdlc-metrics once the draft release exists' do
      _output, _status, message = summarize(all_success.merge('METRICS' => 'failure'))
      expect(message).to start_with('✅').and include('draft release', 'bin/sdlc-metrics', 'failure')
    end

    it 'is ❌ naming the first failed check' do
      output, status, message = summarize(all_success.merge('TAG_CHECK' => 'failure', 'NUMBER' => 'skipped', 'NOTES' => 'skipped',
                                                            'CREATE' => 'skipped', 'METRICS' => 'skipped'))
      expect(status).to be_success, output
      expect(message).to start_with('❌').and include('v0.1.0', 'Check the tag')
    end

    it 'is ❌ when the release was not created, even without a failed step' do
      _output, _status, message = summarize(%w[TAG_CHECK NUMBER NOTES CREATE METRICS].index_with(''))
      expect(message).to start_with('❌')
    end
  end
end
