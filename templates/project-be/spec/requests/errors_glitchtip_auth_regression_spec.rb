require 'rails_helper'

# Saved eval case for a real defect (the repository has no separate eval set): the B2 post-merge,
# step A5 (2026-10-14), saw GlitchTip answer 403 {"detail":"Denied"} to every tunnelled envelope,
# because the forward carried no Sentry auth. Unlike Sentry Relay, GlitchTip ignores the DSN in
# the envelope header and needs the public key in X-Sentry-Auth.
RSpec.describe 'POST /api/errors against a GlitchTip that requires the DSN key' do
  let(:allowed_dsn) { 'https://fepublic@errors.example.test/2' }
  let(:upstream) { 'https://errors.example.test/api/2/envelope/' }

  around do |example|
    with_env('SENTRY_ALLOWED_FE_DSN' => allowed_dsn) { example.run }
  end

  before do
    Rails.cache.clear
    stub_request(:post, upstream).to_return do |request|
      if authorized?(request)
        { status: 200, body: '{"id":"x"}' }
      else
        { status: 403, body: '{"detail":"Denied"}' }
      end
    end
  end

  def authorized?(request)
    auth = request.headers['X-Sentry-Auth'].to_s
    auth.start_with?('Sentry ') && auth.delete_prefix('Sentry ').split(',').map(&:strip).include?('sentry_key=fepublic')
  end

  def envelope
    "#{{ dsn: allowed_dsn }.to_json}\n{\"type\":\"event\"}\n{\"message\":\"glitchtip auth regression\"}"
  end

  it 'relays a valid envelope that GlitchTip accepts (authenticated with the DSN public key)' do
    post '/api/errors', params: envelope, headers: { 'Content-Type' => 'text/plain;charset=UTF-8' }

    expect(response).to have_http_status(:ok)
    expect(response.body).to eq('{"id":"x"}')
    expect(a_request(:post, upstream).with(body: envelope)).to have_been_made.once
  end
end
