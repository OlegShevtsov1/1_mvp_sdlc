import { beforeEach, describe, expect, it } from 'vitest'
import { calls, fakeCommand, runScript, tempDir } from './support.ts'

const sha = 'f'.repeat(40)
let bin: string

function check(gh: string) {
  fakeCommand(bin, 'gh', gh)
  return runScript('deploy/main_commit_check.sh', [], {
    PATH: `${bin}:${process.env.PATH}`,
    GH_REPO: 'owner/repo',
    VERSION: `sha-${sha}`,
  })
}

beforeEach(() => {
  bin = tempDir('main-commit-')
})

describe('deploy/main_commit_check.sh', () => {
  it.each(['ahead', 'identical'])('accepts a commit main is %s of', (status) => {
    const result = check(`echo ${status}`)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`sha-${sha} is a commit on main`)
    expect(calls(bin, 'gh')[0]).toContain(`repos/owner/repo/compare/${sha}...main`)
  })

  it.each([
    ['diverged', 'echo diverged'],
    ['behind', 'echo behind'],
    ['an unknown commit', 'exit 1'],
  ])('refuses %s', (_, gh) => {
    const result = check(gh)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`::error::sha-${sha} is not a commit on main`)
  })
})
