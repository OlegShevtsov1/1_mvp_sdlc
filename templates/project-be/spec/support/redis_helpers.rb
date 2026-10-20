module RedisHelpers
  def self.clear_test_cache
    if Rails.cache.is_a?(ActiveSupport::Cache::RedisCacheStore)
      begin
        redis = Redis.new(url: ENV.fetch('REDIS_URL') { 'redis://localhost:6379/0' })

        test_pattern = ENV['TEST_RUN_ID'] ?
          "test_cache_#{ENV['TEST_RUN_ID']}:*" :
          "test_cache_#{Process.pid}:*"

        keys = redis.keys(test_pattern)
        redis.del(*keys) if keys.any?
        puts "Cleared Redis test cache with pattern: #{test_pattern}"
      rescue => e
        puts "Error clearing Redis cache: #{e.message}"
      end
    end
  end
end

RSpec.configure do |config|
  config.before(:suite) do
    RedisHelpers.clear_test_cache
  end

  config.before(:each, :with_redis) do
    RedisHelpers.clear_test_cache
  end
end
