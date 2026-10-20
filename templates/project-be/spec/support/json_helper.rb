module JsonHelper
  # Parse JSON response body into Ruby hash
  def json_response
    JSON.parse(response.body)
  end
end

RSpec.configure do |config|
  config.include JsonHelper, type: :controller
  config.include JsonHelper, type: :request
end
