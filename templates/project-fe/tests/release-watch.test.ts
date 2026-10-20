import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { calls, fakeCommand, projectEnv, runScript, tempDir } from './support.ts'

const { PROJECT_NAME: name, PROJECT_ZONE: zone } = projectEnv()
const token = 'TOKEN-SENTINEL'
const apiUrl = 'https://glitchtip.invalid'
const known = [{ id: '11', title: 'TypeError: old', firstSeen: '2026-10-01T10:00:00Z' }]

let bin: string
let output: string

/**
 * A fake curl. With --config it is the GlitchTip API: it keeps its stdin (the config with the URL
 * and the token) and answers `issues.json`, or `issues-later.json` from its second call on.
 * Otherwise it answers prod health, failing while `health-down` exists.
 */
function fakeCurl() {
  fakeCommand(
    bin,
    'curl',
    `if [[ " $* " == *" --config "* ]]; then
  cat >> "${bin}/curl.stdin"
  count=$(( $(cat "${bin}/api.count" 2>/dev/null || echo 0) + 1 ))
  echo "$count" > "${bin}/api.count"
  if [ "$count" -ge 2 ] && [ -f "${bin}/issues-later.json" ]; then cat "${bin}/issues-later.json"; else cat "${bin}/issues.json"; fi
  exit 0
fi
case "\${@: -1}" in
  https://app.${zone}/health) [ ! -f "${bin}/health-down" ] || exit 22; echo ok ;;
  *) exit 22 ;;
esac`,
  )
}

function issues(file: string, list: unknown) {
  writeFileSync(join(bin, file), JSON.stringify(list))
}

function run(script: string, args: string[], env: Record<string, string> = {}) {
  return runScript(script, args, {
    PATH: `${bin}:${process.env.PATH}`,
    GLITCHTIP_API_URL: apiUrl,
    GLITCHTIP_API_TOKEN: token,
    RELEASE_WATCH_SECONDS: '2',
    RELEASE_WATCH_POLL_SECONDS: '1',
    GITHUB_OUTPUT: output,
    ...env,
  })
}

function outputText(): string {
  return existsSync(output) ? readFileSync(output, 'utf8') : ''
}

function expectNoSecrets(result: { stdout: string; stderr: string }) {
  const everything = result.stdout + result.stderr + outputText() + calls(bin, 'curl').join('\n')
  expect(everything).not.toContain(token)
  expect(everything).not.toContain('glitchtip.invalid')
}

beforeEach(() => {
  bin = tempDir('release-watch-')
  output = join(bin, 'github-output')
  fakeCurl()
  issues('issues.json', known)
})

describe('deploy/release_watch.sh', () => {
  it('reports a clean watch when prod stays healthy and no new issue appears', () => {
    const result = run('deploy/release_watch.sh', ['v0.1.0'])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toMatch(
      new RegExp(`✅ release-watch v0\\.1\\.0: \\d+ health checks OK, no new GlitchTip issues in ${name}-fe-prod`),
    )
    expect(outputText()).toMatch(/^text=✅ release-watch v0\.1\.0: /)
    expect(calls(bin, 'curl').filter((call) => call.endsWith(`https://app.${zone}/health`)).length).toBeGreaterThanOrEqual(2)
    expectNoSecrets(result)
  })

  it('fails naming the new issue, and never rolls back', () => {
    issues('issues-later.json', [
      ...known,
      { id: '12', title: 'Error: release-watch probe C5\r\nsecond line', firstSeen: '2026-10-17T10:00:00Z' },
    ])
    const result = run('deploy/release_watch.sh', ['v0.1.0'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`❌ release-watch v0.1.0: new GlitchTip issue(s) in ${name}-fe-prod: Error: release-watch probe C5 second line`)
    expect(outputText()).toMatch(/^text=❌ release-watch v0\.1\.0: new GlitchTip issue\(s\)[^\n]*\n$/)
    expect(calls(bin, 'kamal')).toEqual([])
    expectNoSecrets(result)
  })

  it('fails when prod health fails', () => {
    writeFileSync(join(bin, 'health-down'), '')
    const result = run('deploy/release_watch.sh', ['v0.1.0'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`❌ release-watch v0.1.0: https://app.${zone}/health failed`)
  })

  it('fails when GlitchTip answers something other than a list of issues', () => {
    writeFileSync(join(bin, 'issues.json'), '{"detail":"Invalid token."}')
    const result = run('deploy/release_watch.sh', ['v0.1.0'])
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('❌ release-watch v0.1.0: could not read GlitchTip issues')
    expect(result.stderr).toContain('unexpected shape')
    expectNoSecrets(result)
  })

  it('needs a tag', () => {
    expect(run('deploy/release_watch.sh', []).status).toBe(1)
  })
})

describe('deploy/glitchtip_issues.sh', () => {
  it('lists the unresolved issues of the prod frontend project, passing URL and token on stdin', () => {
    const result = run('deploy/glitchtip_issues.sh', [])
    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(result.stdout)).toEqual(known)
    const config = readFileSync(join(bin, 'curl.stdin'), 'utf8')
    expect(config).toContain(`${apiUrl}/api/0/projects/${name}/${name}-fe-prod/issues/?query=is%3Aunresolved&limit=100`)
    expect(config).toContain(`Authorization: Bearer ${token}`)
    expectNoSecrets(result)
  })

  it('takes another query', () => {
    expect(run('deploy/glitchtip_issues.sh', ['is:resolved']).status).toBe(0)
    expect(readFileSync(join(bin, 'curl.stdin'), 'utf8')).toContain('query=is%3Aresolved')
  })

  it('fails without printing the URL or the token when the request fails', () => {
    fakeCommand(bin, 'curl', 'cat >/dev/null; exit 22')
    const result = run('deploy/glitchtip_issues.sh', [])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('GlitchTip API request failed (curl exit 22)')
    expectNoSecrets(result)
  })

  it('names the missing settings', () => {
    const result = run('deploy/glitchtip_issues.sh', [], { GLITCHTIP_API_URL: '', GLITCHTIP_API_TOKEN: '' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('GLITCHTIP_API_URL')
    expect(result.stderr).toContain('GLITCHTIP_API_TOKEN')
  })
})
