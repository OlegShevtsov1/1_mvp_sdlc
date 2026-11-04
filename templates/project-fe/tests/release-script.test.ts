import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { git, gitRepo, repoRoot, runScript, tempDir } from './support.ts'

// gh, Kamal Deploy and Kamal Manage included: bin/release reaches Kamal only by dispatching those workflows.
// Every call goes to calls.log in order. PRs live in prs.json; `pr merge` merges develop into main on the bare origin
// with a merge commit. Runs: 1 release.yml, 2 kamal-deploy.yml, 3 kamal-manage.yml; run-<id>.rc fails one,
// dispatch-<workflow>.rc fails its \`workflow run\`.
const ghShim = String.raw`#!/usr/bin/env bash
echo "gh $*" >> "$FAKE/calls.log"
arg() { local want=$1; shift; while [ $# -gt 0 ]; do [ "$1" = "$want" ] && { echo "$2"; return; }; shift; done; }
prs() { cat "$FAKE/prs.json" 2>/dev/null || echo '[]'; }
case "$1 $2" in
  'repo view') echo '{"nameWithOwner":"Owner/app"}' ;;
  'auth token') echo mirror-token ;;
  'variable get') echo ubuntu-24.04 ;;
  'api '*) echo 1 ;;
  'pr list') prs ;;
  'pr create')
    n=$(( $(prs | jq length) + 10 ))
    cp "$(arg --body-file "$@")" "$FAKE/pr-$n.md"
    prs | jq -c --argjson n "$n" --arg t "$(arg --title "$@")" '. + [{number: $n, state: "OPEN", title: $t}]' > "$FAKE/prs.new"
    mv "$FAKE/prs.new" "$FAKE/prs.json" ;;
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
`

// Answers from the lines of `answers` in order; the last line answers every later call.
const curlShim = String.raw`#!/usr/bin/env bash
echo "curl $*" >> "$FAKE/calls.log"
head -n 1 "$FAKE/answers"
if [ "$(wc -l < "$FAKE/answers")" -gt 1 ]; then sed -i 1d "$FAKE/answers"; fi
`

// Logs the minimum it was given; fails the first be.fails checks, then passes.
const beVersionCheckStub = String.raw`#!/usr/bin/env bash
echo "be_version_check $(cat "$MIN_BE_VERSION_FILE")" >> "$FAKE/calls.log"
n=$(( $(cat "$FAKE/be.count" 2>/dev/null || echo 0) + 1 ))
echo "$n" > "$FAKE/be.count"
[ "$n" -gt "$(cat "$FAKE/be.fails" 2>/dev/null || echo 0)" ]
`

// Logs the call; exits with <name>.rc when present.
const logStub = (name: string) =>
  `#!/usr/bin/env bash\necho "${name} E2E_BASE_URL=\${E2E_BASE_URL:-} E2E_ENV_NAME=\${E2E_ENV_NAME:-} $*" >> "$FAKE/calls.log"\n` +
  `exit "$(cat "$FAKE/${name}.rc" 2>/dev/null || echo 0)"\n`

const unreleased = readFileSync(join(repoRoot, 'CHANGELOG.md'), 'utf8')
const withEntry = unreleased.replace('### Added\n', '### Added\n\n- Widgets (APP-2)\n')
const released = `${unreleased}\n## [0.2.0] - 2026-11-01\n\nMinimum backend version: v0.1.0\n\n### Added\n\n- Widgets (APP-2)\n`

let repo: string
let fake: string
let origin: string
let v010: string

function put(path: string, content: string, mode = 0o644) {
  mkdirSync(dirname(join(repo, path)), { recursive: true })
  writeFileSync(join(repo, path), content)
  chmodSync(join(repo, path), mode)
}

function commitAll(message: string): string {
  git(repo, 'add', '-A')
  git(repo, 'commit', '-q', '--no-verify', '-m', message)
  return git(repo, 'rev-parse', 'HEAD')
}

function squash(subject: string, type: string, files: Record<string, string>): string {
  for (const [path, content] of Object.entries(files)) put(path, content)
  return commitAll(`${subject}\n\nSummary.\n\nType: ${type}`)
}

/**
 * v0.1.0 on main, then on develop a feature (featureFiles) and, unless prepSubject is null, its release-prep squash;
 * returns D.
 */
function project(
  prepSubject: string | null = 'APP-7: Release 0.2.0 changelog (#9)',
  featureFiles: Record<string, string> = {},
): string {
  put('config/project.env', 'PROJECT_NAME=app\nPROJECT_ZONE=example.test\n')
  put('CHANGELOG.md', unreleased)
  put('deploy/min-be-version', 'v0.1.0\n')
  for (const script of ['scripts/next-version.sh', 'scripts/release-notes.sh', 'scripts/pr-conventions.sh']) {
    put(script, readFileSync(join(repoRoot, script), 'utf8'), 0o755)
  }
  for (const workflow of ['kamal-deploy.yml', 'kamal-manage.yml']) {
    put(`.github/workflows/${workflow}`, readFileSync(join(repoRoot, '.github/workflows', workflow), 'utf8'))
  }
  put('deploy/be_version_check.sh', beVersionCheckStub, 0o755)
  put('bin/wait-dev-deploy', logStub('wait-dev-deploy'), 0o755)
  v010 = commitAll('Bootstrap')
  git(repo, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0')
  git(repo, 'switch', '-q', '-c', 'develop')
  squash('APP-2: widgets (#2)', 'feat', { 'CHANGELOG.md': withEntry, ...featureFiles })
  if (prepSubject) squash(prepSubject, 'docs', { 'CHANGELOG.md': released })
  git(fake, 'init', '-q', '--bare', origin)
  git(repo, 'remote', 'add', 'origin', origin)
  git(repo, 'push', '-q', 'origin', 'main', 'develop', '--tags')
  return git(repo, 'rev-parse', 'HEAD')
}

function serving(...shas: string[]) {
  const answer = (sha: string) => `window.APP_CONFIG = { ENV_NAME: "prod", APP_VERSION: "prod-sha-${sha}" }\n`
  writeFileSync(join(fake, 'answers'), shas.map(answer).join(''))
}

function release(args: string[], env: Record<string, string> = {}) {
  const bin = join(fake, 'bin')
  mkdirSync(bin, { recursive: true })
  for (const [name, body] of Object.entries({ gh: ghShim, curl: curlShim, npm: logStub('npm') })) {
    writeFileSync(join(bin, name), body)
    chmodSync(join(bin, name), 0o755)
  }
  const identity = { GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.test' }
  return runScript(
    'bin/release',
    args,
    {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: fake,
      FAKE: fake,
      RELEASE_POLL_INTERVAL: '0',
      ...identity,
      GIT_COMMITTER_NAME: identity.GIT_AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: identity.GIT_AUTHOR_EMAIL,
      ...env,
    },
    repo,
  )
}

function log(): string[] {
  const file = join(fake, 'calls.log')
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n') : []
}

/** Asserts the calls matching `patterns` appear in this order. */
function expectInOrder(...patterns: RegExp[]) {
  const calls = log()
  const positions = patterns.map((pattern) => {
    const at = calls.findIndex((call) => pattern.test(call))
    expect(at, `no call matches ${pattern}:\n${calls.join('\n')}`).toBeGreaterThanOrEqual(0)
    return at
  })
  expect(positions).toEqual([...positions].sort((a, b) => a - b))
}

const withTarget = (workflow: string) =>
  readFileSync(join(repoRoot, '.github/workflows', workflow), 'utf8').replace(
    '    inputs:\n',
    '    inputs:\n      target:\n        type: choice\n        options: [aws, srv]\n',
  )

const failWith = (file: string) => writeFileSync(join(fake, file), '1\n')

/** Asserts the red path printed redLine, rolled prod back to v0.1.0 and published nothing. */
function expectRolledBack(result: ReturnType<typeof release>, redLine: string) {
  expect(result.status, result.stderr).toBe(3)
  expect(result.stdout).toContain(`${redLine}\n`)
  expect(result.stdout).toContain(`rolled back: v0.1.0 ${v010}\n`)
  expectInOrder(
    /^gh workflow run kamal-deploy\.yml /,
    new RegExp(`^gh workflow run kamal-manage\\.yml -R Owner/app --ref main -f action=rollback -f version=${v010} `),
    /^gh run watch 3 /,
  )
  expect(log().filter((call) => call.includes('release edit'))).toEqual([])
}

const isWrite = (call: string) => /^gh (pr create|pr merge|workflow run|release edit)|^wait-dev-deploy/.test(call)

beforeEach(() => {
  repo = gitRepo('release-')
  fake = tempDir('release-fake-')
  origin = join(fake, 'origin.git')
})

describe('bin/release', () => {
  it('ship runs the steps in order with fake gh/kamal', () => {
    const d = project()
    serving(d)

    const result = release(['ship', 'v0.2.0'])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.trim().split('\n').at(-1)).toBe(`shipped: v0.2.0 ${d}`)
    expectInOrder(
      /^be_version_check v0\.1\.0$/,
      new RegExp(`^wait-dev-deploy .* ${d}$`),
      /^gh pr create -R Owner\/app --base main --head develop --title APP-7: Release v0\.2\.0 /,
      new RegExp(`^gh pr merge 10 -R Owner/app --merge --match-head-commit ${d}$`),
      /^gh run watch 1 /,
      /^gh workflow run kamal-deploy\.yml -R Owner\/app --ref main -f environment=prod -f version=v0\.2\.0 -f confirm=prod$/,
      /^gh run watch 2 /,
      /^curl .*https:\/\/app\.example\.test\/config\.js$/,
      /^npm E2E_BASE_URL=https:\/\/app\.example\.test E2E_ENV_NAME=prod run e2e$/,
      /^gh release edit v0\.2\.0 -R Owner\/app --draft=false$/,
    )
    expect(readFileSync(join(fake, 'pr-10.md'), 'utf8')).toContain('## Changelog\n\nMinimum backend version: v0.1.0\n')
    expect(git(origin, 'rev-parse', 'v0.2.0^{commit}')).toBe(d)
  })

  it('red smoke rolls back to the previous tag', () => {
    const d = project()
    serving('f'.repeat(40), v010)

    const result = release(['ship', 'v0.2.0'])

    expect(result.status, result.stderr).toBe(3)
    expect(result.stdout).toContain(`red: v0.2.0 ${d} smoke https://app.example.test/config.js\n`)
    expect(result.stdout).toContain(`rolled back: v0.1.0 ${v010}\n`)
    expectInOrder(
      /^gh workflow run kamal-deploy\.yml /,
      new RegExp(
        `^gh workflow run kamal-manage\\.yml -R Owner/app --ref main -f action=rollback -f version=${v010} -f confirm=ROLLBACK-prod$`,
      ),
      /^gh run watch 3 /,
    )
    expect(log().filter((call) => call.includes('release edit'))).toEqual([])
  })

  it('fe waits for min-be-version on prod', () => {
    const d = project()
    serving(d)
    writeFileSync(join(fake, 'be.fails'), '2')

    const result = release(['ship', 'v0.2.0'])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr.match(/waiting for backend >= v0\.1\.0 on prod/g)).toHaveLength(2)
    const calls = log()
    const checks = calls.flatMap((call, at) => (call.startsWith('be_version_check') ? [at] : []))
    expect(checks).toHaveLength(3)
    expect(calls.findIndex(isWrite)).toBeGreaterThan(checks[2])
  })

  it('fe gives up waiting for the backend with exit 75 and writes nothing', () => {
    project()
    writeFileSync(join(fake, 'be.fails'), '99')

    const result = release(['ship', 'v0.2.0'], { RELEASE_BE_WAIT: '0' })

    expect(result.status).toBe(75)
    expect(result.stderr).toContain('still refuses the backend on prod for v0.1.0')
    expect(log().filter(isWrite)).toEqual([])
  })

  it('fe waits for the min-be-version of the release commit, not of the working tree', () => {
    const d = project(undefined, { 'deploy/min-be-version': 'v0.2.0\n' })
    put('deploy/min-be-version', 'v0.1.0\n')
    serving(d)
    failWith('be.fails')

    const result = release(['ship', 'v0.2.0'])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toContain('waiting for backend >= v0.2.0 on prod')
    expect(log().filter((call) => call.startsWith('be_version_check'))).toEqual([
      'be_version_check v0.2.0',
      'be_version_check v0.2.0',
    ])
  })

  it('fe refuses a malformed min-be-version with exit 1 instead of waiting it out', () => {
    project(undefined, { 'deploy/min-be-version': 'garbage\n' })

    const result = release(['ship', 'v0.2.0'], { RELEASE_BE_WAIT: '0' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain("is 'garbage', not one tag vX.Y.Z")
    expect(log().filter((call) => call.startsWith('be_version_check'))).toEqual([])
    expect(log().filter(isWrite)).toEqual([])
  })

  it('fe refuses a release commit without min-be-version with exit 1', () => {
    project(null)
    rmSync(join(repo, 'deploy/min-be-version'))
    squash('APP-7: Release 0.2.0 changelog (#9)', 'docs', { 'CHANGELOG.md': released })
    git(repo, 'push', '-q', 'origin', 'develop')
    put('deploy/min-be-version', 'v0.1.0\n')

    const result = release(['ship', 'v0.2.0'], { RELEASE_BE_WAIT: '0' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('has no deploy/min-be-version')
    expect(log().filter((call) => call.startsWith('be_version_check'))).toEqual([])
    expect(log().filter(isWrite)).toEqual([])
  })

  it('fe refuses a non-executable be_version_check.sh with exit 1', () => {
    project()
    chmodSync(join(repo, 'deploy/be_version_check.sh'), 0o644)

    const result = release(['ship', 'v0.2.0'], { RELEASE_BE_WAIT: '0' })

    expect(result.status).toBe(1)
    expect(result.stderr).toContain('deploy/be_version_check.sh is missing or not executable')
    expect(log().filter(isWrite)).toEqual([])
  })

  it('red e2e rolls back to the previous tag', () => {
    const d = project()
    serving(d, v010)
    failWith('npm.rc')

    expectRolledBack(release(['ship', 'v0.2.0']), `red: v0.2.0 ${d} e2e https://github.example/runs/2`)
  })

  it('red release-watch rolls back to the previous tag', () => {
    const d = project()
    serving(v010)
    failWith('run-2.rc')

    expectRolledBack(release(['ship', 'v0.2.0']), `red: v0.2.0 ${d} release-watch https://github.example/runs/2`)
    expect(log().filter((call) => call.startsWith('curl '))).toHaveLength(1)
  })

  it('a failed deploy dispatch takes the red path, since the deploy may have started', () => {
    const d = project()
    serving(v010)
    failWith('dispatch-kamal-deploy.yml.rc')

    expectRolledBack(
      release(['ship', 'v0.2.0']),
      `red: v0.2.0 ${d} release-watch https://github.com/Owner/app/actions/workflows/kamal-deploy.yml`,
    )
  })

  it('escalates with exit 5 when the rollback cannot be dispatched', () => {
    project()
    serving('f'.repeat(40))
    failWith('dispatch-kamal-manage.yml.rc')

    const result = release(['ship', 'v0.2.0'])

    expect(result.status).toBe(5)
    expect(result.stderr).toContain('dispatching kamal-manage.yml failed')
    expect(result.stderr).toContain('the rollback to v0.1.0 did not verify')
  })

  it('deploys and rolls back on PROD_ACTIVE_TARGET when the workflows take a target', () => {
    project(undefined, {
      '.github/workflows/kamal-deploy.yml': withTarget('kamal-deploy.yml'),
      '.github/workflows/kamal-manage.yml': withTarget('kamal-manage.yml'),
    })
    serving('f'.repeat(40), v010)

    const result = release(['ship', 'v0.2.0'], { PROD_ACTIVE_TARGET: 'srv' })

    expect(result.status, result.stderr).toBe(3)
    expectInOrder(
      /^gh workflow run kamal-deploy\.yml .* -f target=srv$/,
      /^gh workflow run kamal-manage\.yml .* -f confirm=ROLLBACK-prod -f target=srv$/,
    )
  })

  it('version comes from next-version.sh', () => {
    project(null)

    const result = release(['prep'], { RELEASE_CARD: 'APP-7' })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('prep: APP-7 0.2.0 #10\n')
    const today = new Date().toLocaleDateString('sv')
    const pushed = git(origin, 'show', 'feature/APP-7-release-0-2-0:CHANGELOG.md')
    expect(pushed).toContain(
      '## [Unreleased]\n\nMinimum backend version: v0.1.0\n\n### Added\n\n### Changed\n\n### Deprecated\n\n' +
        `### Removed\n\n### Fixed\n\n### Security\n\n## [0.2.0] - ${today}\n\nMinimum backend version: v0.1.0\n\n` +
        '### Added\n\n- Widgets (APP-2)',
    )
  })
})
