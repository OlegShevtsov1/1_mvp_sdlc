# POST /api/errors: the frontend's Sentry tunnel (see SentryTunnel).
class ErrorsController < ApplicationController
  # RATE_LIMIT requests per client IP per minute, counted before the action runs, so accepted,
  # refused-DSN and too-large requests all count. Every request is counted both in Rails.cache (Redis,
  # shared across deploys) and in this process's memory, and the higher count wins: when Redis fails
  # its failsafe answers nil, which rate_limit would read as "not limited", and when it drops or
  # recovers mid-window neither counter starts over. The memory count is exact only while Puma runs a
  # single process.
  RATE_LIMIT = 30

  module RateLimitStore
    FALLBACK = ActiveSupport::Cache::MemoryStore.new

    def self.increment(name, amount = 1, **options)
      fallback_count = FALLBACK.increment(name, amount, **options)
      [ Rails.cache.increment(name, amount, **options), fallback_count ].compact.max
    end
  end

  rate_limit to: RATE_LIMIT, within: 1.minute, by: -> { request.remote_ip }, store: RateLimitStore

  def create
    allowed_dsn = ENV['SENTRY_ALLOWED_FE_DSN']
    return head :not_found if allowed_dsn.blank?

    body = read_body
    return head :content_too_large if body.nil?

    status, upstream_body = SentryTunnel.forward(body, allowed_dsn: allowed_dsn)
    render body: upstream_body, status: status, content_type: 'application/json'
  rescue SentryTunnel::Rejected => e
    render json: { error: e.message }, status: e.status
  end

  private

  # nil when the body exceeds SentryTunnel::MAX_BYTES, whatever Content-Length claims.
  def read_body
    return nil if request.content_length.to_i > SentryTunnel::MAX_BYTES

    body = request.body.read(SentryTunnel::MAX_BYTES + 1).to_s
    body.bytesize > SentryTunnel::MAX_BYTES ? nil : body
  end
end
