# Browsers may call this API only from the origins in CORS_ALLOWED_ORIGINS (comma-separated,
# e.g. https://app.dev.example.com). Read per request; unset or empty allows no origin.
# No credentials: the API authenticates with token headers, not cookies.
Rails.application.config.middleware.insert_before 0, Rack::Cors do
  allow do
    origins { |source, _env| ENV.fetch('CORS_ALLOWED_ORIGINS') { '' }.split(',').map(&:strip).include?(source) }

    resource '*',
      headers: :any,
      methods: %i[get post put patch delete options head]
  end
end
