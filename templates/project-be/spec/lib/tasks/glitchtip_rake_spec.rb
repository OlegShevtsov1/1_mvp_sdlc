require 'rails_helper'
require 'rake'

RSpec.describe 'rake glitchtip:smoke' do
  include Sentry::TestHelper

  before(:all) do
    Rails.application.load_tasks unless Rake::Task.task_defined?('glitchtip:smoke')
  end

  before do
    setup_sentry_test
    # Closing would tear the SDK down for the rest of the suite.
    allow(Sentry).to receive(:close)
    Rake::Task['glitchtip:smoke'].reenable
  end

  after { teardown_sentry_test }

  it 'reports an exception carrying the marker and flushes before exiting' do
    expect do
      with_env('GLITCHTIP_SMOKE_MARKER' => 'rake-spec-marker') { Rake::Task['glitchtip:smoke'].invoke }
    end.to output(/glitchtip:smoke rake marker=rake-spec-marker event_id=\h{32}/).to_stdout

    exception = extract_sentry_exceptions(last_sentry_event).last
    expect(exception.type).to eq('GlitchtipSmoke::Error')
    expect(exception.value).to start_with('glitchtip smoke rake rake-spec-marker')
    expect(Sentry).to have_received(:close)
  end

  it 'refuses kinds that need a request' do
    expect { Rake::Task['glitchtip:smoke'].invoke('unhandled') }
      .to raise_error(SystemExit).and output(/only 'rake' runs outside a request/).to_stderr
    expect(sentry_events).to be_empty
  end
end
