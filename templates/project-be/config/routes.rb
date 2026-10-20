Rails.application.routes.draw do
  get '/health', to: 'health#show'
  post '/api/errors', to: 'errors#create'
  post '/admin/glitchtip_smoke/:kind', to: 'admin/glitchtip_smoke#create'

  mount Rswag::Ui::Engine => '/api-docs'
  mount Rswag::Api::Engine => '/api-docs'
end
