namespace :glitchtip do
  desc 'Send a marked error from outside any request (GLITCHTIP_SMOKE_MARKER sets the marker)'
  task :smoke, [ :kind ] => :environment do |_task, args|
    kind = args[:kind] || 'rake'
    abort "glitchtip:smoke: only 'rake' runs outside a request, got '#{kind}'" unless kind == 'rake'

    marker = GlitchtipSmoke.marker(ENV['GLITCHTIP_SMOKE_MARKER'])
    event = Sentry.capture_exception(GlitchtipSmoke::Error.new(GlitchtipSmoke.message(kind, marker)))
    puts "glitchtip:smoke rake marker=#{marker} event_id=#{event&.event_id || 'none'}"
    # A one-shot process exits right after this; close flushes the queued event first.
    Sentry.close
  end
end
