class Post < ApplicationRecord
  include Discard::Model

  belongs_to :user

  validates :title, :body, presence: true
end
