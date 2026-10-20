require 'active_support/core_ext/integer/time'

Rails.application.configure do
  config.enable_reloading = false
  config.eager_load = ENV['CI'].present?
  config.public_file_server.headers = { 'Cache-Control' => "public, max-age=#{1.hour.to_i}" }
  config.consider_all_requests_local = true
  config.action_controller.perform_caching = true

  if ENV['CI'] == 'true'
    config.cache_store = :memory_store
  elsif ENV['REDIS_URL']
    test_run_id = ENV['TEST_RUN_ID'] || "test_#{Time.now.to_i}"
    config.cache_store = :redis_cache_store, {
      url: ENV.fetch('REDIS_URL') { 'redis://localhost:6379/0' },
      namespace: "test_cache_#{test_run_id}",
      expires_in: 1.hour
    }
  else
    config.cache_store = :redis_cache_store, {
      url: 'redis://localhost:6379/0',
      namespace: "test_cache_#{Process.pid}",
      expires_in: 1.hour
    }
  end

  config.action_dispatch.show_exceptions = :rescuable
  config.action_controller.allow_forgery_protection = false
  config.active_storage.service = :test
  config.action_mailer.perform_caching = false
  config.action_mailer.delivery_method = :test
  config.action_mailer.default_url_options = { host: 'www.example.com' }
  config.active_support.deprecation = :stderr
  config.active_support.disallowed_deprecation = :raise
  config.active_support.disallowed_deprecation_warnings = []
  config.action_controller.raise_on_missing_callback_actions = true
end
