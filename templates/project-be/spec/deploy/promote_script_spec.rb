require 'rails_helper'

RSpec.describe 'deploy/promote.sh' do
  let(:name) { project_env.fetch('PROJECT_NAME') }
  let(:version) { "sha-#{DeploySandbox::SHA}" }
  let(:prod_version) { "prod-#{version}" }
  let(:repo) { "registry.example.test/#{name}" }
  let(:prod_env) { { 'PROD_VPN_IP' => '192.0.2.70', 'KAMAL_REGISTRY_SERVER' => 'registry.example.test' } }

  def crane_calls(root)
    sandbox_log(root, 'crane.log').lines(chomp: true)
  end

  def promote(files: dev_image_files, env: prod_env, &block)
    run_script('promote.sh', version, env: env, files: files, &block)
  end

  # prod-sha-<sha> as an earlier promotion left it; `changes` alters its documents.
  def promoted_files(manifest: ->(doc) { doc }, config: ->(doc) { doc })
    dev = dev_image_files
    prod_config = JSON.parse(dev.fetch("config-#{version}.json"))
    prod_config['config']['Labels']['service'] = name
    dev.merge(
      'digests' => "#{dev.fetch('digests')}#{prod_version} sha256:existing\n",
      "manifest-#{prod_version}.json" => manifest.call(JSON.parse(dev.fetch("manifest-#{version}.json"))).to_json,
      "config-#{prod_version}.json" => config.call(prod_config).to_json
    )
  end

  it 're-labels sha-<sha> for the prod service as prod-sha-<sha>, without building' do
    promote do |output, status, root|
      expect(status).to be_success, output
      expect(crane_calls(root)).to include("mutate #{repo}:#{version} --label service=#{name} -t #{repo}:#{prod_version}")
      expect(output).to include("#{version} sha256:dev#{DeploySandbox::SHA} -> #{prod_version} sha256:prod#{version}")
      expect(output).to include('layers identical (2 layers)')
      expect(sandbox_log(root, 'bundle.log')).to be_empty
    end
  end

  it 'reuses a verified prod-sha-<sha>' do
    promote(files: promoted_files) do |output, status, root|
      expect(status).to be_success, output
      expect(crane_calls(root).grep(/\Amutate /)).to be_empty
      expect(output).to include('layers identical')
    end
  end

  it 'refuses a version Dev Deploy never built' do
    promote(files: dev_image_files.merge('digests' => '')) do |output, status, root|
      expect(status.exitstatus).to eq(1)
      expect(output).to include("#{name}:#{version} is not in ECR (build it with Dev Deploy first)")
      expect(crane_calls(root).grep(/\Amutate /)).to be_empty
    end
  end

  it 'refuses a prod-sha-<sha> whose layer diff_ids differ' do
    files = promoted_files(config: ->(doc) { doc.merge('rootfs' => { 'type' => 'layers', 'diff_ids' => [ 'sha256:other' ] }) })
    promote(files: files) do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('layers differ')
    end
  end

  it 'refuses a prod-sha-<sha> whose manifest layers differ' do
    files = promoted_files(manifest: ->(doc) { doc.merge('layers' => [ { 'digest' => 'sha256:L9' } ]) })
    promote(files: files) do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('layers differ')
    end
  end

  it 'refuses a prod-sha-<sha> whose config differs beyond the service label' do
    files = promoted_files(config: ->(doc) { doc.tap { |d| d['config']['Env'] = [ 'APP_RELEASE=other' ] } })
    promote(files: files) do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('layers differ')
    end
  end

  it 'refuses a prod-sha-<sha> labelled for another service' do
    files = promoted_files(config: ->(doc) { doc.tap { |d| d['config']['Labels']['service'] = "#{name}-dev" } })
    promote(files: files) do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include("is not labelled service=#{name}")
    end
  end

  it 'refuses to run without PROD_VPN_IP' do
    promote(env: prod_env.merge('PROD_VPN_IP' => nil)) do |output, status, root|
      expect(status.exitstatus).to eq(2)
      expect(output).to include('PROD_VPN_IP is not set')
      expect(crane_calls(root)).to be_empty
    end
  end

  it 'logs in to crane through stdin and prints neither the account id nor the registry password' do
    promote(env: prod_env.merge('KAMAL_REGISTRY_SERVER' => nil)) do |output, status, root|
      expect(status).to be_success, output
      expect(crane_calls(root).first).to eq("auth login #{DeploySandbox::ACCOUNT_ID}.dkr.ecr.us-east-1.amazonaws.com")
      expect(sandbox_log(root, 'crane.log')).not_to include('ecr-password-from-shim')
      expect(output).not_to include(DeploySandbox::ACCOUNT_ID)
      expect(output).not_to include('ecr-password-from-shim')
    end
  end

  it 'records both digests in the GitHub step summary' do
    Dir.mktmpdir do |dir|
      summary = File.join(dir, 'summary.md')
      promote(env: prod_env.merge('GITHUB_STEP_SUMMARY' => summary)) do |_output, status|
        expect(status).to be_success
        expect(File.read(summary)).to include("| #{version} | sha256:dev#{DeploySandbox::SHA} | #{prod_version} | sha256:prod#{version} |")
      end
    end
  end
end
