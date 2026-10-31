import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { calls, commit, fakeCommand, gitRepo, runScript, tempDir } from './support.ts'

const sha = 'a'.repeat(40)
const newer = 'c'.repeat(40)
const url = 'https://github.com/owner/repo/actions/runs/42'
let bin: string

interface Run {
  status: string
  conclusion: string
  createdAt?: string
  displayTitle?: string
  url?: string
}

/** The fake gh answers its n-th Dev Deploy list call with runs.<n>.json, falling back to runs.json. */
function runs(list: Run[], call?: number): void {
  const json = list.map((run, index) => ({
    databaseId: 42 + index,
    createdAt: '2026-10-15T12:00:00Z',
    displayTitle: `Dev Deploy sha-${sha}`,
    url: `https://github.com/owner/repo/actions/runs/${42 + index}`,
    ...run,
  }))
  writeFileSync(join(bin, call ? `runs.${call}.json` : 'runs.json'), JSON.stringify(json))
}

/** The latest Front CI push run of the commit. */
function frontCi(conclusion: string, updatedAt = '2026-10-15T11:59:00Z'): void {
  writeFileSync(join(bin, 'front-ci.json'), JSON.stringify([{ status: 'completed', conclusion, updatedAt }]))
}

/** The compare API's status of the commit under test against newerSha. */
function compare(newerSha: string, status: string): void {
  writeFileSync(join(bin, `compare-${newerSha}.json`), `${status}\n`)
}

function wait(args: string[], cwd?: string) {
  return runScript(
    'bin/wait-dev-deploy',
    args,
    { PATH: `${bin}:${process.env.PATH}`, WAIT_DEV_DEPLOY_SECONDS: '2', WAIT_DEV_DEPLOY_POLL_SECONDS: '1' },
    cwd,
  )
}

beforeEach(() => {
  bin = tempDir('wait-dev-deploy-')
  fakeCommand(
    bin,
    'gh',
    `case "$*" in
  *compare/*) newer=\${2##*...}; cat "${bin}/compare-\${newer}.json" 2>/dev/null || exit 1 ;;
  *'--workflow Front CI'*) cat "${bin}/front-ci.json" ;;
  *)
    n=$(grep -c -- '--workflow Dev Deploy' "${bin}/gh.calls")
    if [ -f "${bin}/runs.$n.json" ]; then cat "${bin}/runs.$n.json"; else cat "${bin}/runs.json"; fi ;;
esac`,
  )
  runs([])
  writeFileSync(join(bin, 'front-ci.json'), '[]')
})

describe('bin/wait-dev-deploy', () => {
  it('waits for the automatic Dev Deploy of the commit until it succeeds', () => {
    runs([{ status: 'in_progress', conclusion: '' }], 1)
    runs([{ status: 'completed', conclusion: 'success' }])
    const result = wait([sha])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain(`Dev Deploy ${url}: success`)
    const gh = calls(bin, 'gh')
    expect(gh.length).toBeGreaterThanOrEqual(2)
    expect(gh[0]).toContain('run list --workflow Dev Deploy')
    expect(gh[0]).not.toContain('--commit')
    expect(gh[0]).toContain('displayTitle')
    expect(gh[0]).toContain('--event workflow_run')
  })

  it('ignores runs of other commits', () => {
    runs([{ status: 'completed', conclusion: 'success', displayTitle: `Dev Deploy sha-${'b'.repeat(40)}` }])
    const result = wait([sha])
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain(`no Dev Deploy run for ${sha.slice(0, 7)}`)
  })

  it('fails with the run when the deploy fails', () => {
    runs([{ status: 'completed', conclusion: 'failure' }])
    const result = wait([sha])
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('failure')
    expect(result.stdout + result.stderr).toContain(url)
  })

  it('prefers the run that deployed over a skipped duplicate of the same commit', () => {
    runs([
      { status: 'completed', conclusion: 'success' },
      { status: 'completed', conclusion: 'skipped', createdAt: '2026-10-15T12:05:00Z' },
    ])
    const result = wait([sha])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain(`Dev Deploy ${url}: success`)
  })

  it('keeps waiting for a running duplicate while another run of the commit was skipped', () => {
    runs(
      [
        { status: 'completed', conclusion: 'skipped' },
        { status: 'in_progress', conclusion: '' },
      ],
      1,
    )
    runs([
      { status: 'completed', conclusion: 'skipped' },
      { status: 'completed', conclusion: 'success' },
    ])
    const result = wait([sha])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain(': success')
  })

  it('succeeds via a newer commit that contains it when its own run was cancelled', () => {
    runs([
      { status: 'completed', conclusion: 'cancelled' },
      { status: 'completed', conclusion: 'success', displayTitle: `Dev Deploy sha-${newer}` },
    ])
    compare(newer, 'ahead')
    const result = wait([sha])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain(`deployed via ${newer}`)
    expect(calls(bin, 'gh').some((call) => call.includes(`compare/${sha}...${newer}`))).toBe(true)
  })

  it('does not accept a newer deploy whose commit does not contain it', () => {
    runs([
      { status: 'completed', conclusion: 'cancelled' },
      { status: 'completed', conclusion: 'success', displayTitle: `Dev Deploy sha-${newer}` },
    ])
    compare(newer, 'diverged')
    const result = wait([sha])
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('cancelled')
    expect(result.stdout).not.toContain('deployed via')
  })

  it('exits 3 with "dev auto-deploy disabled" when the run was skipped after a green Front CI push', () => {
    runs([{ status: 'completed', conclusion: 'skipped' }])
    frontCi('success')
    const result = wait([sha])
    expect(result.status, result.stdout + result.stderr).toBe(3)
    expect(result.stdout + result.stderr).toContain('dev auto-deploy disabled')
    expect(calls(bin, 'gh').some((call) => call.includes(`run list --workflow Front CI --commit ${sha} --event push`))).toBe(
      true,
    )
  })

  it('keeps waiting when the only skipped run predates the green Front CI push', () => {
    runs([{ status: 'completed', conclusion: 'skipped', createdAt: '2026-10-15T11:58:00Z' }])
    frontCi('success')
    const result = wait([sha])
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).not.toContain('disabled')
  })

  it('fails naming Front CI when the run was skipped because Front CI failed', () => {
    runs([{ status: 'completed', conclusion: 'skipped' }])
    frontCi('failure')
    const result = wait([sha])
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('Front CI')
    expect(result.stdout + result.stderr).toContain('failure')
    expect(result.stdout + result.stderr).not.toContain('disabled')
  })

  it('fails when no Dev Deploy run appears before the deadline', () => {
    const result = wait([sha])
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain(`no Dev Deploy run for ${sha.slice(0, 7)}`)
  })

  it('keeps polling through gh errors until the deadline', () => {
    fakeCommand(bin, 'gh', 'exit 1')
    const result = wait([sha])
    expect(result.status).toBe(1)
    expect(calls(bin, 'gh').length).toBeGreaterThanOrEqual(2)
  })

  it('defaults to the checked-out commit', () => {
    const repo = gitRepo('wait-dev-deploy-repo-')
    const head = commit(repo, 'chore: merge', { 'a.txt': 'a\n' })
    runs([{ status: 'completed', conclusion: 'success', displayTitle: `Dev Deploy sha-${head}` }])
    const result = wait([], repo)
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('success')
  })

  it('waits for a dispatched run created after the given time', () => {
    runs([
      { status: 'completed', conclusion: 'failure', createdAt: '2026-10-15T11:59:00Z' },
      { status: 'completed', conclusion: 'success', createdAt: '2026-10-15T12:00:05Z' },
    ])
    const result = wait(['--dispatched-since', '2026-10-15T12:00:00Z'])
    expect(result.status, result.stdout + result.stderr).toBe(0)
    const gh = calls(bin, 'gh')[0]
    expect(gh).toContain('--event workflow_dispatch')
    expect(gh).not.toContain('--commit')
  })

  it('ignores dispatched runs created before the given time', () => {
    runs([{ status: 'completed', conclusion: 'success', createdAt: '2026-10-15T11:59:00Z' }])
    const result = wait(['--dispatched-since', '2026-10-15T12:00:00Z'])
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).toContain('no Dev Deploy run')
  })

  it.each([
    ['a malformed sha', ['main']],
    ['a malformed time', ['--dispatched-since', '"; .[] |']],
  ])('refuses %s', (_, args) => {
    const result = wait(args)
    expect(result.status).toBe(2)
    expect(calls(bin, 'gh')).toEqual([])
  })
})
