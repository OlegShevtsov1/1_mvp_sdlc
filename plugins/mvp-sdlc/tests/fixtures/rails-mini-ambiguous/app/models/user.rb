class User < ApplicationRecord
  acts_as_paranoid

  has_many :posts, dependent: :restrict_with_exception

  validates :email, presence: true, uniqueness: true
  validates :name, presence: true
end
