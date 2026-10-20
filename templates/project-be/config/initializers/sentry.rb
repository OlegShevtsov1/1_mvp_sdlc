# Errors go to GlitchTip through the Sentry SDK. Without SENTRY_DSN the SDK is initialised but
# sends nothing, which keeps development and the test suite offline.
Sentry.init do |config|
  config.dsn = ENV['SENTRY_DSN'].presence
  config.environment = ENV.fetch('SENTRY_ENVIRONMENT') { Rails.env }
  config.release = ENV['APP_RELEASE'].presence
  config.send_default_pii = false
  config.breadcrumbs_logger = [ :active_support_logger, :http_logger ]

  # The SDK's own deny list does not know this app's filter_parameters (:email, :token, ...),
  # so every event is scrubbed with them as well.
  config.before_send = lambda do |event, _hint|
    filter = ActiveSupport::ParameterFilter.new(Rails.application.config.filter_parameters)
    if (request = event.request)
      request.data = filter.filter(request.data) if request.data.is_a?(Hash)
      request.headers = filter.filter(request.headers) if request.headers.is_a?(Hash)
      request.query_string = filter.filter(request.query_string) if request.query_string.is_a?(Hash)
    end
    event.extra = filter.filter(event.extra) if event.extra.is_a?(Hash)
    event
  end
end
