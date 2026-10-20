require 'rails_helper'

RSpec.describe 'config/project.env' do
  let(:lines) { Rails.root.join('config/project.env').readlines(chomp: true) }

  # bash sources the file (deploy/_common.sh) while the Kamal configs, the spec support and
  # Dev Deploy's GITHUB_ENV step take everything after the first '='. Only bare values read the
  # same both ways: a trailing comment, quotes or spaces would silently corrupt the latter.
  it 'holds only comment lines and NAME=value lines with bare values' do
    lines.reject { |line| line.start_with?('#') }.each do |line|
      expect(line).to match(/\A[A-Z_]+=[A-Za-z0-9._-]+\z/)
    end
  end

  it 'reads the same in bash as in the split-on-= readers' do
    script = 'set -a; . config/project.env; set +a; for name in "$@"; do printf "%s=%s\n" "$name" "${!name}"; done'
    output, status = Open3.capture2e('bash', '-c', script, '_', *project_env.keys, chdir: Rails.root)

    expect(status).to be_success, output
    expect(output.lines(chomp: true).to_h { |line| line.split('=', 2) }).to eq(project_env)
  end
end
