require 'rails_helper'

RSpec.describe 'prod workflows' do
  def load_workflow(file)
    # YAML 1.1 reads the `on:` key as true.
    YAML.load_file(Rails.root.join('.github/workflows', file)).transform_keys { |key| key == true ? 'on' : key }
  end

  def needs(job)
    Array(job['needs'])
  end

  def transitive_needs(jobs, name)
    needs(jobs.fetch(name)).flat_map { |parent| [ parent, *transitive_needs(jobs, parent) ] }.uniq
  end

  def step(job, name)
    job.fetch('steps').find { |candidate| candidate['name'] == name } || raise("no step #{name}")
  end

  let(:kamal_secrets) do
    output, status = Open3.capture2e('bash', '-c', 'source deploy/_common.sh && secret_names .kamal/secrets.prod', chdir: Rails.root)
    expect(status).to be_success
    output.split - %w[PROJECT_NAME KAMAL_REGISTRY_PASSWORD]
  end

  # Concurrency groups are shared across workflow and job level: Kamal Manage holds kamal-prod for
  # the whole run, Kamal Deploy only for its deploy job, so a rollback never waits for release-watch.
  shared_examples 'a guarded prod workflow' do |file, job_name, run_step, concurrency_job, extra_prod_jobs = []|
    let(:workflow) { load_workflow(file) }
    let(:jobs) { workflow.fetch('jobs') }
    let(:kamal_prod) { { 'group' => 'kamal-prod', 'cancel-in-progress' => false } }

    it 'shares the kamal-prod concurrency group and never cancels a running operation' do
      if concurrency_job
        expect(workflow).not_to have_key('concurrency')
        expect(jobs.fetch(concurrency_job).fetch('concurrency')).to eq(kamal_prod)
        (jobs.keys - [ concurrency_job ]).each { |name| expect(jobs.fetch(name)).not_to have_key('concurrency'), name }
      else
        expect(workflow.fetch('concurrency')).to eq(kamal_prod)
      end
    end

    it 'runs the guard first and makes every other job wait for it' do
      expect(jobs.fetch('guard')).not_to have_key('needs')
      (jobs.keys - %w[guard]).each { |name| expect(transitive_needs(jobs, name)).to include('guard'), name }
    end

    it 'keeps the prod secrets in the prod environment' do
      [ 'preflight', job_name, 'notify', *extra_prod_jobs ].each { |name| expect(jobs.fetch(name)['environment']).to eq('prod'), name }
      expect(jobs.fetch('guard')).not_to have_key('environment')
    end

    # A variable .kamal/secrets.prod reads but a step does not map would reach Kamal as an empty string.
    it 'maps every secret .kamal/secrets.prod reads, and PROD_VPN_IP, into the preflight and the run step' do
      expect(kamal_secrets).not_to be_empty
      [ step(jobs.fetch('preflight'), 'Check that every required secret is set'), step(jobs.fetch(job_name), run_step) ].each do |checked|
        (kamal_secrets + %w[PROD_VPN_IP]).each { |name| expect(checked.fetch('env')[name]).to eq("${{ secrets.#{name} }}") }
      end
    end

    it 'connects the VPN before Kamal and always disconnects it' do
      uses = jobs.fetch(job_name).fetch('steps').map { |s| s['uses'].to_s }
      up = uses.index { |u| u.end_with?('/vpn-up@env/dev') }
      down = uses.index { |u| u.end_with?('/vpn-down@env/dev') }
      run = jobs.fetch(job_name).fetch('steps').index { |s| s['name'] == run_step }

      expect([ up, run, down ]).to all(be_a(Integer))
      expect(up).to be < run
      expect(run).to be < down
      expect(jobs.fetch(job_name).fetch('steps')[down]['if']).to eq('always()')
    end

    it 'only runs Kamal through the deploy scripts and has no Kamal 1 leftovers' do
      text = Rails.root.join('.github/workflows', file).read
      expect(text).not_to match(/traefik/i)
      expect(text).not_to match(/\bkamal /)
    end
  end

  describe '.github/workflows/kamal-deploy.yml' do
    it_behaves_like 'a guarded prod workflow', 'kamal-deploy.yml', 'deploy', 'Deploy', 'deploy', %w[release-watch]

    let(:workflow) { load_workflow('kamal-deploy.yml') }
    let(:jobs) { workflow.fetch('jobs') }

    it 'takes exactly environment (prod only), version and confirm' do
      inputs = workflow.dig('on', 'workflow_dispatch', 'inputs')
      expect(inputs.keys).to eq(%w[environment version confirm])
      expect(inputs.dig('environment', 'options')).to eq(%w[prod])
    end

    it 'checks the inputs with deploy/prod_guard.sh deploy and the tag with deploy/release_tag_check.sh' do
      guard = jobs.fetch('guard')
      checkout = guard.fetch('steps').find { |s| s['uses'].to_s.start_with?('actions/checkout@') }
      tag_check = step(guard, 'Check that the version is an annotated release tag on main')

      expect(checkout.fetch('with')).to include('fetch-depth' => 0)
      expect(step(guard, 'Check the ref and the inputs')['run']).to include('deploy/prod_guard.sh deploy')
      expect(tag_check.fetch('env')).to include('TAG' => '${{ steps.inputs.outputs.tag }}')
      expect(tag_check.fetch('run')).to include('deploy/release_tag_check.sh "${TAG}"', 'GITHUB_OUTPUT')
      expect(guard.fetch('outputs')).to include('tag', 'version')
    end

    it 'deploys the tag with deploy/deploy.sh prod' do
      deploy = jobs.fetch('deploy')
      checkout = deploy.fetch('steps').find { |s| s['uses'].to_s.start_with?('actions/checkout@') }

      expect(checkout.fetch('with')).to include('fetch-depth' => 0)
      expect(deploy.fetch('env')).to include('TAG' => '${{ needs.guard.outputs.tag }}')
      expect(step(deploy, 'Deploy').fetch('run')).to eq('deploy/deploy.sh prod "${TAG}"')
    end

    describe 'release-watch' do
      let(:watch) { jobs.fetch('release-watch') }
      let(:watch_steps) { watch.fetch('steps') }

      def index(name)
        watch_steps.index { |s| s['name'] == name } || raise("no step #{name}")
      end

      it 'runs after a successful deploy, in the prod environment' do
        expect(needs(watch)).to include('deploy')
        expect(watch).not_to have_key('if')
        expect(watch.fetch('timeout-minutes')).to be_between(11, 30)
      end

      it 'watches /health before taking the VPN, and always releases it' do
        uses = watch_steps.map { |s| s['uses'].to_s }
        up = uses.index { |u| u.end_with?('/vpn-up@env/dev') }
        down = uses.index { |u| u.end_with?('/vpn-down@env/dev') }

        expect(step(watch, 'Watch /health for 10 minutes').fetch('run')).to include('deploy/release_watch.sh health')
        expect(index('Watch /health for 10 minutes')).to be < up
        expect(up).to be < index('Count new GlitchTip issues')
        expect(index('Count new GlitchTip issues')).to be < down
        expect(watch_steps[down]['if']).to eq('always()')
      end

      it 'reads GlitchTip with the token and the DSN from the prod secrets' do
        glitchtip = step(watch, 'Count new GlitchTip issues')
        expect(glitchtip.fetch('env')).to include('GLITCHTIP_API_TOKEN' => '${{ secrets.GLITCHTIP_API_TOKEN }}',
                                                  'SENTRY_DSN' => '${{ secrets.SENTRY_DSN }}')
        expect(glitchtip.fetch('run')).to include('deploy/glitchtip_issues.sh')
        expect(glitchtip['continue-on-error']).to be(true)
      end

      it 'always reports ✅ or ❌ to the prod alerts topic' do
        verdict = step(watch, 'Verdict')
        telegram = watch_steps.find { |s| s['uses'].to_s.include?('/notify-telegram@env/dev') }

        expect(verdict.fetch('run')).to include('deploy/release_watch.sh verdict')
        expect(verdict['if']).to eq('always()')
        expect(telegram['if']).to eq('always()')
        expect(telegram.dig('with', 'topic')).to eq('PROD_ALERTS')
      end

      it 'never rolls back' do
        watch_steps.each { |s| expect(s['run'].to_s).not_to include('rollback'), s['name'] }
      end
    end
  end

  describe '.github/workflows/kamal-manage.yml' do
    it_behaves_like 'a guarded prod workflow', 'kamal-manage.yml', 'manage', 'Run the action', nil

    let(:workflow) { load_workflow('kamal-manage.yml') }
    let(:jobs) { workflow.fetch('jobs') }

    it 'offers status, logs, restart, rollback and remove' do
      expect(workflow.dig('on', 'workflow_dispatch', 'inputs', 'action', 'options')).to eq(%w[status logs restart rollback remove])
    end

    it 'names each run after its action, so rollbacks can be counted' do
      expect(workflow.fetch('run-name')).to include('${{ inputs.action }}')
    end

    it 'hands the typed confirm to deploy/rollback.sh' do
      expect(step(jobs.fetch('manage'), 'Run the action').dig('env', 'CONFIRM')).to eq('${{ inputs.confirm }}')
    end

    it 'puts remove behind a backup gate that fails until it exists' do
      gate = jobs.fetch('backup-gate')
      expect(gate['if']).to include("'remove'")
      expect(gate.fetch('steps').last['run']).to match(/exit 1\s*\z/)
    end

    it 'runs manage only after the backup gate and hands its result to deploy/manage.sh' do
      manage = jobs.fetch('manage')
      expect(needs(manage)).to include('backup-gate')
      expect(manage['if']).to include("needs.backup-gate.result == 'success' || needs.backup-gate.result == 'skipped'")
      expect(step(manage, 'Run the action').dig('env', 'BACKUP_GATE')).to eq('${{ needs.backup-gate.outputs.passed }}')
    end
  end
end
