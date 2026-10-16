class User < ApplicationRecord
  include Discard::Model

  has_many :posts, dependent: :restrict_with_exception

  validates :email, presence: true, uniqueness: true
  validates :name, presence: true
end
