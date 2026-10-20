module EnvHelper
  # Sets (or, with nil, unsets) environment variables for the duration of the block.
  def with_env(vars)
    saved = vars.keys.index_with { |key| ENV[key] }
    vars.each { |key, value| ENV[key] = value }
    yield
  ensure
    saved.each { |key, value| ENV[key] = value }
  end
end

RSpec.configure do |config|
  config.include EnvHelper
end
