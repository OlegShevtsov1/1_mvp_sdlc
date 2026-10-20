require 'rails_helper'

RSpec.describe SentryTunnel do
  let(:allowed_dsn) { 'https://fepublic@errors.example.test:8443/glitchtip/2' }
  let(:upstream) { 'https://errors.example.test:8443/glitchtip/api/2/envelope/' }

  def envelope(dsn)
    [
      { event_id: 'a' * 32, dsn: dsn }.to_json,
      { type: 'event' }.to_json,
      { event_id: 'a' * 32, message: "tunnel spec é" }.to_json
    ].join("\n")
  end

  it 'posts the unchanged body to the envelope endpoint derived from the allowed DSN' do
    body = envelope(allowed_dsn)
    stub_request(:post, upstream).to_return(status: 200, body: '{"id":"x"}')

    expect(described_class.forward(body, allowed_dsn: allowed_dsn)).to eq([ 200, '{"id":"x"}' ])
    expect(a_request(:post, upstream).with(
      body: body, headers: { 'Content-Type' => 'application/x-sentry-envelope' }
    ) { |req|
      auth = req.headers['X-Sentry-Auth'].to_s
      auth.include?('sentry_key=fepublic') && !auth.include?('sentry_secret')
    }).to have_been_made.once
  end

  it 'derives the endpoint for a DSN without a path prefix or port' do
    dsn = 'http://fepublic@errors.example.test/7'
    stub_request(:post, 'http://errors.example.test/api/7/envelope/').to_return(status: 200)

    expect(described_class.forward(envelope(dsn), allowed_dsn: dsn).first).to eq(200)
  end

  it 'passes an upstream error status through' do
    stub_request(:post, upstream).to_return(status: 429, body: '')

    expect(described_class.forward(envelope(allowed_dsn), allowed_dsn: allowed_dsn).first).to eq(429)
  end

  [
    'https://otherkey@errors.example.test:8443/glitchtip/2',
    'https://fepublic@attacker.example.test:8443/glitchtip/2',
    'https://fepublic@errors.example.test:8443/glitchtip/3',
    'http://fepublic@errors.example.test:8443/glitchtip/2',
    'https://fepublic:secret@errors.example.test:8443/glitchtip/2',
    'https://errors.example.test:8443/glitchtip/2'
  ].each do |dsn|
    it "rejects #{dsn} with 403 and forwards nothing" do
      expect { described_class.forward(envelope(dsn), allowed_dsn: allowed_dsn) }
        .to raise_error(SentryTunnel::Rejected) { |e| expect(e.status).to eq(403) }
      expect(a_request(:any, /.*/)).not_to have_been_made
    end
  end

  [ 'not json', '[1]', '{"event_id":"x"}', '{"dsn":"http://[bad"}', '{"dsn":"mailto:a@b"}', '' ].each do |first_line|
    it "rejects the envelope header #{first_line.inspect} with 400" do
      expect { described_class.forward("#{first_line}\n{}", allowed_dsn: allowed_dsn) }
        .to raise_error(SentryTunnel::Rejected) { |e| expect(e.status).to eq(400) }
      expect(a_request(:any, /.*/)).not_to have_been_made
    end
  end

  it 'answers 502 when GlitchTip does not answer in time' do
    stub_request(:post, upstream).to_timeout

    expect { described_class.forward(envelope(allowed_dsn), allowed_dsn: allowed_dsn) }
      .to raise_error(SentryTunnel::Rejected) { |e| expect(e.status).to eq(502) }
  end
end
