import { beforeEach, describe, expect, it } from 'vitest'
import { commit, git, gitRepo, runScript } from './support.ts'

let repo: string

function changelog(version: string, minimum = 'v0.1.0'): string {
  return `# Changelog\n\n## [Unreleased]\n\n### Added\n\n## [${version}] - 2026-10-17\n\nMinimum backend version: ${minimum}\n\n### Added\n\n- Something.\n`
}

function release(files: Record<string, string>, message = 'APP-1: Release prep (#1)\n\nType: docs') {
  return commit(repo, message, files)
}

function annotate(tag: string, rev = 'HEAD') {
  git(repo, 'tag', '-a', tag, '-m', tag, rev)
}

function check(tag: string) {
  return runScript('scripts/release-check.sh', [tag], { MAIN_REF: 'main' }, repo)
}

beforeEach(() => {
  repo = gitRepo('release-check-')
})

describe('scripts/release-check.sh', () => {
  it('accepts an annotated tag on main with the expected number and its CHANGELOG section', () => {
    release({ 'CHANGELOG.md': changelog('0.1.0'), 'deploy/min-be-version': 'v0.1.0\n' })
    annotate('v0.1.0')
    const result = check('v0.1.0')
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('release-check: v0.1.0 ok')
  })

  it('refuses a lightweight tag', () => {
    release({ 'CHANGELOG.md': changelog('0.1.0'), 'deploy/min-be-version': 'v0.1.0\n' })
    git(repo, 'tag', 'v0.1.0')
    const result = check('v0.1.0')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::release-check: v0.1.0 is not an annotated tag')
  })

  it('refuses a tag that is not an ancestor of main', () => {
    release({ 'README.md': 'app' })
    git(repo, 'checkout', '-q', '-b', 'side')
    release({ 'CHANGELOG.md': changelog('0.1.0'), 'deploy/min-be-version': 'v0.1.0\n' })
    annotate('v0.1.0')
    const result = check('v0.1.0')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('not an ancestor of main')
  })

  it('refuses a number that next-version.sh does not give, naming both', () => {
    release({ 'CHANGELOG.md': changelog('0.1.0'), 'deploy/min-be-version': 'v0.1.0\n' })
    annotate('v0.1.0')
    release({ 'CHANGELOG.md': changelog('0.3.0') }, 'APP-2: Add login (#2)\n\nType: feat')
    annotate('v0.3.0')
    const result = check('v0.3.0')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('v0.3.0')
    expect(result.stdout).toContain('expected v0.2.0')
  })

  it('refuses a tag without its CHANGELOG section', () => {
    release({ 'CHANGELOG.md': changelog('0.0.9'), 'deploy/min-be-version': 'v0.1.0\n' })
    annotate('v0.1.0')
    const result = check('v0.1.0')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('no section [0.1.0] in CHANGELOG.md')
  })

  it('refuses a section whose minimum backend version differs from deploy/min-be-version', () => {
    release({ 'CHANGELOG.md': changelog('0.1.0', 'v0.1.0'), 'deploy/min-be-version': 'v0.2.0\n' })
    annotate('v0.1.0')
    const result = check('v0.1.0')
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Minimum backend version')
    expect(result.stdout).toContain('deploy/min-be-version')
  })

  it.each(['v1.2', '1.2.3', 'v1.2.3-rc.1'])('refuses the tag name %j', (tag) => {
    release({ 'CHANGELOG.md': changelog('0.1.0'), 'deploy/min-be-version': 'v0.1.0\n' })
    annotate(tag)
    const result = check(tag)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('must be vX.Y.Z')
  })
})
