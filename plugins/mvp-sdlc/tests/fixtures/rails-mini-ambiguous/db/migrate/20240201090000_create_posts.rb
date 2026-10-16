class CreatePosts < ActiveRecord::Migration[7.1]
  def change
    create_table :posts do |t|
      t.references :user, null: false, foreign_key: true
      t.string :title, null: false
      t.text :body, null: false
      t.datetime :discarded_at
      t.timestamps
    end
    add_index :posts, :discarded_at
  end
end
