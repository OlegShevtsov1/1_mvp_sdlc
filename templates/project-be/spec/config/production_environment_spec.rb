require 'rails_helper'
require 'open3'

# The suite boots in the test environment, which never loads config/environments/production.rb,
# so its defaults are only observable from a real production process.
RSpec.describe 'config/environments/production.rb' do
  def production_force_ssl(rails_force_ssl)
    marker = 'force_ssl='
    env = {
      'RAILS_ENV' => 'production',
      'SECRET_KEY_BASE' => 'production_environment_spec',
      'RAILS_FORCE_SSL' => rails_force_ssl,
      # CI copies config/database.github-actions.yml, which declares only a test: key, over
      # config/database.yml, so the production boot has to bring its own connection config. It is
      # never opened: reading config.force_ssl needs no database.
      'DATABASE_URL' => 'postgres://nobody:nobody@127.0.0.1:1/nope'
    }
    script = "print '#{marker}'; puts Rails.application.config.force_ssl"
    output, status = Open3.capture2e(env, 'bin/rails', 'runner', script, chdir: Rails.root.to_s)
    raise "production boot failed (#{status.exitstatus}):\n#{output}" unless status.success?

    output[/#{marker}(\w+)/, 1]
  end

  it 'forces SSL when RAILS_FORCE_SSL is unset, as every AWS destination relies on' do
    expect(production_force_ssl(nil)).to eq('true')
  end

  it 'allows plain HTTP when RAILS_FORCE_SSL is false, for a deployment without a TLS terminator' do
    expect(production_force_ssl('false')).to eq('false')
  end

  describe 'behind a TLS-terminating proxy (RAILS_FORCE_SSL unset)' do
    before(:all) do
      marker = 'tls_probe='
      env = {
        'RAILS_ENV' => 'production',
        'SECRET_KEY_BASE' => 'production_environment_spec',
        'RAILS_FORCE_SSL' => nil,
        'RAILS_LOG_LEVEL' => 'fatal',
        'DATABASE_URL' => 'postgres://nobody:nobody@127.0.0.1:1/nope'
      }
      # REMOTE_ADDR is a public TEST-NET address, so the request does not come from a trusted proxy.
      script = <<~RUBY
        app = Rack::MockRequest.new(Rails.application)
        base = { 'HTTP_HOST' => 'dev.example.test', 'REMOTE_ADDR' => '203.0.113.10' }
        probe = lambda do |path, headers = {}|
          response = app.get(path, base.merge(headers))
          { status: response.status, location: response.location,
            'strict-transport-security': response.headers['strict-transport-security'] }
        end
        puts '#{marker}' + JSON.generate(
          plain: probe.call('/tls-probe'),
          forwarded_https: probe.call('/tls-probe', 'HTTP_X_FORWARDED_PROTO' => 'https'),
          health: probe.call('/health')
        )
      RUBY
      output, status = Open3.capture2e(env, 'bin/rails', 'runner', script, chdir: Rails.root.to_s)
      raise "production boot failed (#{status.exitstatus}):\n#{output}" unless status.success?

      @responses = JSON.parse(output[/^#{marker}(.+)$/, 1], symbolize_names: true)
    end

    it 'redirects plain HTTP to HTTPS' do
      expect(@responses[:plain]).to include(status: 301, location: 'https://dev.example.test/tls-probe')
    end

    it 'serves a request the proxy marks as HTTPS without redirecting, independent of trusted proxies' do
      expect(@responses[:forwarded_https][:status]).not_to eq(301)
      expect(@responses[:forwarded_https][:'strict-transport-security']).to be_present
    end

    it 'sends a two-year HSTS policy that covers subdomains' do
      hsts = @responses[:forwarded_https][:'strict-transport-security']
      expect(hsts).to match(/max-age=63072000/)
      expect(hsts).to match(/includeSubDomains/)
    end

    it 'answers /health over plain HTTP for proxy health checks' do
      expect(@responses[:health][:status]).to eq(200)
    end
  end
end
