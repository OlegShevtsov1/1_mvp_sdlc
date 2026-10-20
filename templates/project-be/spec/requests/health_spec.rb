require 'rails_helper'

RSpec.describe 'GET /health' do
  it 'reports the release baked into the image so a deploy can prove the new version answers' do
    with_env('APP_RELEASE' => '0123abcd') { get '/health' }

    expect(response).to have_http_status(:ok)
    expect(response.parsed_body).to eq('status' => 'ok', 'release' => '0123abcd')
  end

  it 'reports an unknown release outside a built image' do
    with_env('APP_RELEASE' => nil) { get '/health' }

    expect(response.parsed_body).to eq('status' => 'ok', 'release' => 'unknown')
  end
end
