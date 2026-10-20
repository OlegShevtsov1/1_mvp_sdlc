import { beforeEach, describe, expect, it } from 'vitest'
import { calls, commit, fakeCommand, gitRepo, runScript, tempDir } from './support.ts'

let bin: string
let repo: string

function rollback(env: Record<string, string> = {}) {
  return runScript(
    'bin/dev-rollback',
    [],
    { PATH: `${bin}:${process.env.PATH}`, WAIT_DEV_DEPLOY: `${bin}/waiter`, ...env },
    repo,
  )
}

beforeEach(() => {
  bin = tempDir('dev-rollback-')
  repo = gitRepo('dev-rollback-repo-')
  fakeCommand(bin, 'gh')
  fakeCommand(bin, 'waiter', 'exit 0')
})

describe('bin/dev-rollback', () => {
  it('dispatches Dev Deploy back to the commit before the merge, then waits for that run', () => {
    const previous = commit(repo, 'chore: before', { 'a.txt': 'a\n' })
    commit(repo, 'feat: merged', { 'a.txt': 'b\n' })
    const result = rollback()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(calls(bin, 'gh')).toEqual([`workflow run dev-deploy.yml --ref main -f rollback_to=${previous}`])
    expect(calls(bin, 'waiter')).toHaveLength(1)
    expect(calls(bin, 'waiter')[0]).toMatch(/^--dispatched-since \d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/)
  })

  it("passes on the waiter's failure", () => {
    commit(repo, 'chore: before', { 'a.txt': 'a\n' })
    commit(repo, 'feat: merged', { 'a.txt': 'b\n' })
    fakeCommand(bin, 'waiter', 'exit 1')
    expect(rollback().status).toBe(1)
  })

  it('fails when the dispatch fails, without waiting', () => {
    commit(repo, 'chore: before', { 'a.txt': 'a\n' })
    commit(repo, 'feat: merged', { 'a.txt': 'b\n' })
    fakeCommand(bin, 'gh', 'exit 1')
    expect(rollback().status).toBe(1)
    expect(calls(bin, 'waiter')).toEqual([])
  })

  it('refuses when there is no earlier commit', () => {
    commit(repo, 'chore: only', { 'a.txt': 'a\n' })
    const result = rollback()
    expect(result.status).toBe(2)
    expect(calls(bin, 'gh')).toEqual([])
  })
})
