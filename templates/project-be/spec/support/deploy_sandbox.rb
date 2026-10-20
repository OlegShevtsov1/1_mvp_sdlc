require 'open3'
require 'tmpdir'
require 'fileutils'

# deploy/*.sh are shell, so none of the project's Ruby gates look at them. They resolve the repo
# root from their own path, which lets the real scripts run inside a throwaway tree whose PATH
# shims stand in for kamal (bundle), curl, aws, crane and git and record how they were called.
module DeploySandbox
  SHA = 'a' * 40
  # Built, not written out: the public-repo grep rejects any literal 12-digit number.
  ACCOUNT_ID = ('1' * 12).freeze

  SHIMS = {
    # Every call is logged; `kamal app containers` / `kamal app version` answer from fixtures, or
    # fail like an unreachable host when a containers.fail / version.fail fixture exists.
    'bundle' => <<~SH,
      #!/usr/bin/env bash
      echo "$*" >> "$SANDBOX/bundle.log"
      case "$*" in
        *'kamal app containers'*) [[ -e "$SANDBOX/containers.fail" ]] && exit 1; cat "$SANDBOX/containers.txt" 2>/dev/null ;;
        *'kamal app version'*) [[ -e "$SANDBOX/version.fail" ]] && exit 1; cat "$SANDBOX/version.txt" 2>/dev/null ;;
      esac
      exit 0
    SH
    # /health answers health.json. The GlitchTip API (/api/0/) answers glitchtip-page1.json, or
    # glitchtip-page2.json for a cursor URL, with headers from glitchtip-page<n>.headers and the
    # status from glitchtip-code; the headers curl reads from stdin (-H @-) go to curl.stdin.
    'curl' => <<~'SH',
      #!/usr/bin/env bash
      echo "$*" >> "$SANDBOX/curl.log"
      url="${!#}"
      if [[ "$url" == */api/0/* ]]; then
        cat >> "$SANDBOX/curl.stdin"
        page=1
        [[ "$url" == *cursor=* ]] && page=2
        out=/dev/stdout dump=/dev/null
        while (( $# )); do
          case "$1" in -o) out="$2"; shift ;; -D) dump="$2"; shift ;; esac
          shift
        done
        cat "$SANDBOX/glitchtip-page${page}.json" > "$out"
        cat "$SANDBOX/glitchtip-page${page}.headers" > "$dump" 2> /dev/null || printf 'HTTP/1.1 200 OK\r\n\r\n' > "$dump"
        cat "$SANDBOX/glitchtip-code" 2> /dev/null || printf 200
        exit 0
      fi
      cat "$SANDBOX/health.json"
    SH
    'aws' => <<~SH,
      #!/usr/bin/env bash
      case "$*" in
        'sts get-caller-identity'*) echo "$AWS_SHIM_ACCOUNT" ;;
        'ecr get-login-password'*) echo 'ecr-password-from-shim' ;;
      esac
    SH
    # A registry of plain files: `digests` holds `<tag> <digest>` lines, manifest-<tag>.json and
    # config-<tag>.json the image documents. `mutate` copies the source with the new service label
    # and, like the real crane, without null config fields.
    'crane' => <<~'SH',
      #!/usr/bin/env bash
      set -euo pipefail
      if [[ "$1" == 'auth' ]]; then
        read -r _password
        echo "auth login $3" >> "$SANDBOX/crane.log"
        exit 0
      fi
      echo "$*" >> "$SANDBOX/crane.log"
      touch "$SANDBOX/digests"
      case "$1" in
        digest)
          line="$(grep "^${2##*:} " "$SANDBOX/digests")" || { echo 'MANIFEST_UNKNOWN' >&2; exit 1; }
          echo "${line#* }" ;;
        manifest) cat "$SANDBOX/manifest-${2##*:}.json" ;;
        config) cat "$SANDBOX/config-${2##*:}.json" ;;
        mutate)
          src="${2##*:}" dst="${6##*:}"
          echo "$dst sha256:prod${src}" >> "$SANDBOX/digests"
          jq -c '.config.digest = "sha256:cfgprod"' "$SANDBOX/manifest-${src}.json" > "$SANDBOX/manifest-${dst}.json"
          jq -c --arg service "${4#service=}" '.config.Labels.service = $service | .config |= with_entries(select(.value != null))' \
            "$SANDBOX/config-${src}.json" > "$SANDBOX/config-${dst}.json" ;;
        tag)
          grep -v "^$3 " "$SANDBOX/digests" > "$SANDBOX/digests.new" || true
          echo "$3 ${2#*@}" >> "$SANDBOX/digests.new"
          mv "$SANDBOX/digests.new" "$SANDBOX/digests" ;;
      esac
    SH
    # A published annotated release tag on main unless a fixture says otherwise: tag-fetch.fail
    # (not on origin), tag-type (e.g. commit for a lightweight tag), not-on-main. Anything else
    # (rev-parse) answers SHA.
    'git' => <<~SH,
      #!/usr/bin/env bash
      case "$*" in
        fetch*) echo "$*" >> "$SANDBOX/git.log"; [[ -e "$SANDBOX/tag-fetch.fail" ]] && exit 1; exit 0 ;;
        'cat-file -t '*) cat "$SANDBOX/tag-type" 2>/dev/null || echo tag ;;
        'merge-base --is-ancestor '*) [[ -e "$SANDBOX/not-on-main" ]] && exit 1; exit 0 ;;
        *) echo "#{SHA}" ;;
      esac
    SH
    'sleep' => <<~SH
      #!/usr/bin/env bash
      exit 0
    SH
  }.freeze

  def write_executable(path, body)
    File.write(path, body)
    FileUtils.chmod(0o755, path)
  end

  def build_sandbox(root)
    %w[deploy .kamal].each { |dir| FileUtils.cp_r(Rails.root.join(dir).to_s, File.join(root, dir)) }
    FileUtils.mkdir_p([ File.join(root, 'config'), File.join(root, 'bin'), File.join(root, 'shim') ])
    %w[config/project.env config/deploy.dev.yml config/deploy.yml].each do |file|
      FileUtils.cp(Rails.root.join(file), File.join(root, file))
    end
    # The real scripts wait minutes for a healthy release; one second keeps the unhealthy paths fast.
    Dir[File.join(root, 'deploy', '*.sh')].each do |script|
      File.write(script, File.read(script).gsub(/HEALTH_TIMEOUT=\d+/, 'HEALTH_TIMEOUT=1'))
    end
    SHIMS.each { |name, body| write_executable(File.join(root, 'shim', name), body) }
    write_executable(File.join(root, 'bin', 'swagger_smoke'), <<~SH)
      #!/usr/bin/env bash
      echo "$* SMOKE_CONNECT_TO=${SMOKE_CONNECT_TO:-} SMOKE_FORWARDED_PROTO=${SMOKE_FORWARDED_PROTO:-} SMOKE_READ_ONLY=${SMOKE_READ_ONLY:-}" > "$SANDBOX/smoke.log"
      ${SMOKE_SHIM_FAILS:+exit 1}
      echo 'all passed'
    SH
  end

  def project_env
    Rails.root.join('config/project.env').readlines(chomp: true)
      .grep(/\A[A-Z_]+=/).to_h { |line| line.split('=', 2) }
  end

  def secrets_env
    {
      'SECRET_KEY_BASE' => 'skb', 'POSTGRES_PASSWORD' => 'pgpass', 'SENTRY_DSN' => 'https://k@e.test/1',
      'SENTRY_ALLOWED_FE_DSN' => 'https://f@e.test/2', 'SMOKE_TOKEN' => 'smoke'
    }
  end

  # The registry state after Dev Deploy built sha-<sha>: one image, labelled for the dev service.
  def dev_image_files(sha = SHA)
    {
      'digests' => "sha-#{sha} sha256:dev#{sha}\n",
      "manifest-sha-#{sha}.json" => '{"config":{"digest":"sha256:cfgdev"},"layers":[{"digest":"sha256:L1"},{"digest":"sha256:L2"}]}',
      "config-sha-#{sha}.json" => %({"rootfs":{"type":"layers","diff_ids":["sha256:l1","sha256:l2"]},) +
        %("config":{"Labels":{"service":"#{project_env.fetch('PROJECT_NAME')}-dev"},"Env":["APP_RELEASE=#{sha}"],"OnBuild":null}})
    }
  end

  # Runs deploy/<script> with args inside a fresh sandbox and yields (output, status, sandbox).
  # `release` is what the stubbed /health reports; `files` are extra sandbox fixtures (name => content).
  def run_script(script, *args, env: {}, release: SHA, containers: nil, current_version: nil, files: {})
    Dir.mktmpdir do |root|
      build_sandbox(root)
      File.write(File.join(root, 'health.json'), %({"status":"ok","release":"#{release}"}))
      File.write(File.join(root, 'containers.txt'), containers) if containers
      File.write(File.join(root, 'version.txt'), current_version) if current_version
      files.each { |name, content| File.write(File.join(root, name), content) }
      full_env = {
        'PATH' => "#{File.join(root, 'shim')}:#{ENV.fetch('PATH')}",
        'SANDBOX' => root,
        'DEV_HOST' => '192.0.2.10',
        'AWS_SHIM_ACCOUNT' => ACCOUNT_ID,
        # nil unsets, so values exported in the caller's shell cannot make a spec pass vacuously.
        'SKIP_SMOKE' => nil, 'GITHUB_ACTIONS' => nil, 'PROJECT_NAME' => nil, 'PROJECT_ZONE' => nil,
        'KAMAL_REGISTRY_SERVER' => nil, 'KAMAL_REGISTRY_PASSWORD' => nil, 'PROD_VPN_IP' => nil,
        'GITHUB_STEP_SUMMARY' => nil, 'BACKUP_GATE' => nil, 'CONFIRM' => nil,
        'GLITCHTIP_API_TOKEN' => nil, 'GLITCHTIP_API_URL' => nil
      }.merge(secrets_env).merge(env)
      output, status = Open3.capture2e(full_env, File.join(root, 'deploy', script), *args)
      yield(output, status, root)
    end
  end

  def sandbox_log(root, name)
    path = File.join(root, name)
    File.exist?(path) ? File.read(path) : ''
  end
end

RSpec.configure do |config|
  config.include DeploySandbox, file_path: %r{spec/deploy/}
end
