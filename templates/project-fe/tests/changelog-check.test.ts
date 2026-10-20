import { beforeEach, describe, expect, it } from 'vitest'
import { commit, git, gitRepo, runScript } from './support.ts'

const unreleased = '## [Unreleased]\n\nMinimum backend version: v0.1.0\n\n### Added\n\n### Fixed\n'
const released = '## [0.1.0] - 2026-10-17\n\nMinimum backend version: v0.1.0\n\n### Added\n\n- Runtime config.\n'
const header = '# Changelog\n\n'
const annotation =
  '::error::changelog-check: Type: feat/fix needs an entry under [Unreleased] in CHANGELOG.md (or the label skip-changelog)'

let repo: string
let base: string

function head(files: Record<string, string>): string {
  git(repo, 'checkout', '-q', '-b', 'feature', base)
  return commit(repo, 'feat(login): add login', { 'src/login.ts': 'export {}\n', ...files })
}

function check(headSha: string, env: Record<string, string> = {}) {
  return runScript(
    'scripts/changelog-check.sh',
    [],
    {
      BASE_REF: 'develop',
      HEAD_REF: 'feature/APP-12-add-login',
      BASE_SHA: base,
      HEAD_SHA: headSha,
      LABELS: '',
      PR_BODY: 'What and why\n\nType: feat\n',
      ...env,
    },
    repo,
  )
}

beforeEach(() => {
  repo = gitRepo('changelog-check-')
  base = commit(repo, 'Release 0.1.0', { 'CHANGELOG.md': `${header}${unreleased}\n${released}` })
})

describe('scripts/changelog-check.sh', () => {
  it('fails a feat PR that leaves [Unreleased] unchanged', () => {
    const result = check(head({}))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(annotation)
  })

  it('passes a feat PR with an entry under [Unreleased]', () => {
    const entry = unreleased.replace('### Added\n', '### Added\n\n- Login page.\n')
    const result = check(head({ 'CHANGELOG.md': `${header}${entry}\n${released}` }))
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('changelog-check: ok')
  })

  it('fails a fix PR that only edits an already released section', () => {
    const edited = released.replace('- Runtime config.', '- Runtime config from /config.js.')
    const result = check(head({ 'CHANGELOG.md': `${header}${unreleased}\n${edited}` }), {
      PR_BODY: 'Type: fix',
    })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(annotation)
  })

  it('passes a hotfix PR that adds a new version section directly', () => {
    const hotfix = '## [0.1.1] - 2026-10-20\n\nMinimum backend version: v0.1.0\n\n### Fixed\n\n- Crash.\n'
    const result = check(head({ 'CHANGELOG.md': `${header}${unreleased}\n${hotfix}\n${released}` }), {
      BASE_REF: 'main',
      HEAD_REF: 'hotfix/APP-3-fix-crash',
      PR_BODY: 'Type: fix',
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  it('passes with the label skip-changelog among other labels', () => {
    const result = check(head({}), { LABELS: 'frontend,skip-changelog,urgent' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('skip-changelog')
  })

  it('does not take a label that only contains skip-changelog', () => {
    expect(check(head({}), { LABELS: 'no-skip-changelog-please' }).status).toBe(1)
  })

  it.each(['Type: docs', 'Type: ci', 'no type line', 'Type: feat\nType: fix'])(
    'does not apply to a PR body with %j',
    (body) => {
      const result = check(head({}), { PR_BODY: body })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(result.stdout).toContain('not applicable')
    },
  )

  it('does not apply to the release PR develop into main', () => {
    const result = check(head({}), { BASE_REF: 'main', HEAD_REF: 'develop' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('not applicable (release PR)')
  })

  it('fails a feat PR whose head has no CHANGELOG.md', () => {
    git(repo, 'checkout', '-q', '-b', 'feature', base)
    git(repo, 'rm', '-q', 'CHANGELOG.md')
    git(repo, 'commit', '-q', '-m', 'feat: drop changelog')
    const result = check(git(repo, 'rev-parse', 'HEAD'))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('CHANGELOG.md')
  })

  it('compares against the merge base, not the moving base branch', () => {
    const headSha = head({})
    git(repo, 'checkout', '-q', 'main')
    const entry = unreleased.replace('### Fixed\n', '### Fixed\n\n- Something on develop.\n')
    base = commit(repo, 'docs: entry on develop', { 'CHANGELOG.md': `${header}${entry}\n${released}` })
    expect(check(headSha).status).toBe(1)
  })

  it('never prints the PR body', () => {
    const result = check(head({}), { PR_BODY: 'BODY-SENTINEL $(id)\n\nType: feat' })
    expect(result.stdout + result.stderr).not.toContain('BODY-SENTINEL')
  })
})
