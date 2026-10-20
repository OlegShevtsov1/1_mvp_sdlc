# Deliberate failures that prove a deployment's errors reach GlitchTip, each tagged with a
# marker the operator can search for.
module GlitchtipSmoke
  class Error < StandardError; end

  KINDS_IN_REQUEST = %w[unhandled manual db].freeze
  # 63 bytes is Postgres' identifier limit; the db kind uses the marker as a column name.
  MARKER_FORMAT = /\A[\w-]{1,63}\z/

  module_function

  def marker(given)
    given.to_s.match?(MARKER_FORMAT) ? given : "glitchtip-smoke-#{SecureRandom.hex(6)}"
  end

  def message(kind, marker)
    "glitchtip smoke #{kind} #{marker}"
  end
end
