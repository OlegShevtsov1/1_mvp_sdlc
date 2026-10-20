require 'rails_helper'
require 'kamal'

RSpec.describe 'config/deploy.yml' do
  let(:name) { project_env.fetch('PROJECT_NAME') }
  let(:zone) { project_env.fetch('PROJECT_ZONE') }

  def load_config(env)
    with_env(env) do
      Dir.chdir(Rails.root) do
        Kamal::Configuration.create_from(config_file: Pathname('config/deploy.yml'), version: 'prod-sha-x')
      end
    end
  end

  let(:config) { load_config('PROD_VPN_IP' => '192.0.2.70', 'KAMAL_REGISTRY_SERVER' => 'registry.example.test') }

  it 'deploys the <name> service from the <name> image to the prod VPN address' do
    expect(config.service).to eq(name)
    expect(config.absolute_image).to eq("registry.example.test/#{name}:prod-sha-x")
    expect(config.primary_host).to eq('192.0.2.70')
    expect(config.ssh.user).to eq('ubuntu')
  end

  it 'needs PROD_VPN_IP, which is never committed' do
    expect { load_config('PROD_VPN_IP' => nil, 'KAMAL_REGISTRY_SERVER' => 'registry.example.test') }.to raise_error(KeyError)
  end

  it 'serves <zone> over HTTPS terminated by kamal-proxy, without trusting client forwarded headers' do
    proxy = config.role(:web).proxy

    expect(proxy.ssl?).to be(true)
    expect(proxy.deploy_options[:host]).to eq([ zone ])
    expect(proxy.deploy_options[:tls]).to be(true)
    expect(proxy.deploy_options[:'health-check-path']).to eq('/health')
    expect(proxy.deploy_options[:'forward-headers']).not_to be(true)
  end

  it 'forces SSL and reports to the prod environment with the prod secrets' do
    expect(config.env.clear).to include('RAILS_FORCE_SSL' => 'true', 'SENTRY_ENVIRONMENT' => 'prod')
    expect(config.env.secret_keys).to contain_exactly('SECRET_KEY_BASE', 'DATABASE_URL', 'SENTRY_DSN', 'SENTRY_ALLOWED_FE_DSN', 'SMOKE_TOKEN')
    expect(config.secrets_path).to eq('.kamal/secrets.prod')
  end

  it 'keeps the database and redis data in named volumes' do
    data = config.accessories.reject { |accessory| accessory.name == 'beszel-agent' }

    expect(data.map(&:service_name)).to eq([ "#{name}-db", "#{name}-redis" ])
    expect(data.map(&:volume_args)).to eq([
      [ '--volume', "#{name}-pg-data:/var/lib/postgresql/data" ],
      [ '--volume', "#{name}-redis-data:/data" ]
    ])
  end

  describe 'the beszel-agent accessory' do
    let(:agent) { config.accessory('beszel-agent') }

    def agent_with_key(key)
      load_config('PROD_VPN_IP' => '192.0.2.70', 'KAMAL_REGISTRY_SERVER' => 'registry.example.test', 'BESZEL_HUB_KEY' => key)
        .accessory('beszel-agent')
    end

    it 'runs the pinned Beszel agent image on the prod host' do
      expect(agent.image).to eq('henrygd/beszel-agent:0.21.0')
      expect(agent.hosts).to eq([ '192.0.2.70' ])
      expect(agent.service_name).to eq("#{name}-beszel-agent")
    end

    it 'uses the host network, so it sees the host and listens on 45876 there' do
      expect(agent.network_args).to eq([ '--network', 'host' ])
      expect(agent.env.clear).to include('LISTEN' => '45876')
      expect(agent.publish_args).to be_nil
    end

    it 'takes the hub public key from BESZEL_HUB_KEY, empty when unset, and keeps it out of the deploy secrets' do
      expect(agent_with_key('ssh-ed25519 AAAAexample').env.clear).to include('KEY' => 'ssh-ed25519 AAAAexample')
      expect(agent_with_key(nil).env.clear).to include('KEY' => '')
      expect(Rails.root.join('.kamal/secrets.prod').read).not_to include('BESZEL')
    end

    it 'reads the Docker socket read-only and keeps its state in a named volume' do
      expect(agent.volume_args).to eq([
        '--volume', '/var/run/docker.sock:/var/run/docker.sock:ro',
        '--volume', "#{name}-beszel-agent-data:/var/lib/beszel-agent"
      ])
    end
  end

  it 'has no Kamal 1 / Traefik leftovers' do
    expect(Rails.root.join('config/deploy.yml').read).not_to match(/traefik/i)
  end

  it 'is the only config besides config/deploy.dev.yml: no destination overlays' do
    expect(Dir.glob('config/deploy.*.yml', base: Rails.root.to_s)).to eq([ 'config/deploy.dev.yml' ])
  end
end
