import { beforeEach, describe, expect, it } from 'vitest'
import { calls, fakeCommand, runScript, tempDir } from './support.ts'

const sha = 'a'.repeat(40)
let bin: string

function guard(gh: string, env: Record<string, string> = {}) {
  fakeCommand(bin, 'gh', gh)
  return runScript('scripts/main-guard.sh', [], {
    PATH: `${bin}:${process.env.PATH}`,
    REPO: 'owner/repo',
    SHA: sha,
    MAIN_GUARD_SLEEP: '0',
    ...env,
  })
}

beforeEach(() => {
  bin = tempDir('main-guard-')
})

describe('scripts/main-guard.sh', () => {
  it('passes a commit that came from a merged pull request', () => {
    const result = guard('echo 7')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('came from merged PR #7')
    expect(calls(bin, 'gh')[0]).toContain(`repos/owner/repo/commits/${sha}/pulls`)
  })

  it('fails a commit without a merged pull request after retrying', () => {
    const result = guard('echo')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::')
    expect(calls(bin, 'gh')).toHaveLength(5)
  })

  it('cannot decide when GitHub answers with an error', () => {
    const result = guard('exit 1')
    expect(result.status).toBe(2)
  })

  it('refuses a malformed sha without calling GitHub', () => {
    const result = guard('echo 7', { SHA: 'main; echo x' })
    expect(result.status).toBe(2)
    expect(calls(bin, 'gh')).toEqual([])
  })

  it('names the branch it guards', () => {
    const result = guard('echo', { BRANCH: 'develop' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('reached develop without a merged PR')
  })

  it('refuses a malformed branch without calling GitHub', () => {
    const result = guard('echo 7', { BRANCH: 'develop; echo x' })
    expect(result.status).toBe(2)
    expect(calls(bin, 'gh')).toEqual([])
  })
})
