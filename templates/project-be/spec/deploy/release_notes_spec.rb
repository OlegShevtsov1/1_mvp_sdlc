require 'rails_helper'

RSpec.describe 'scripts/release-notes.sh' do
  let(:changelog) do
    <<~MD
      # Changelog

      All notable changes to this project are documented in this file.

      ## [Unreleased]

      ### Added

      - Something new.

      ## [0.2.0] - 2026-11-02

      ### Fixed

      - A bug.

      ## [0.1.0] - 2026-10-20

      ### Added

      - First release.
      - Second line.

      ### Security

      - Tightened a check.
    MD
  end

  def notes(*args)
    Tempfile.create([ 'CHANGELOG', '.md' ]) do |file|
      file.write(changelog)
      file.flush
      return Open3.capture3(Rails.root.join('scripts/release-notes.sh').to_s, *args, file.path)
    end
  end

  it 'prints the section of a tag exactly, without its heading and surrounding blank lines' do
    stdout, stderr, status = notes('v0.1.0')
    expect(status).to be_success, stderr
    expect(stdout).to eq("### Added\n\n- First release.\n- Second line.\n\n### Security\n\n- Tightened a check.\n")
  end

  it 'stops a section at the next version heading' do
    expect(notes('v0.2.0').first).to eq("### Fixed\n\n- A bug.\n")
  end

  it 'prints the Unreleased section' do
    expect(notes('Unreleased').first).to eq("### Added\n\n- Something new.\n")
  end

  it 'fails for a version that has no section' do
    stdout, stderr, status = notes('v0.3.0')
    expect(status.exitstatus).to eq(1)
    expect(stdout).to be_empty
    expect(stderr).to include('no section [0.3.0]')
  end

  it 'reads CHANGELOG.md of the repository by default' do
    stdout, stderr, status = Open3.capture3(Rails.root.join('scripts/release-notes.sh').to_s, 'Unreleased')
    expect(status).to be_success, stderr
    expect(stdout).to start_with("### Added\n")
  end

  describe 'CHANGELOG.md' do
    let(:text) { Rails.root.join('CHANGELOG.md').read }

    it 'follows Keep a Changelog and Semantic Versioning' do
      expect(text).to start_with("# Changelog\n")
      expect(text).to include('https://keepachangelog.com/en/1.1.0/', 'https://semver.org/spec/v2.0.0.html')
    end

    it 'keeps [Unreleased] first, with the six categories in Keep a Changelog order' do
      unreleased = text[/^## \[Unreleased\]\n(.*?)(?=^## |\z)/m, 1]
      expect(text.scan(/^## .*/).first).to eq('## [Unreleased]')
      expect(unreleased.scan(/^### (.*)$/).flatten).to eq(%w[Added Changed Deprecated Removed Fixed Security])
    end

    it 'has only vX.Y.Z version sections with a date' do
      text.scan(/^## (.*)$/).flatten.drop(1).each do |heading|
        expect(heading).to match(/\A\[(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)\] - \d{4}-\d{2}-\d{2}\z/)
      end
    end
  end
end
