require 'rails_helper'

RSpec.describe 'config/initializers/sentry.rb' do
  include Sentry::TestHelper

  # Generated, not literal: events carry source context lines of this file, so a literal secret
  # would leak into the event through the stack trace and hide what the scrubber does.
  let(:password) { "hunter2-#{SecureRandom.hex(4)}" }
  let(:token) { "tok-#{SecureRandom.hex(4)}" }

  before { setup_sentry_test }
  after { teardown_sentry_test }

  def captured_json
    last_sentry_event.to_json_compatible.to_json
  end

  it 'scrubs filtered parameters from the query string and the headers of a captured request' do
    env = Rack::MockRequest.env_for(
      "http://dev.example.test/api/v1/me?password=#{password}&token=#{token}",
      'HTTP_X_USER_TOKEN' => token
    )
    Sentry.with_scope do |scope|
      scope.set_rack_env(env)
      Sentry.capture_message('sentry spec')
    end

    expect(last_sentry_event.request.url).to eq('http://dev.example.test/api/v1/me')
    expect(captured_json).not_to include(password)
    expect(captured_json).not_to include(token)
  end

  it 'scrubs filtered keys from the extra data' do
    Sentry.capture_message('sentry spec', extra: { 'secret' => token, 'kind' => 'kept' })

    expect(last_sentry_event.extra).to eq('secret' => '[FILTERED]', 'kind' => 'kept')
    expect(captured_json).not_to include(token)
  end

  it 'tags events with the release baked into the image and the deploy environment' do
    with_env('APP_RELEASE' => 'release-spec', 'SENTRY_ENVIRONMENT' => 'dev') do
      load Rails.root.join('config/initializers/sentry.rb')
      setup_sentry_test
      Sentry.capture_message('sentry spec')
    end

    expect(last_sentry_event.release).to eq('release-spec')
    expect(last_sentry_event.environment).to eq('dev')
  ensure
    load Rails.root.join('config/initializers/sentry.rb')
  end
end
