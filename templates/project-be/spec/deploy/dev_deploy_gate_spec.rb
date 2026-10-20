require 'rails_helper'

RSpec.describe 'deploy/dev_deploy_gate.sh' do
  def run(name, id:, status: 'completed', conclusion: 'success', updated_at: '2026-10-14T10:00:00Z')
    { name: name, id: id, status: status, conclusion: conclusion, updated_at: updated_at }
  end

  # Yields the parsed key=value lines the gate prints for GITHUB_OUTPUT.
  def gate(runs, trigger:)
    Dir.mktmpdir do |root|
      File.write(File.join(root, 'runs.json'), { workflow_runs: runs }.to_json)
      write_executable(File.join(root, 'gh'), <<~SH)
        #!/usr/bin/env bash
        echo "$*" > "#{root}/gh.argv"
        cat "#{root}/runs.json"
      SH
      env = { 'PATH' => "#{root}:#{ENV.fetch('PATH')}", 'GH_REPO' => 'owner/repo', 'HEAD_SHA' => 'abc', 'TRIGGER_RUN_ID' => trigger.to_s }
      output, status = Open3.capture2e(env, Rails.root.join('deploy/dev_deploy_gate.sh').to_s)
      expect(status).to be_success, output
      expect(File.read(File.join(root, 'gh.argv'))).to include('repos/owner/repo/actions/runs?head_sha=abc&event=push')
      return output.lines(chomp: true).to_h { |line| line.split('=', 2) }
    end
  end

  it 'waits while only one of the two workflows has run' do
    result = gate([ run('Rails Tests', id: 1) ], trigger: 1)

    expect(result['deploy']).to eq('false')
    expect(result['reason']).to start_with('waiting')
  end

  it 'waits while the other workflow is still running' do
    result = gate([ run('Rails Tests', id: 1), run('Rails CI', id: 2, status: 'in_progress', conclusion: nil) ], trigger: 1)

    expect(result).to include('deploy' => 'false', 'reason' => 'waiting: Rails CI not completed yet')
  end

  it 'does not deploy when one workflow failed' do
    result = gate([ run('Rails Tests', id: 1, conclusion: 'failure'), run('Rails CI', id: 2) ], trigger: 2)

    expect(result).to include('deploy' => 'false', 'reason' => 'not deploying: Rails Tests is failure')
  end

  it 'deploys from the trigger of the later-finished workflow only' do
    runs = [
      run('Rails Tests', id: 1, updated_at: '2026-10-14T10:05:00Z'),
      run('Rails CI', id: 2, updated_at: '2026-10-14T10:03:00Z'),
      run('Dev Deploy', id: 3, updated_at: '2026-10-14T10:06:00Z')
    ]

    expect(gate(runs, trigger: 1)).to include('deploy' => 'true')
    expect(gate(runs, trigger: 2)).to include('deploy' => 'false', 'reason' => 'skipped: both green, the Rails Tests trigger deploys')
  end

  it 'breaks an updated_at tie by the higher run id' do
    runs = [ run('Rails Tests', id: 7), run('Rails CI', id: 8) ]

    expect(gate(runs, trigger: 8)).to include('deploy' => 'true')
    expect(gate(runs, trigger: 7)).to include('deploy' => 'false')
  end

  it 'judges each workflow by its newest run' do
    runs = [
      run('Rails Tests', id: 1, conclusion: 'failure'),
      run('Rails Tests', id: 5, updated_at: '2026-10-14T10:09:00Z'),
      run('Rails CI', id: 2)
    ]

    expect(gate(runs, trigger: 5)).to include('deploy' => 'true')
  end
end
