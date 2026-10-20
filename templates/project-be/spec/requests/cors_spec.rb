require 'rails_helper'

RSpec.describe 'CORS' do
  let(:app_origin) { 'https://app.dev.example.test' }

  around do |example|
    with_env('CORS_ALLOWED_ORIGINS' => "https://other.example.test, #{app_origin}") { example.run }
  end

  def preflight(origin)
    process :options, '/api/errors', headers: {
      'Origin' => origin,
      'Access-Control-Request-Method' => 'POST',
      'Access-Control-Request-Headers' => 'content-type'
    }
  end

  it 'allows a preflight from a configured origin' do
    preflight(app_origin)

    expect(response.headers['Access-Control-Allow-Origin']).to eq(app_origin)
    expect(response.headers['Access-Control-Allow-Methods']).to include('POST')
  end

  it 'answers a simple request from a configured origin with the CORS header' do
    get '/health', headers: { 'Origin' => app_origin }

    expect(response.headers['Access-Control-Allow-Origin']).to eq(app_origin)
  end

  it 'gives an unknown origin no CORS headers' do
    preflight('https://evil.example.com')
    expect(response.headers['Access-Control-Allow-Origin']).to be_nil

    get '/health', headers: { 'Origin' => 'https://evil.example.com' }
    expect(response.headers['Access-Control-Allow-Origin']).to be_nil
  end

  it 'allows no origin while CORS_ALLOWED_ORIGINS is empty' do
    with_env('CORS_ALLOWED_ORIGINS' => '') { preflight(app_origin) }

    expect(response.headers['Access-Control-Allow-Origin']).to be_nil
  end
end
