require 'rails_helper'

RSpec.describe 'POST /api/errors' do
  let(:allowed_dsn) { 'https://fepublic@errors.example.test/2' }
  let(:upstream) { 'https://errors.example.test/api/2/envelope/' }

  around do |example|
    with_env('SENTRY_ALLOWED_FE_DSN' => allowed_dsn) { example.run }
  end

  before do
    Rails.cache.clear
    ErrorsController::RateLimitStore::FALLBACK.clear
  end

  def envelope(dsn = allowed_dsn)
    "#{{ dsn: dsn }.to_json}\n{\"type\":\"event\"}\n{\"message\":\"errors spec\"}"
  end

  def refused_envelope
    envelope('https://other@errors.example.test/2')
  end

  def post_envelope(body = envelope, env: {})
    post '/api/errors', params: body, headers: { 'Content-Type' => 'text/plain;charset=UTF-8' }, env: env
  end

  def post_alternating(count, env: {})
    Array.new(count) do |i|
      post_envelope(i.even? ? envelope : refused_envelope, env: env)
      response.status
    end
  end

  def alternating_statuses(count)
    Array.new(count) { |i| i.even? ? 200 : 403 }
  end

  # Calls numbered in `calls` answer nil, as RedisCacheStore's failsafe does while Redis is down.
  def fail_cache_increments(calls)
    call = 0
    allow(Rails.cache).to receive(:increment).and_wrap_original do |original, *args, **options|
      call += 1
      calls.cover?(call) ? nil : original.call(*args, **options)
    end
  end

  it 'relays an envelope for the allowed DSN and passes the upstream answer through' do
    stub_request(:post, upstream).to_return(status: 200, body: '{"id":"x"}')

    post_envelope

    expect(response).to have_http_status(:ok)
    expect(response.body).to eq('{"id":"x"}')
    expect(a_request(:post, upstream).with(body: envelope)).to have_been_made.once
  end

  it 'refuses another DSN with 403 without forwarding' do
    post_envelope(envelope('https://other@errors.example.test/2'))

    expect(response).to have_http_status(:forbidden)
    expect(a_request(:any, /.*/)).not_to have_been_made
  end

  it 'refuses a body over 256 KiB with 413' do
    post_envelope("#{envelope}\n#{'x' * SentryTunnel::MAX_BYTES}")

    expect(response).to have_http_status(:content_too_large)
    expect(a_request(:any, /.*/)).not_to have_been_made
  end

  it 'limits one client to 30 envelopes a minute' do
    stub_request(:post, upstream).to_return(status: 200, body: '{}')

    statuses = Array.new(31) do
      post_envelope
      response.status
    end

    expect(statuses.first(30)).to all(eq(200))
    expect(statuses.last).to eq(429)
  end

  it 'limits one client to 30 refused envelopes a minute' do
    statuses = Array.new(31) do
      post_envelope(refused_envelope)
      response.status
    end

    expect(statuses.first(30)).to all(eq(403))
    expect(statuses.last).to eq(429)
    expect(a_request(:any, /.*/)).not_to have_been_made
  end

  it 'counts accepted and refused envelopes against the same limit' do
    stub_request(:post, upstream).to_return(status: 200, body: '{}')

    statuses = post_alternating(31)

    expect(statuses.first(30)).to eq(alternating_statuses(30))
    expect(statuses.last).to eq(429)
  end

  it 'keeps limiting, accepted and refused alike, when the cache store fails' do
    stub_request(:post, upstream).to_return(status: 200, body: '{}')
    # RedisCacheStore's failsafe answers nil like this when Redis is unreachable or refuses writes.
    allow(Rails.cache).to receive(:increment).and_return(nil)

    statuses = post_alternating(31, env: { 'REMOTE_ADDR' => '203.0.113.77' })

    expect(statuses.first(30)).to eq(alternating_statuses(30))
    expect(statuses.last).to eq(429)
  end

  it 'counts a too-large request toward the shared limit' do
    29.times { post_envelope(refused_envelope) }

    post_envelope("#{envelope}\n#{'x' * SentryTunnel::MAX_BYTES}")
    expect(response).to have_http_status(:content_too_large)

    post_envelope(refused_envelope)
    expect(response).to have_http_status(:too_many_requests)
  end

  it 'keeps the count when the cache store recovers mid-window' do
    fail_cache_increments(1..25)

    statuses = Array.new(31) do
      post_envelope(refused_envelope)
      response.status
    end

    expect(statuses.first(30)).to all(eq(403))
    expect(statuses.last).to eq(429)
  end

  it 'keeps the count when the cache store fails mid-window' do
    fail_cache_increments(26..)

    statuses = Array.new(31) do
      post_envelope(refused_envelope)
      response.status
    end

    expect(statuses.first(30)).to all(eq(403))
    expect(statuses.last).to eq(429)
  end

  it 'keeps the count in the cache store for a process that has not counted yet' do
    29.times { post_envelope(refused_envelope) }
    stub_const('ErrorsController::RateLimitStore::FALLBACK', ActiveSupport::Cache::MemoryStore.new)

    post_envelope(refused_envelope)
    expect(response).to have_http_status(:forbidden)

    post_envelope(refused_envelope)
    expect(response).to have_http_status(:too_many_requests)
  end

  it 'does not exist while no frontend DSN is configured' do
    with_env('SENTRY_ALLOWED_FE_DSN' => nil) { post_envelope }

    expect(response).to have_http_status(:not_found)
  end
end
