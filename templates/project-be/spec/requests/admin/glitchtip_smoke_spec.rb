require 'rails_helper'

RSpec.describe 'POST /admin/glitchtip_smoke/:kind' do
  include Sentry::TestHelper

  let(:smoke_token) { 'smoke-token-spec' }
  let(:password) { "hunter2-#{SecureRandom.hex(4)}" }

  before { setup_sentry_test }
  after { teardown_sentry_test }

  around do |example|
    with_env('SMOKE_TOKEN' => smoke_token) { example.run }
  end

  def smoke(kind, token: smoke_token, marker: 'smoke-spec-marker')
    headers = { 'X-Smoke-Marker' => marker }
    headers['X-Smoke-Token'] = token if token
    post "/admin/glitchtip_smoke/#{kind}?password=#{password}", headers: headers
  end

  # Request specs re-raise by default; the production behaviour (a 500 page after the error is
  # reported) needs exceptions rendered.
  def with_rendered_exceptions
    env_config = Rails.application.env_config
    saved = env_config['action_dispatch.show_exceptions']
    env_config['action_dispatch.show_exceptions'] = :all
    yield
  ensure
    env_config['action_dispatch.show_exceptions'] = saved
  end

  describe 'access' do
    it 'is a 404 without a token' do
      smoke('manual', token: nil)

      expect(response).to have_http_status(:not_found)
      expect(sentry_events).to be_empty
    end

    it 'is a 404 with a wrong token' do
      smoke('manual', token: 'wrong')

      expect(response).to have_http_status(:not_found)
      expect(sentry_events).to be_empty
    end

    it 'is a 404 even with a header when SMOKE_TOKEN is not configured' do
      with_env('SMOKE_TOKEN' => nil) { smoke('manual', token: '') }

      expect(response).to have_http_status(:not_found)
    end

    it 'is a 404 for an unknown kind' do
      smoke('rake')

      expect(response).to have_http_status(:not_found)
      expect(sentry_events).to be_empty
    end
  end

  it 'reports a manual message carrying the marker' do
    smoke('manual')

    expect(response).to have_http_status(:accepted)
    expect(response.parsed_body).to include('kind' => 'manual', 'marker' => 'smoke-spec-marker')
    expect(sentry_events.size).to eq(1)
    expect(last_sentry_event.message).to eq('glitchtip smoke manual smoke-spec-marker')
  end

  it 'replaces a marker that is not a plain word with a generated one' do
    smoke('manual', marker: '<script>')

    expect(response.parsed_body['marker']).to match(/\Aglitchtip-smoke-\h{12}\z/)
  end

  it 'reports an unhandled exception and answers 500' do
    with_rendered_exceptions { smoke('unhandled') }

    expect(response).to have_http_status(:internal_server_error)
    exception = extract_sentry_exceptions(last_sentry_event).last
    expect(exception.type).to eq('GlitchtipSmoke::Error')
    expect(exception.value).to include('smoke-spec-marker')
    expect(last_sentry_event.to_json_compatible.to_json).not_to include(password)
  end

  context 'with a database error' do
    # Inside the spec transaction the failed SELECT aborts it and the error page's own queries
    # then fail too; production has no surrounding transaction. The SELECT writes nothing.
    self.use_transactional_tests = false

    it 'reports it carrying the marker and answers 500' do
      with_rendered_exceptions { smoke('db') }

      expect(response).to have_http_status(:internal_server_error)
      exception = extract_sentry_exceptions(last_sentry_event).last
      expect(exception.type).to eq('ActiveRecord::StatementInvalid')
      expect(exception.value).to include('smoke-spec-marker')
    end
  end
end
