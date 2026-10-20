import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { commit, git, gitRepo, repoRoot, tempDir } from './support.ts'

const hooks = join(repoRoot, 'scripts', 'git-hooks')
let clone: string
let remote: string

function push(...args: string[]) {
  return spawnSync('git', ['-c', `core.hooksPath=${hooks}`, 'push', ...args], { cwd: clone, encoding: 'utf8' })
}

function remoteTag(tag: string): string {
  return git(remote, 'rev-parse', '--verify', '--quiet', `refs/tags/${tag}`)
}

beforeEach(() => {
  remote = tempDir('tag-remote-')
  git(remote, 'init', '-q', '--bare')
  clone = gitRepo('tag-clone-')
  git(clone, 'remote', 'add', 'origin', remote)
  commit(clone, 'first', { 'a.txt': '1' })
  git(clone, 'tag', '-a', 'v0.1.0', '-m', 'v0.1.0')
  const result = push('origin', 'main', 'v0.1.0')
  expect(result.status, result.stderr).toBe(0)
})

describe('scripts/git-hooks/pre-push', () => {
  it('lets new release tags and branch pushes through', () => {
    commit(clone, 'second', { 'a.txt': '2' })
    git(clone, 'tag', '-a', 'v0.2.0', '-m', 'v0.2.0')
    const result = push('origin', 'main', 'v0.2.0')
    expect(result.status, result.stderr).toBe(0)
    expect(remoteTag('v0.2.0')).not.toBe('')
  })

  it('refuses to move a published tag, even forced', () => {
    const before = remoteTag('v0.1.0')
    commit(clone, 'second', { 'a.txt': '2' })
    git(clone, 'tag', '-f', '-a', 'v0.1.0', '-m', 'moved')
    const result = push('--force', 'origin', 'v0.1.0')
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('pre-push: published tag v0.1.0 is immutable')
    expect(remoteTag('v0.1.0')).toBe(before)
  })

  it.each([
    ['--delete', ['origin', '--delete', 'v0.1.0']],
    ['an empty source refspec', ['origin', ':refs/tags/v0.1.0']],
  ])('refuses to delete a published tag with %s', (_, args) => {
    const before = remoteTag('v0.1.0')
    const result = push(...args)
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('pre-push: published tag v0.1.0 is immutable')
    expect(remoteTag('v0.1.0')).toBe(before)
  })

  it('leaves tags that are not release tags alone', () => {
    git(clone, 'tag', 'probe')
    expect(push('origin', 'probe').status).toBe(0)
    expect(push('origin', '--delete', 'probe').status).toBe(0)
  })
})

describe('Claude Code permissions', () => {
  it('deny force-pushing, deleting and re-tagging in every argument order', () => {
    const settings = JSON.parse(readFileSync(join(repoRoot, '.claude', 'settings.json'), 'utf8')) as {
      permissions: { deny: string[] }
    }
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining([
        'Bash(git push --force*)',
        'Bash(git push --delete*)',
        'Bash(git tag -d*)',
        'Bash(git push * --delete*)',
        'Bash(git push * -d *)',
        'Bash(git push * --force*)',
        'Bash(git push * -f*)',
        'Bash(git push * +*)',
        'Bash(git push * :*)',
        'Bash(git tag -f*)',
        'Bash(git tag --force*)',
        'Bash(git tag --delete*)',
      ]),
    )
  })
})
