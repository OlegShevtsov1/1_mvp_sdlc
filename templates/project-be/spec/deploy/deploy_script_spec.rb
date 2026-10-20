require 'rails_helper'

RSpec.describe 'deploy/deploy.sh' do
  let(:version) { "sha-#{DeploySandbox::SHA}" }
  let(:zone) { project_env.fetch('PROJECT_ZONE') }
  let(:service) { "#{project_env.fetch('PROJECT_NAME')}-dev" }

  def kamal_calls(root)
    sandbox_log(root, 'bundle.log').lines(chomp: true)
  end

  it 'refuses an unknown destination' do
    run_script('deploy.sh', 'staging') do |output, status|
      expect(status.exitstatus).to eq(2)
      expect(output).to include("unknown destination 'staging' (supported: dev, prod)")
    end
  end

  it 'refuses to run without DEV_HOST' do
    run_script('deploy.sh', 'dev', env: { 'DEV_HOST' => nil }) do |output, status|
      expect(status.exitstatus).to eq(2)
      expect(output).to include('DEV_HOST is not set')
    end
  end

  it 'refuses a version that is not sha-<40 hex>' do
    run_script('deploy.sh', 'dev', 'latest') do |output, status, root|
      expect(status.exitstatus).to eq(2)
      expect(output).to include("version 'latest' is not sha-<40 hex git sha>")
      expect(kamal_calls(root)).to be_empty
    end
  end

  it 'names a missing secret before touching the server' do
    run_script('deploy.sh', 'dev', env: { 'SMOKE_TOKEN' => '' }) do |output, status, root|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('SMOKE_TOKEN is not set')
      expect(kamal_calls(root)).to be_empty
    end
  end

  it 'refuses a POSTGRES_PASSWORD that would break DATABASE_URL before touching the server' do
    run_script('deploy.sh', 'dev', env: { 'POSTGRES_PASSWORD' => 'bad/pass@word' }) do |output, status, root|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('POSTGRES_PASSWORD must be URL-safe')
      expect(kamal_calls(root)).to be_empty
    end
  end

  it 'sets up a first deployment of the HEAD image without building or pushing' do
    run_script('deploy.sh', 'dev') do |_output, status, root|
      expect(status).to be_success
      expect(kamal_calls(root).last).to eq("exec kamal setup --skip-push --version #{version} -c config/deploy.dev.yml")
    end
  end

  it 'deploys over an existing deployment' do
    run_script('deploy.sh', 'dev', version, containers: "#{service}-web-sha-#{'b' * 40}\n") do |_output, status, root|
      expect(status).to be_success
      expect(kamal_calls(root).last).to eq("exec kamal deploy --skip-push --version #{version} -c config/deploy.dev.yml")
    end
  end

  it 'stops instead of running setup when it cannot list the containers on the host' do
    run_script('deploy.sh', 'dev', version, files: { 'containers.fail' => '' }) do |output, status, root|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('could not list the containers')
      expect(kamal_calls(root)).not_to include(/kamal (setup|deploy)/)
    end
  end

  it 'never removes anything or touches the shared proxy' do
    run_script('deploy.sh', 'dev', containers: "#{service}-web-sha-#{'b' * 40}\n") do |_output, _status, root|
      expect(kamal_calls(root)).not_to include(/remove|proxy/)
    end
  end

  it 'checks health through the shared proxy with the dev Host, as if behind TLS' do
    run_script('deploy.sh', 'dev') do |_output, _status, root|
      expect(sandbox_log(root, 'curl.log')).to include(
        "--connect-to dev.#{zone}:80:192.0.2.10:8091 -H X-Forwarded-Proto: https -fsS --max-time 5 http://dev.#{zone}/health"
      )
    end
  end

  it 'fails before the smoke test while /health reports another release' do
    run_script('deploy.sh', 'dev', release: 'b' * 40) do |output, status, root|
      expect(status.exitstatus).to eq(1)
      expect(output).to include("did not report release #{DeploySandbox::SHA}")
      expect(sandbox_log(root, 'smoke.log')).to be_empty
    end
  end

  it 'smoke-tests the dev host through the proxy and succeeds' do
    run_script('deploy.sh', 'dev') do |output, status, root|
      expect(status).to be_success
      expect(output).to include('Smoke test passed')
      expect(sandbox_log(root, 'smoke.log').strip).to eq(
        "http://dev.#{zone} SMOKE_CONNECT_TO=dev.#{zone}:80:192.0.2.10:8091 SMOKE_FORWARDED_PROTO=https SMOKE_READ_ONLY="
      )
    end
  end

  it 'fails the deploy when the smoke test fails' do
    run_script('deploy.sh', 'dev', env: { 'SMOKE_SHIM_FAILS' => '1' }) do |output, status|
      expect(status.exitstatus).to eq(1)
      expect(output).to include('swagger smoke test failed')
    end
  end

  it 'skips the smoke test only for SKIP_SMOKE=1' do
    run_script('deploy.sh', 'dev', env: { 'SKIP_SMOKE' => '1' }) do |output, status, root|
      expect(status).to be_success
      expect(output).to include('SKIP_SMOKE=1: skipping the swagger smoke test')
      expect(sandbox_log(root, 'smoke.log')).to be_empty
    end

    run_script('deploy.sh', 'dev', env: { 'SKIP_SMOKE' => 'false' }) do |_output, _status, root|
      expect(sandbox_log(root, 'smoke.log')).not_to be_empty
    end
  end

  it 'derives the ECR registry from the AWS account and shows the account id only to mask it in Actions' do
    run_script('deploy.sh', 'dev', env: { 'GITHUB_ACTIONS' => 'true' }) do |output, status|
      expect(status).to be_success
      account_lines = output.lines.grep(/#{DeploySandbox::ACCOUNT_ID}/o)
      expect(account_lines).to eq([ "::add-mask::#{DeploySandbox::ACCOUNT_ID}\n" ])
      expect(output).to include("::add-mask::ecr-password-from-shim\n")
    end
  end

  it 'prints neither the account id nor the registry password outside Actions' do
    run_script('deploy.sh', 'dev') do |output|
      expect(output).not_to include(DeploySandbox::ACCOUNT_ID)
      expect(output).not_to include('ecr-password-from-shim')
    end
  end

  context 'with the prod destination' do
    let(:name) { project_env.fetch('PROJECT_NAME') }
    let(:prod_version) { "prod-sha-#{DeploySandbox::SHA}" }
    let(:prod_env) { { 'PROD_VPN_IP' => '192.0.2.70', 'KAMAL_REGISTRY_SERVER' => 'registry.example.test' } }
    let(:repo) { "registry.example.test/#{name}" }
    let(:promoted_digest) { "sha256:prod#{version}" }

    def crane_calls(root)
      sandbox_log(root, 'crane.log').lines(chomp: true)
    end

    def run_prod(tag = 'v0.1.0', files: {}, **options, &block)
      run_script('deploy.sh', 'prod', tag, env: prod_env, files: dev_image_files.merge(files), **options, &block)
    end

    it 'refuses anything but a release tag vX.Y.Z before touching anything' do
      [ [], [ version ], [ DeploySandbox::SHA ], [ 'v1.2' ] ].each do |args|
        run_script('deploy.sh', 'prod', *args, env: prod_env, files: dev_image_files) do |output, status, root|
          expect(status.exitstatus).to eq(2), args.inspect
          expect(output).to include('is not a release tag vX.Y.Z')
          expect(kamal_calls(root)).to be_empty
          expect(crane_calls(root)).to be_empty
        end
      end
    end

    {
      'a lightweight tag' => [ { 'tag-type' => "commit\n" }, 'lightweight' ],
      'a tag on a commit that is not on main' => [ { 'not-on-main' => '' }, 'not on main' ],
      'a tag that is not published on origin' => [ { 'tag-fetch.fail' => '' }, 'not published' ]
    }.each do |what, (files, message)|
      it "refuses #{what} before touching anything" do
        run_prod(files: files) do |output, status, root|
          expect(status.exitstatus).to eq(1)
          expect(output).to include(message)
          expect(kamal_calls(root)).to be_empty
          expect(crane_calls(root)).to be_empty
        end
      end
    end

    it 'checks the tag as published on origin, together with main' do
      run_prod do |output, status, root|
        expect(status).to be_success, output
        expect(sandbox_log(root, 'git.log')).to include('+refs/tags/v0.1.0:refs/tags/v0.1.0', '+refs/heads/main:refs/remotes/origin/main')
      end
    end

    it 'refuses to run without PROD_VPN_IP before touching anything' do
      run_script('deploy.sh', 'prod', 'v0.1.0', env: prod_env.merge('PROD_VPN_IP' => nil)) do |output, status, root|
        expect(status.exitstatus).to eq(2)
        expect(output).to include('PROD_VPN_IP is not set')
        expect(kamal_calls(root)).to be_empty
        expect(crane_calls(root)).to be_empty
      end
    end

    it 'sets up a first deployment of the promoted image with the prod config' do
      run_prod do |output, status, root|
        expect(status).to be_success, output
        expect(crane_calls(root)).to include("mutate #{repo}:#{version} --label service=#{name} -t #{repo}:#{prod_version}")
        expect(kamal_calls(root).last).to eq("exec kamal setup --skip-push --version #{prod_version} -c config/deploy.yml")
      end
    end

    it 'deploys over an existing deployment' do
      run_prod(containers: "#{name}-web-prod-sha-#{'b' * 40}\n") do |_output, status, root|
        expect(status).to be_success
        expect(kamal_calls(root).last).to eq("exec kamal deploy --skip-push --version #{prod_version} -c config/deploy.yml")
      end
    end

    it 'stops instead of running setup on prod when it cannot list the containers' do
      run_prod(files: { 'containers.fail' => '' }) do |output, status, root|
        expect(status.exitstatus).to eq(1)
        expect(output).to include('could not list the containers')
        expect(kamal_calls(root)).not_to include(/kamal (setup|deploy)/)
        expect(crane_calls(root).grep(/\Atag /)).to be_empty
      end
    end

    it 'never removes anything or touches the proxy' do
      run_prod(containers: "#{name}-web-prod-sha-#{'b' * 40}\n") do |_output, _status, root|
        expect(kamal_calls(root)).not_to include(/remove|proxy/)
      end
    end

    it 'checks health on the public HTTPS URL, without going around DNS' do
      run_prod do |_output, _status, root|
        expect(sandbox_log(root, 'curl.log').lines(chomp: true).uniq).to eq([ "-fsS --max-time 5 https://#{zone}/health" ])
      end
    end

    it 'runs the read-only smoke test against the public HTTPS URL' do
      run_prod do |output, status, root|
        expect(status).to be_success
        expect(output).to include('Smoke test passed')
        expect(sandbox_log(root, 'smoke.log').strip).to eq(
          "https://#{zone} SMOKE_CONNECT_TO= SMOKE_FORWARDED_PROTO= SMOKE_READ_ONLY=1"
        )
      end
    end

    it 'points prod-current at the new image and the replaced one at prod-previous' do
      digests = "#{dev_image_files.fetch('digests')}prod-current sha256:older\n"
      run_prod(files: { 'digests' => digests }) do |_output, status, root|
        expect(status).to be_success
        expect(crane_calls(root).grep(/\Atag /)).to eq([
          "tag #{repo}@sha256:older prod-previous",
          "tag #{repo}@#{promoted_digest} prod-current"
        ])
      end
    end

    it 'leaves the tags alone when prod-current already is the new image' do
      digests = "#{dev_image_files.fetch('digests')}#{prod_version} #{promoted_digest}\nprod-current #{promoted_digest}\n"
      prod_files = {
        'digests' => digests,
        "manifest-#{prod_version}.json" => dev_image_files.fetch("manifest-#{version}.json"),
        "config-#{prod_version}.json" => dev_image_files.fetch("config-#{version}.json").sub("#{name}-dev", name)
      }
      run_prod(files: prod_files) do |_output, status, root|
        expect(status).to be_success
        expect(crane_calls(root).grep(/\A(tag|mutate) /)).to be_empty
      end
    end

    it 'sets only prod-current on the very first deploy' do
      run_prod do |_output, _status, root|
        expect(crane_calls(root).grep(/\Atag /)).to eq([ "tag #{repo}@#{promoted_digest} prod-current" ])
      end
    end

    it 'moves no tag when the new release never becomes healthy' do
      run_prod(release: 'b' * 40) do |_output, status, root|
        expect(status.exitstatus).to eq(1)
        expect(crane_calls(root).grep(/\Atag /)).to be_empty
      end
    end

    it 'moves no tag when the smoke test fails' do
      run_script('deploy.sh', 'prod', 'v0.1.0', env: prod_env.merge('SMOKE_SHIM_FAILS' => '1'), files: dev_image_files) do |_output, status, root|
        expect(status.exitstatus).to eq(1)
        expect(crane_calls(root).grep(/\Atag /)).to be_empty
      end
    end

    it 'refuses a version that Dev Deploy never built, before touching the server' do
      run_prod(files: { 'digests' => '' }) do |output, status, root|
        expect(status.exitstatus).to eq(1)
        expect(output).to include("#{name}:#{version} is not in ECR (build it with Dev Deploy first)")
        expect(kamal_calls(root)).to be_empty
      end
    end
  end
end
