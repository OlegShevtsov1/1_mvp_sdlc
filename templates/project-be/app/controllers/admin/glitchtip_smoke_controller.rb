module Admin
  # Hidden unless the caller presents SMOKE_TOKEN: every refusal is a 404, never a 401/403.
  class GlitchtipSmokeController < ApplicationController
    before_action :require_smoke_token, :require_known_kind

    def create
      case params[:kind]
      when 'unhandled'
        raise GlitchtipSmoke::Error, smoke_message
      when 'manual'
        event = Sentry.capture_message(smoke_message, level: :error)
        render json: { kind: 'manual', marker: marker, event_id: event&.event_id }, status: :accepted
      when 'db'
        connection = ActiveRecord::Base.connection
        # Postgres names an unknown column in full in its error, so the marker lands in the message.
        connection.select_value("SELECT #{connection.quote_column_name(marker)}")
      end
    end

    private

    def require_smoke_token
      expected = ENV['SMOKE_TOKEN']
      given = request.headers['X-Smoke-Token'].to_s
      head :not_found unless expected.present? && ActiveSupport::SecurityUtils.secure_compare(given, expected)
    end

    def require_known_kind
      head :not_found unless GlitchtipSmoke::KINDS_IN_REQUEST.include?(params[:kind])
    end

    def marker
      @marker ||= GlitchtipSmoke.marker(request.headers['X-Smoke-Marker'])
    end

    def smoke_message
      GlitchtipSmoke.message(params[:kind], marker)
    end
  end
end
