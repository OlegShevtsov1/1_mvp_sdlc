require 'net/http'

# Relays a browser SDK envelope to GlitchTip so ad blockers and the CSP only ever see this API.
# The upstream URL is derived from the one allowed DSN, never from the request, so the tunnel
# cannot be pointed at any other host. The forward authenticates with the allowed DSN's public key:
# GlitchTip, unlike Sentry Relay, does not read the DSN from the envelope header.
module SentryTunnel
  MAX_BYTES = 256 * 1024

  class Rejected < StandardError
    attr_reader :status

    def initialize(status, message)
      @status = status
      super(message)
    end
  end

  module_function

  # Returns [upstream status, upstream body].
  def forward(body, allowed_dsn:)
    allowed = Sentry::DSN.new(allowed_dsn)
    raise Rejected.new(403, 'dsn not allowed') unless same_dsn?(envelope_dsn(body), allowed)

    response = Net::HTTP.start(allowed.host, allowed.port, use_ssl: allowed.scheme == 'https',
                               open_timeout: 2, read_timeout: 5) do |http|
      http.post(allowed.envelope_endpoint, body,
                'Content-Type' => 'application/x-sentry-envelope',
                'X-Sentry-Auth' => allowed.generate_auth_header)
    end
    [ response.code.to_i, response.body.to_s ]
  rescue Net::OpenTimeout, Net::ReadTimeout, SocketError, SystemCallError, OpenSSL::SSL::SSLError
    raise Rejected.new(502, 'upstream unreachable')
  end

  def envelope_dsn(body)
    header = JSON.parse(body.to_s.lines.first.to_s)
    dsn = header.is_a?(Hash) && header['dsn']
    # Sentry::DSN cannot parse an opaque URI such as mailto:.
    unless dsn.is_a?(String) && dsn.start_with?('http://', 'https://')
      raise Rejected.new(400, 'envelope header has no http(s) dsn')
    end

    Sentry::DSN.new(dsn)
  rescue JSON::ParserError, URI::InvalidURIError
    raise Rejected.new(400, 'malformed envelope')
  end

  def same_dsn?(given, allowed)
    %i[scheme public_key secret_key host port path project_id].all? do |part|
      given.public_send(part) == allowed.public_send(part)
    end
  end
end
