class HealthController < ApplicationController
  def show
    render json: { status: 'ok', release: ENV.fetch('APP_RELEASE') { 'unknown' } }, status: :ok
  end
end
