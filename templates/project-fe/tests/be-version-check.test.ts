import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { calls, fakeCommand, projectEnv, repoRoot, runScript, tempDir } from './support.ts'

const { PROJECT_ZONE: zone } = projectEnv()
const beSha = '7'.repeat(40)
let bin: string
let health: string
let minimum: string

function fakeGh(body: string) {
  fakeCommand(bin, 'gh', `printf '%s' "\${GH_TOKEN:-}" > "${bin}/gh.token"\n${body}`)
}

function check(env: Record<string, string> = {}) {
  return runScript('deploy/be_version_check.sh', [], {
    PATH: `${bin}:${process.env.PATH}`,
    MIN_BE_VERSION_FILE: minimum,
    BE_REPO: 'owner/be',
    ...env,
  })
}

beforeEach(() => {
  bin = tempDir('be-version-')
  health = join(bin, 'health.json')
  minimum = join(bin, 'min-be-version')
  writeFileSync(minimum, 'v0.2.0\n')
  writeFileSync(health, JSON.stringify({ status: 'ok', release: beSha }))
  fakeCommand(
    bin,
    'curl',
    `case "\${@: -1}" in
  https://${zone}/health) cat "${health}" ;;
  *) exit 22 ;;
esac`,
  )
  fakeGh('echo ahead')
})

describe('deploy/be_version_check.sh', () => {
  it('passes when the backend on prod is newer than the minimum', () => {
    const result = check()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`backend on prod ${beSha.slice(0, 7)} contains v0.2.0`)
    expect(calls(bin, 'gh')[0]).toContain(`repos/owner/be/compare/v0.2.0...${beSha}`)
  })

  it('passes when the backend on prod is exactly the minimum', () => {
    fakeGh('echo identical')
    expect(check().status).toBe(0)
  })

  it.each(['behind', 'diverged'])('refuses a backend that is %s the minimum, explaining the release order', (status) => {
    fakeGh(`echo ${status}`)
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`backend on prod (${beSha.slice(0, 7)}) is older than v0.2.0`)
    expect(result.stderr).toContain('Release order is backend first')
    expect(result.stderr).toContain('Nothing was deployed.')
  })

  it('refuses when GitHub cannot compare (the minimum tag does not exist)', () => {
    fakeGh('echo "gh: Not Found (HTTP 404)" >&2; exit 1')
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('Nothing was deployed.')
  })

  it('refuses when the backend health reports no release sha', () => {
    writeFileSync(health, JSON.stringify({ status: 'ok' }))
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('backend /health reports no release sha')
    expect(calls(bin, 'gh')).toEqual([])
  })

  it('refuses when the backend health does not answer', () => {
    fakeCommand(bin, 'curl', 'exit 7')
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(`https://${zone}/health`)
    expect(calls(bin, 'gh')).toEqual([])
  })

  it.each(['0.2.0', 'v0.2', ''])('refuses a malformed minimum %j, naming the file', (value) => {
    writeFileSync(minimum, `${value}\n`)
    const result = check()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(minimum)
    expect(calls(bin, 'curl')).toEqual([])
  })

  it('reads the backend repository with BE_REPO_TOKEN without printing it', () => {
    const result = check({ BE_REPO_TOKEN: 'TOKEN-SENTINEL', GH_TOKEN: 'own-repo-token' })
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(bin, 'gh.token'), 'utf8')).toBe('TOKEN-SENTINEL')
    expect(result.stdout + result.stderr).not.toContain('TOKEN-SENTINEL')
  })

  it('declares the minimum backend version of this release in deploy/min-be-version', () => {
    const result = runScript('deploy/be_version_check.sh', [], { PATH: `${bin}:${process.env.PATH}`, BE_REPO: 'owner/be' })
    expect(result.status, result.stderr).toBe(0)
    const declared = readFileSync(join(repoRoot, 'deploy', 'min-be-version'), 'utf8').trim()
    expect(calls(bin, 'gh')[0]).toContain(`compare/${declared}...${beSha}`)
  })
})
