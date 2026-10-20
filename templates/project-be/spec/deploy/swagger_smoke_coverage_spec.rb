require 'rails_helper'
require 'json'

# bin/swagger_smoke is the post-deploy gate, so it is only as strong as the smoke test's coverage:
# an operation added to swagger/v1/swagger.json but never checked by the script would let a deploy
# go green on a server that answers it wrongly. Both files are read as text, so this needs no
# running server.
RSpec.describe 'bin/swagger_smoke coverage of swagger/v1/swagger.json' do
  # check <name> <expected-status> <method> <path> [json-body] [extra curl args...]
  CHECK_CALL_PATTERN = /^\s*check\s+(?:'[^']*'|"[^"]*")\s+(\d+)\s+([A-Z]+)\s+(?:"([^"]+)"|(\S+))/

  # /api/v1/projects/{id} in the document and /api/v1/projects/$PROJECT_ID (or /999999) in the
  # script are the same operation; reduce every variable-looking segment to one placeholder.
  def normalize(path)
    path.split('/').map { |segment| segment.match?(/\A(\$\w+|\{[^}]+\}|\d+)\z/) ? '{}' : segment }.join('/')
  end

  def smoke_source
    File.read(Rails.root.join('bin/swagger_smoke'))
  end

  def smoke_checks
    smoke_source.scan(CHECK_CALL_PATTERN).map do |status, method, quoted_path, bare_path|
      [ method, normalize(quoted_path || bare_path), status ]
    end
  end

  def documented_checks
    paths = JSON.parse(File.read(Rails.root.join('swagger/v1/swagger.json')))['paths']
    paths.flat_map do |path, operations|
      operations.filter_map do |verb, operation|
        # A path item also carries a "parameters" array, which is not an operation.
        next unless operation.is_a?(Hash) && operation['responses']

        operation['responses'].keys.map { |code| [ verb.upcase, normalize(path), code ] }
      end.flatten(1)
    end
  end

  it 'checks every documented operation and status' do
    expect(documented_checks - smoke_checks).to be_empty
  end

  # Without this, a change to how check calls are written would silently parse to nothing and make
  # the example above pass vacuously. Duplicate triples are kept on purpose: the read-only block and
  # the full run both check the Swagger UI and JSON.
  it 'parses every check call in the script' do
    expect(smoke_checks.size).to eq(smoke_source.lines.count { |line| line.match?(/^\s*check\s/) })
  end
end
