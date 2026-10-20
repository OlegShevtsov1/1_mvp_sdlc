require 'rails_helper'

# The self-hosted runner VM hosts several runners, so two jobs with service containers can run at
# the same time; a fixed host port makes the second one fail with "port is already allocated".
RSpec.describe 'CI service containers' do
  postgres_port = "${{ job.services.postgres.ports['5432'] }}"
  redis_port = "${{ job.services.redis.ports['6379'] }}"
  workflows_dir = Rails.root.join('.github/workflows')

  def load_workflow(file)
    # YAML 1.1 reads the `on:` key as true.
    YAML.load_file(Rails.root.join('.github/workflows', file)).transform_keys { |key| key == true ? 'on' : key }
  end

  def step(job, name)
    job.fetch('steps').find { |candidate| candidate['name'] == name } || raise("no step #{name}")
  end

  {{PROJECT_NAME}}_test_env = {
    'DATABASE_URL' => "postgres://postgres:postgres@localhost:#{postgres_port}/{{PROJECT_NAME}}_test",
    'REDIS_URL' => "redis://localhost:#{redis_port}/0"
  }
  github_actions_database_url = "postgres://postgres:password@localhost:#{postgres_port}/github-actions"

  wiring = {
    [ 'rails-test.yml', 'test' ] => { [ 'Setup DB', 'RSpec' ] => {{PROJECT_NAME}}_test_env },
    [ 'tdd-check.yml', 'red' ] => { [ 'Setup DB', 'RSpec on the test commit' ] => {{PROJECT_NAME}}_test_env },
    [ 'rails-lint.yml', 'test' ] => {
      [ 'Check Redis connection' ] => { 'REDIS_PORT' => redis_port },
      [ 'Set Up Database', 'Run RSpec' ] => {
        'DATABASE_URL' => github_actions_database_url,
        'REDIS_URL' => "redis://localhost:#{redis_port}/0"
      }
    },
    [ 'manual-rails-ci.yml', 'test' ] => {
      [ 'Check Redis connection' ] => { 'REDIS_PORT' => redis_port },
      [ 'Set Up Database', 'Run RSpec' ] => {
        'DATABASE_URL' => github_actions_database_url,
        'REDIS_URL' => "${{ github.event.inputs.with_redis == 'true' && " \
                       "format('redis://localhost:{0}/0', job.services.redis.ports['6379']) || '' }}"
      }
    }
  }

  it 'publishes every service container on a host port Docker picks' do
    service_jobs = workflows_dir.glob('*.yml').sort.flat_map do |path|
      load_workflow(path.basename).fetch('jobs').filter_map do |name, job|
        next unless job['services']

        job['services'].each do |service, config|
          Array(config['ports']).each do |port|
            expect(port.to_s).to match(/\A\d+\z/), "#{path.basename}/#{name}/#{service}: #{port}"
          end
        end
        [ path.basename.to_s, name ]
      end
    end

    expect(service_jobs).to match_array(wiring.keys)
  end

  it 'points the database and Redis steps at the mapped ports' do
    wiring.each do |(file, job_name), steps|
      job = load_workflow(file).fetch('jobs').fetch(job_name)
      steps.each do |names, env|
        names.each do |name|
          expect(step(job, name).fetch('env') { {} }).to include(env), "#{file}/#{job_name}/#{name}"
        end
      end
    end
  end

  it 'pings Redis on the mapped port' do
    %w[rails-lint.yml manual-rails-ci.yml].each do |file|
      ping = step(load_workflow(file).dig('jobs', 'test'), 'Check Redis connection')
      expect(ping.fetch('run')).to include('-p "${REDIS_PORT}"'), file
    end
  end

  it 'leaves no fixed localhost service port in any workflow' do
    workflows_dir.glob('*.yml').each do |path|
      expect(path.readlines.grep(/localhost:(5432|6379)\b/)).to be_empty, path.basename.to_s
    end

    expect(load_workflow('rails-test.yml').fetch('env')).not_to include('DATABASE_URL', 'REDIS_URL')
    expect(load_workflow('tdd-check.yml').dig('jobs', 'red', 'env')).not_to include('DATABASE_URL', 'REDIS_URL')
  end
end
