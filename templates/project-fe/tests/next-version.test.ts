import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { commit, git, gitRepo, repoRoot, runScript } from './support.ts'

let repo: string
let counter: number

function squash(subject: string, body: string): string {
  counter += 1
  return commit(repo, `${subject}\n\n${body}`, { [`file-${counter}.txt`]: subject })
}

function tag(name: string, rev = 'HEAD') {
  git(repo, 'tag', '-a', name, '-m', name, rev)
}

function nextVersion(...args: string[]) {
  return runScript('scripts/next-version.sh', args, {}, repo)
}

beforeEach(() => {
  repo = gitRepo('next-version-')
  counter = 0
  commit(repo, 'Initial commit without a Type line', { 'README.md': 'app' })
})

describe('scripts/next-version.sh', () => {
  it('starts at 0.1.0 when there is no release tag, whatever the history says', () => {
    squash('Old change (#1)', 'No type line here')
    const result = nextVersion()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('0.1.0\n')
  })

  it('bumps MINOR when a feat is among the changes since the last tag', () => {
    tag('v0.1.0')
    squash('APP-1: Fix the header (#2)', 'Type: fix')
    squash('APP-2: Add login (#3)', 'What and why\n\nType: feat')
    squash('APP-3: Document login (#4)', 'Type: docs')
    const result = nextVersion()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('0.2.0\n')
  })

  it('bumps PATCH when only fixes changed', () => {
    tag('v0.1.0')
    squash('APP-1: Fix the header (#2)', 'Type: fix')
    expect(nextVersion().stdout).toBe('0.1.1\n')
  })

  it('bumps MAJOR on a BREAKING CHANGE footer', () => {
    tag('v0.1.0')
    squash('APP-1: Drop the old config (#2)', 'Type: fix\n\nBREAKING CHANGE: window.APP_CONFIG.API is gone')
    squash('APP-2: Add login (#3)', 'Type: feat')
    const result = nextVersion()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('1.0.0\n')
  })

  it('ignores merge commits such as release and back-merge commits', () => {
    tag('v0.1.0')
    git(repo, 'checkout', '-q', '-b', 'develop')
    squash('APP-1: Fix the header (#2)', 'Type: fix')
    git(repo, 'checkout', '-q', 'main')
    git(repo, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #5 from owner/develop', 'develop')
    const result = nextVersion()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('0.1.1\n')
  })

  it('refuses to guess and lists every commit without exactly one Type line', () => {
    tag('v0.1.0')
    const missing = squash('APP-1: No type (#2)', 'Just text')
    squash('APP-2: Fine (#3)', 'Type: feat')
    const twice = squash('APP-3: Two types (#4)', 'Type: feat\nType: fix')
    const invalid = squash('APP-4: Bad type (#5)', 'Type: feature')
    const result = nextVersion()
    expect(result.status).toBe(1)
    expect(result.stdout).toBe('')
    expect(result.stderr).toContain(`${missing.slice(0, 7)} APP-1: No type (#2)`)
    expect(result.stderr).toContain(`${twice.slice(0, 7)} APP-3: Two types (#4)`)
    expect(result.stderr).toContain(`${invalid.slice(0, 7)} APP-4: Bad type (#5)`)
    expect(result.stderr).not.toContain('APP-2')
  })

  it('has nothing to release when only chore, docs, refactor, test or ci changed', () => {
    tag('v0.1.0')
    squash('APP-3: Document login (#4)', 'Type: docs')
    squash('APP-0: CI tweak (#5)', 'Type: ci')
    const result = nextVersion()
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('nothing to release since v0.1.0')
  })

  it('gives the same answer on the tagged commit as before tagging it', () => {
    tag('v0.1.0')
    squash('APP-2: Add login (#3)', 'Type: feat')
    expect(nextVersion().stdout).toBe('0.2.0\n')
    tag('v0.2.0')
    const result = nextVersion('v0.2.0^{commit}')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('0.2.0\n')
  })

  it('compares versions numerically and ignores tags that are not vX.Y.Z', () => {
    tag('v0.9.0')
    squash('APP-1: Fix (#2)', 'Type: fix')
    tag('v0.10.0')
    tag('v1.0.0-rc.1')
    tag('release-2')
    squash('APP-2: Fix again (#3)', 'Type: fix')
    expect(nextVersion().stdout).toBe('0.10.1\n')
  })

  it('prints the previous release tag on request', () => {
    expect(nextVersion('--previous-tag').stdout).toBe('')
    tag('v0.1.0')
    squash('APP-2: Add login (#3)', 'Type: feat')
    tag('v0.2.0')
    const result = nextVersion('--previous-tag', 'v0.2.0')
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('v0.1.0\n')
  })

  it('accepts exactly the Type: values the PR conventions check lets merge', () => {
    const types = (script: string) =>
      readFileSync(join(repoRoot, 'scripts', script), 'utf8').match(/Type: \(([a-z|]+)\)/)?.[1]
    expect(types('next-version.sh')).toBe('feat|fix|chore|docs|refactor|test|ci')
    expect(types('next-version.sh')).toBe(types('pr-conventions.sh'))
  })
})
