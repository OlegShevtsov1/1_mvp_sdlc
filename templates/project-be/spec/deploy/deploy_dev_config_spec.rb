require 'rails_helper'
require 'kamal'

RSpec.describe 'config/deploy.dev.yml' do
  let(:name) { project_env.fetch('PROJECT_NAME') }

  let(:config) do
    with_env('DEV_HOST' => '192.0.2.10', 'KAMAL_REGISTRY_SERVER' => 'registry.example.test') do
      Dir.chdir(Rails.root) do
        Kamal::Configuration.create_from(config_file: Pathname('config/deploy.dev.yml'), version: 'sha-x')
      end
    end
  end

  it 'keeps only the public project identity in config/project.env' do
    expect(project_env.keys).to contain_exactly('PROJECT_NAME', 'PROJECT_ZONE')
  end

  it 'deploys the <name>-dev service from the <name> image in the configured registry' do
    expect(config.service).to eq("#{name}-dev")
    expect(config.absolute_image).to eq("registry.example.test/#{name}:sha-x")
    expect(config.primary_host).to eq('192.0.2.10')
  end

  it 'routes dev.<zone> through the shared proxy with forwarded headers' do
    proxy = config.role(:web).proxy

    expect(proxy.deploy_options[:host]).to eq([ "dev.#{project_env.fetch('PROJECT_ZONE')}" ])
    expect(proxy.deploy_options[:'forward-headers']).to be(true)
    expect(proxy.deploy_options[:'health-check-path']).to eq('/health')
  end

  it 'runs its own database and redis accessories' do
    expect(config.accessories.map(&:service_name)).to eq([ "#{name}-dev-db", "#{name}-dev-redis" ])
  end

  # This repository is going public: the deploy files must stay generic and carry no internal
  # address, machine name or account id. Project identity lives only in config/project.env.
  describe 'public-safety' do
    files = %w[
      config/deploy.dev.yml .kamal/secrets.dev .github/workflows/dev-deploy.yml
      config/deploy.yml .kamal/secrets.prod .github/workflows/kamal-deploy.yml .github/workflows/kamal-manage.yml
      .github/workflows/release.yml
    ] + Dir.glob('deploy/*', base: Rails.root.to_s)
    forbidden = {
      'the project name' => /\b{{PROJECT_NAME}}\b/,
      'the project zone' => /up\.km\.ua/,
      'a VPN address' => /10\.18\./,
      'a machine name' => /vr\d+-|srv\d{5}/,
      'an AWS account id' => /(?<!\d)\d{12}(?!\d)/,
      'a home directory' => %r{/home/}
    }

    files.each do |file|
      forbidden.each do |what, pattern|
        it "keeps #{what} out of #{file}" do
          expect(Rails.root.join(file).read).not_to match(pattern)
        end
      end
    end
  end
end
