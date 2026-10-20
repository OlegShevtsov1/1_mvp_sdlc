require 'byebug'
require 'simplecov'

SimpleCov.start do
  minimum_coverage_by_file 20
  add_filter '/spec/'
end

RSpec.configure do |config|
  config.expect_with :rspec do |expectations|
    expectations.include_chain_clauses_in_custom_matcher_descriptions = true
  end

  config.mock_with :rspec do |mocks|
    mocks.verify_partial_doubles = true
  end

  config.shared_context_metadata_behavior = :apply_to_host_groups
end

RSpec::Core::ExampleGroup.singleton_class.class_eval do
  def fixture_path=(path)
  end
end
