require 'rails_helper'

RSpec.describe 'bin/release' do
  around do |example|
    in_git_repo do
      Dir.mktmpdir do |fake|
        @fake = fake
        example.run
      end
    end
  end

  # gh, Kamal Deploy and Kamal Manage included: bin/release reaches Kamal only by dispatching those workflows.
  # Every call goes to calls.log in order. PRs live in prs.json; `pr merge` merges develop into main on the bare
  # origin with a merge commit. Runs: 1 release.yml, 2 kamal-deploy.yml, 3 kamal-manage.yml; run-<id>.rc fails one,
  # dispatch-<workflow>.rc fails its `workflow run`.
  let(:gh_shim) do
    <<~'SH'
      #!/usr/bin/env bash
      echo "gh $*" >> "$FAKE/calls.log"
      arg() { local want=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
      prs() { cat "$FAKE/prs.json" 2>/dev/null || echo '[]'; }
      case "$1 $2" in
        'repo view') echo '{"nameWithOwner":"Owner/app"}' ;;
        'auth token') echo mirror-token ;;
        'variable get') cat "$FAKE/runs_on" ;;
        'pr list') prs ;;
        'pr create')
          n=$(( $(prs | jq length) + 10 ))
          cp "$(arg --body-file "$@")" "$FAKE/pr-$n.md"
          prs | jq -c --argjson n "$n" --arg t "$(arg --title "$@")" '. + [{number: $n, state: "OPEN", title: $t}]' > "$FAKE/prs.new"
          mv "$FAKE/prs.new" "$FAKE/prs.json" ;;
        'pr checks') exit "$(cat "$FAKE/checks.rc" 2>/dev/null || echo 0)" ;;
        'pr merge')
          clone=$(mktemp -d)
          git clone -q -b main "$FAKE/origin.git" "$clone"
          git -C "$clone" merge -q --no-ff origin/develop -m "Merge pull request #$3 from Owner/develop"
          git -C "$clone" push -q origin main
          prs | jq -c --argjson n "$3" --arg m "$(git -C "$clone" rev-parse HEAD)" \
            'map(if .number == $n then .state = "MERGED" | .mergeCommit = {oid: $m} else . end)' > "$FAKE/prs.new"
          mv "$FAKE/prs.new" "$FAKE/prs.json" ;;
        'pr view') prs | jq -c --argjson n "$3" 'first(.[] | select(.number == $n))' ;;
        'run list')
          case "$(arg --workflow "$@")" in
            release.yml) id=1 event=push ;;
            kamal-deploy.yml) id=2 event=workflow_dispatch ;;
            *) id=3 event=workflow_dispatch ;;
          esac
          jq -nc --argjson id "$id" --arg event "$event" --arg sha "$(git rev-parse origin/develop)" \
            --arg at "$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
            '[{databaseId: $id, headSha: $sha, event: $event, createdAt: $at, url: "https://github.example/runs/\($id)"}]' ;;
        'run watch') exit "$(cat "$FAKE/run-$3.rc" 2>/dev/null || echo 0)" ;;
        'workflow run') exit "$(cat "$FAKE/dispatch-$3.rc" 2>/dev/null || echo 0)" ;;
      esac
    SH
  end

  # Answers from the lines of `answers` in order; the last line answers every later call.
  let(:curl_shim) do
    <<~'SH'
      #!/usr/bin/env bash
      echo "curl $*" >> "$FAKE/calls.log"
      head -n 1 "$FAKE/answers"
      if [ "$(wc -l < "$FAKE/answers")" -gt 1 ]; then sed -i 1d "$FAKE/answers"; fi
    SH
  end

  let(:stub) { ->(name) { "#!/usr/bin/env bash\necho \"#{name} SMOKE_READ_ONLY=${SMOKE_READ_ONLY:-} $*\" >> \"$FAKE/calls.log\"\n" } }

  let(:unreleased) { File.read(Rails.root.join('CHANGELOG.md')) }
  let(:with_entry) { unreleased.sub("### Added\n", "### Added\n\n- Widgets (APP-2)\n") }
  let(:released) { "#{unreleased}\n## [0.2.0] - 2026-11-01\n\n### Added\n\n- Widgets (APP-2)\n" }

  def write(path, content, mode = 0o644)
    full = File.join(@repo, path)
    FileUtils.mkdir_p(File.dirname(full))
    File.write(full, content)
    File.chmod(mode, full)
  end

  # A project at v0.1.0 on main, then on develop a feature (`feature_files`) and, unless `prep_subject` is nil, its
  # release-prep squash; pushed to a bare origin. Returns D, the head of develop.
  def project(prep_subject: 'APP-7: Release 0.2.0 changelog (#9)', feature_files: {})
    write('config/project.env', "PROJECT_NAME=app\nPROJECT_ZONE=app.example.test\n")
    write('CHANGELOG.md', unreleased)
    %w[scripts/next-version.sh scripts/release-notes.sh bin/pr-conventions-check].each do |script|
      write(script, File.read(Rails.root.join(script)), 0o755)
    end
    %w[kamal-deploy.yml kamal-manage.yml].each do |workflow|
      write(".github/workflows/#{workflow}", File.read(Rails.root.join('.github/workflows', workflow)))
    end
    write('bin/wait-dev-deploy', stub.call('wait-dev-deploy'), 0o755)
    write('bin/swagger_smoke', "#{stub.call('swagger_smoke')}exit \"$(cat \"$FAKE/smoke.rc\" 2>/dev/null || echo 0)\"\n", 0o755)
    @v010 = commit('Bootstrap')
    annotated_tag('v0.1.0')
    git('switch', '-q', '-c', 'develop')
    squash('APP-2: widgets (#2)', 'feat', { 'CHANGELOG.md' => with_entry }.merge(feature_files))
    squash(prep_subject, 'docs', { 'CHANGELOG.md' => released }) if prep_subject
    git('init', '-q', '--bare', origin)
    git('remote', 'add', 'origin', origin)
    git('push', '-q', 'origin', 'main', 'develop', '--tags')
    File.write(File.join(@fake, 'runs_on'), "ubuntu-24.04\n")
    git('rev-parse', 'HEAD')
  end

  def origin = File.join(@fake, 'origin.git')

  def health(*releases)
    File.write(File.join(@fake, 'answers'), releases.map { |r| "{\"status\":\"ok\",\"release\":\"#{r}\"}\n" }.join)
  end

  def release(*args, env: {})
    bin = File.join(@fake, 'bin')
    FileUtils.mkdir_p(bin)
    { 'gh' => gh_shim, 'curl' => curl_shim }.each do |name, body|
      File.write(File.join(bin, name), body)
      File.chmod(0o755, File.join(bin, name))
    end
    run_in_repo3('bin/release', *args,
                 env: { 'PATH' => "#{bin}:#{ENV.fetch('PATH')}", 'FAKE' => @fake, 'RELEASE_POLL_INTERVAL' => '0' }.merge(env))
  end

  def calls = File.exist?(File.join(@fake, 'calls.log')) ? File.readlines(File.join(@fake, 'calls.log'), chomp: true) : []

  # Asserts the calls matching `patterns` appear in this order and returns their positions.
  def expect_in_order(*patterns)
    positions = patterns.map do |pattern|
      calls.index { |c| c.match?(pattern) }.tap { |i| expect(i).not_to be_nil, "no call matches #{pattern}:\n#{calls.join("\n")}" }
    end
    expect(positions).to eq(positions.sort)
  end

  def writes = calls.grep(/^gh (pr create|pr merge|workflow run|release edit)|^wait-dev-deploy/)

  it 'ship runs the steps in order with fake gh/kamal' do
    d = project
    health(d)

    stdout, stderr, status = release('ship', 'v0.2.0')

    expect(status.exitstatus).to eq(0), stderr
    expect(stdout.lines.last).to eq("shipped: v0.2.0 #{d}\n")
    expect_in_order(/^wait-dev-deploy SMOKE_READ_ONLY= #{d}$/,
                    /^gh pr create -R Owner\/app --base main --head develop --title APP-7: Release v0\.2\.0 /,
                    /^gh pr checks 10 /,
                    /^gh pr merge 10 -R Owner\/app --merge --match-head-commit #{d}$/,
                    /^gh run watch 1 /,
                    /^gh workflow run kamal-deploy\.yml -R Owner\/app --ref main -f environment=prod -f version=v0\.2\.0 -f confirm=prod$/,
                    /^gh run watch 2 /,
                    %r{^curl .*https://app\.example\.test/health$},
                    %r{^swagger_smoke SMOKE_READ_ONLY=1 https://app\.example\.test$},
                    /^gh release edit v0\.2\.0 -R Owner\/app --draft=false$/)
    body = File.read(File.join(@fake, 'pr-10.md'))
    expect(body).to include("## Changelog\n\n### Added\n\n- Widgets (APP-2)\n").and end_with("Type: chore\n")
    expect(git('cat-file', '-t', 'v0.2.0', chdir: origin)).to eq('tag')
    expect(git('rev-parse', 'v0.2.0^{commit}', chdir: origin)).to eq(d)
    expect(git('rev-parse', 'main^2', chdir: origin)).to eq(d)
  end

  def with_target(workflow)
    File.read(Rails.root.join('.github/workflows', workflow))
        .sub("    inputs:\n", "    inputs:\n      target:\n        type: choice\n        options: [aws, srv]\n")
  end

  def fail_with(file) = File.write(File.join(@fake, file), "1\n")

  # Asserts the red path printed `red_line`, rolled prod back to v0.1.0 and published nothing.
  def expect_rolled_back(stdout, stderr, status, red_line)
    expect(status.exitstatus).to eq(3), stderr
    expect(stdout).to include("#{red_line}\n").and include("rolled back: v0.1.0 #{@v010}\n")
    expect_in_order(/^gh workflow run kamal-deploy\.yml /,
                    /^gh workflow run kamal-manage\.yml -R Owner\/app --ref main -f action=rollback -f version=#{@v010} /,
                    /^gh run watch 3 /)
    expect(calls.grep(/release edit/)).to be_empty
  end

  it 'ship publishes to the mirror first and deploys from it on the active target' do
    d = project(feature_files: { '.github/workflows/kamal-deploy.yml' => with_target('kamal-deploy.yml') })
    health(d)
    write('publish-mirror', "#!/usr/bin/env bash\necho \"publish-mirror $*\" >> \"$FAKE/calls.log\"\n", 0o755)

    _, stderr, status = release('ship', 'v0.2.0', env: { 'RELEASE_MIRROR_REPO' => 'Owner/app_be',
                                                         'PUBLISH_MIRROR' => File.join(@repo, 'publish-mirror'),
                                                         'PROD_ACTIVE_TARGET' => 'srv' })

    expect(status.exitstatus).to eq(0), stderr
    expect_in_order(/^gh run watch 1 /,
                    /^publish-mirror app --card APP-7 --dry-run$/,
                    /^publish-mirror app --card APP-7$/,
                    %r{^gh api repos/Owner/app_be/git/ref/tags/v0\.2\.0$},
                    /^gh workflow run kamal-deploy\.yml -R Owner\/app_be --ref main -f environment=prod -f version=v0\.2\.0 -f confirm=prod -f target=srv -f source_sha=#{d}$/,
                    /^gh run watch 2 -R Owner\/app_be /)
  end

  it 'red smoke rolls back to the previous tag' do
    d = project
    health('f' * 40, @v010)

    stdout, stderr, status = release('ship', 'v0.2.0')

    expect(status.exitstatus).to eq(3), stderr
    expect(stdout).to include("red: v0.2.0 #{d} smoke https://app.example.test/health\n")
      .and include("rolled back: v0.1.0 #{@v010}\n")
    expect_in_order(/^gh workflow run kamal-deploy\.yml /,
                    /^gh workflow run kamal-manage\.yml -R Owner\/app --ref main -f action=rollback -f version=#{@v010} -f confirm=ROLLBACK-prod$/,
                    /^gh run watch 3 /)
    expect(calls.grep(/release edit/)).to be_empty
  end

  it 'red e2e rolls back to the previous tag' do
    d = project
    health(d, @v010)
    fail_with('smoke.rc')

    expect_rolled_back(*release('ship', 'v0.2.0'), "red: v0.2.0 #{d} e2e https://github.example/runs/2")
  end

  it 'red release-watch rolls back to the previous tag' do
    d = project
    health(@v010)
    fail_with('run-2.rc')

    expect_rolled_back(*release('ship', 'v0.2.0'), "red: v0.2.0 #{d} release-watch https://github.example/runs/2")
    expect(calls.grep(/^curl /).size).to eq(1)
  end

  it 'a failed deploy dispatch takes the red path, since the deploy may have started' do
    d = project
    health(@v010)
    fail_with('dispatch-kamal-deploy.yml.rc')

    expect_rolled_back(*release('ship', 'v0.2.0'),
                       "red: v0.2.0 #{d} release-watch https://github.com/Owner/app/actions/workflows/kamal-deploy.yml")
  end

  it 'escalates with exit 5 when the rollback cannot be dispatched' do
    project
    health('f' * 40)
    fail_with('dispatch-kamal-manage.yml.rc')

    _, stderr, status = release('ship', 'v0.2.0')

    expect(status.exitstatus).to eq(5)
    expect(stderr).to include('dispatching kamal-manage.yml failed').and include('the rollback to v0.1.0 did not verify')
  end

  it 'deploys and rolls back on PROD_ACTIVE_TARGET when the workflows take a target' do
    project(feature_files: %w[kamal-deploy.yml kamal-manage.yml].to_h { |w| [ ".github/workflows/#{w}", with_target(w) ] })
    health('f' * 40, @v010)

    _, stderr, status = release('ship', 'v0.2.0', env: { 'PROD_ACTIVE_TARGET' => 'srv' })

    expect(status.exitstatus).to eq(3), stderr
    expect_in_order(/^gh workflow run kamal-deploy\.yml .* -f target=srv$/,
                    /^gh workflow run kamal-manage\.yml .* -f confirm=ROLLBACK-prod -f target=srv$/)
  end

  it 'refuses a PROD_ACTIVE_TARGET the deploy workflow cannot take, before any write' do
    project

    _, stderr, status = release('ship', 'v0.2.0', env: { 'PROD_ACTIVE_TARGET' => 'srv' })

    expect(status.exitstatus).to eq(1)
    expect(stderr).to include('PROD_ACTIVE_TARGET=srv, but kamal-deploy.yml').and include('has no target input')
    expect(writes).to be_empty
  end

  it 'escalates with exit 5 when the rollback does not verify' do
    project
    health('f' * 40)

    _, stderr, status = release('ship', 'v0.2.0')

    expect(status.exitstatus).to eq(5)
    expect(stderr).to include('the rollback to v0.1.0 did not verify')
  end

  it 'irreversible migration disables auto-rollback' do
    migration = "class DropOld < ActiveRecord::Migration[8.0]\n  def change\n    remove_column :widgets, :old, :string\n  end\nend\n"
    d = project(feature_files: { 'db/migrate/20261101000000_drop_old.rb' => migration,
                                 'db/migrate/20261101000001_add_new.rb' => "add_column :widgets, :new, :string\n" })
    health('f' * 40)

    stdout, stderr, status = release('ship', 'v0.2.0')

    expect(status.exitstatus).to eq(4), stderr
    expect(stdout).to include("red: v0.2.0 #{d} smoke")
      .and include("no auto-rollback: irreversible migration db/migrate/20261101000000_drop_old.rb\n")
    expect(stderr).to include('nothing was rolled back')
    expect(calls.grep(/kamal-manage/)).to be_empty
  end

  it 'irreversible migration in a change_table block or heredoc SQL disables auto-rollback' do
    migration = ->(body) { "class M < ActiveRecord::Migration[8.0]\n  def up\n#{body}  end\nend\n" }
    project(feature_files: {
              'db/migrate/20261101000000_backfill.rb' => migration.call("    execute \"UPDATE widgets SET n = 1\"\n"),
              'db/migrate/20261101000001_table.rb' => migration.call("    change_table :widgets do |t|\n      t.remove :old\n    end\n"),
              'db/migrate/20261101000002_sql.rb' =>
                migration.call("    execute <<~SQL\n      ALTER TABLE widgets\n        DROP COLUMN legacy\n    SQL\n")
            })
    health('f' * 40)

    stdout, stderr, status = release('ship', 'v0.2.0')

    expect(status.exitstatus).to eq(4), stderr
    expect(stdout).to include('no auto-rollback: irreversible migration ' \
                              "db/migrate/20261101000001_table.rb db/migrate/20261101000002_sql.rb\n")
    expect(calls.grep(/kamal-manage/)).to be_empty
  end

  it 'version comes from next-version.sh' do
    project(prep_subject: nil)

    stdout, stderr, status = release('prep', env: { 'RELEASE_CARD' => 'APP-7' })

    expect(status.exitstatus).to eq(0), stderr
    expect(stdout).to eq("prep: APP-7 0.2.0 #10\n")
    expect(calls.grep(/^gh pr create/).first)
      .to include('--base develop --head feature/APP-7-release-0-2-0 --title APP-7: Release 0.2.0 changelog')
    pushed = git('show', 'feature/APP-7-release-0-2-0:CHANGELOG.md', chdir: origin)
    expect(pushed).to end_with("## [Unreleased]\n\n### Added\n\n### Changed\n\n### Deprecated\n\n### Removed\n\n" \
                               "### Fixed\n\n### Security\n\n## [0.2.0] - #{Time.now.strftime('%F')}\n\n### Added\n\n- Widgets (APP-2)")
  end

  it 'refuses a version that next-version.sh does not compute, before any write' do
    project(prep_subject: 'APP-7: Release 0.3.0 changelog (#9)')

    _, stderr, status = release('ship', 'v0.3.0')

    expect(status.exitstatus).to eq(1)
    expect(stderr).to include('next-version.sh').and include('= 0.2.0, not 0.3.0')
    expect(writes).to be_empty
  end

  it 'rollback dispatches Kamal Manage on the tag commit and proves /health' do
    project
    health(@v010)

    stdout, stderr, status = release('rollback', 'v0.1.0')

    expect(status.exitstatus).to eq(0), stderr
    expect(stdout).to eq("rolled back: v0.1.0 #{@v010}\n")
    expect(calls).to include("gh workflow run kamal-manage.yml -R Owner/app --ref main -f action=rollback -f version=#{@v010} -f confirm=ROLLBACK-prod")
  end

  it 'ship --dry-run prints every write and runs none' do
    d = project

    stdout, stderr, status = release('ship', 'v0.2.0', '--dry-run')

    expect(status.exitstatus).to eq(0), stderr
    expect(stdout).to include("dry run: bin/wait-dev-deploy #{d}\n")
      .and include('dry run: gh pr create -R Owner/app --base main --head develop')
      .and include("dry run: gh pr merge <new> -R Owner/app --merge --match-head-commit #{d}\n")
      .and include("dry run: git tag -a v0.2.0 -m v0.2.0 #{d}\n")
      .and include("dry run: git push -q origin refs/tags/v0.2.0\n")
      .and include('dry run: gh workflow run kamal-deploy.yml -R Owner/app --ref main -f environment=prod')
      .and include("dry run: gh release edit v0.2.0 -R Owner/app --draft=false\n")
    expect(stdout).not_to include('shipped:')
    expect(writes).to be_empty
    expect(git('tag', '--list', 'v0.2.0', chdir: origin)).to be_empty
  end

  it 'refuses an unpinned runner image before any write' do
    project
    File.write(File.join(@fake, 'runs_on'), "ubuntu-latest\n")

    _, stderr, status = release('ship', 'v0.2.0')

    expect(status.exitstatus).to eq(1)
    expect(stderr).to include("RUNS_ON of Owner/app is 'ubuntu-latest'")
    expect(writes).to be_empty
  end
end
