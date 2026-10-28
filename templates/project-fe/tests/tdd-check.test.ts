import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { calls, commit, fakeCommand, git, gitRepo, runScript, tempDir } from './support.ts'

let bin: string
let repo: string

beforeEach(() => {
  bin = tempDir('tdd-check-bin-')
  repo = gitRepo('tdd-check-repo-')
  commit(repo, 'chore: base', { 'README.md': 'base\n', 'src/app.ts': 'export const a = 1\n' })
  git(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
  git(repo, 'checkout', '-q', '-b', 'pr')
  fakeCommand(
    bin,
    'npm',
    `git rev-parse HEAD >> "${bin}/npm.where"
case $1 in
  ci) exit 0 ;;
  test) exit "\${NPM_TEST_EXIT:-1}" ;;
esac`,
  )
  fakeCommand(bin, 'gh')
})

function tddCheck(env: Record<string, string> = {}) {
  return runScript(
    'scripts/tdd-check.sh',
    [],
    {
      PATH: `${bin}:${process.env.PATH}`,
      BASE_REF: 'main',
      HEAD_SHA: git(repo, 'rev-parse', 'HEAD'),
      REPO: 'owner/repo',
      ...env,
    },
    repo,
  )
}

function npmRanAt(): string[] {
  try {
    return readFileSync(join(bin, 'npm.where'), 'utf8').trim().split('\n')
  } catch {
    return []
  }
}

describe('scripts/tdd-check.sh', () => {
  it.each([
    ['README.md', 'changed\n'],
    ['.github/workflows/x.yml', 'name: x\n'],
  ])('does not apply when only %s changed', (path, content) => {
    commit(repo, 'docs: no code', { [path]: content })
    const result = tddCheck()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('not applicable')
    expect(calls(bin, 'npm')).toEqual([])
    expect(calls(bin, 'gh')).toEqual([])
  })

  it('requires the first commit to be the test( commit', () => {
    commit(repo, 'feat(x): code first', { 'src/app.ts': 'export const a = 2\n' })
    const result = tddCheck()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::')
    expect(result.stdout).toContain('first commit must start with test(')
    expect(result.stdout).toContain('feat(x): code first')
  })

  it('still applies when the change list is larger than the pipe buffer', () => {
    const pad = Object.fromEntries(
      Array.from({ length: 1200 }, (_, i) => [
        `src/pad/file-${String(i).padStart(4, '0')}-${'x'.repeat(100)}.ts`,
        `export const n = ${i}\n`,
      ]),
    )
    commit(repo, 'feat(x): code first', { 'src/app.ts': 'export const a = 2\n', ...pad })
    expect(git(repo, 'diff', '--name-only', 'main', 'HEAD').length).toBeGreaterThan(100_000)
    const result = tddCheck()
    expect(result.status, result.stdout + result.stderr).toBe(1)
    expect(result.stdout).toContain('first commit must start with test(')
    expect(result.stdout).not.toContain('not applicable')
    expect(calls(bin, 'npm')).toEqual([])
  })

  it.each([
    'src/a/b.test.ts',
    'src/App.test.tsx',
    'tests/x.test.ts',
    'bin/x.test.sh',
    'deploy/lib.test.sh',
    'scripts/a/b.test.sh',
    'docker/x.test.sh',
  ])(
    'rejects a feat( commit that changes the test %s',
    (testFile) => {
      commit(repo, 'test(x): failing test', { [testFile]: 'expect(1).toBe(2)\n' })
      commit(repo, 'feat(x): make it pass', { 'src/app.ts': 'export const a = 2\n', [testFile]: 'weakened\n' })
      const result = tddCheck()
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('tests changed between the test commit and the feat/fix commit')
      expect(result.stdout).toContain(testFile)
      expect(calls(bin, 'npm')).toEqual([])
    },
  )

  it('requires a feat( or fix( commit after the test commit', () => {
    commit(repo, 'test(x): failing test', { 'src/a.test.ts': 'red\n' })
    commit(repo, 'chore(x): code', { 'src/app.ts': 'export const a = 2\n' })
    const result = tddCheck()
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('no feat( or fix( commit')
  })

  it('fails when the tests pass at the test commit', () => {
    commit(repo, 'test(x): not really failing', { 'src/a.test.ts': 'green\n' })
    commit(repo, 'fix(x): code', { 'src/app.ts': 'export const a = 2\n' })
    const result = tddCheck({ NPM_TEST_EXIT: '0' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('tests pass at the test commit (not RED)')
    expect(calls(bin, 'gh')).toEqual([])
  })

  it('reproduces RED at the test commit and records it as a failing status there', () => {
    const red = commit(repo, 'test(x): failing test', { 'src/a.test.ts': 'red\n' })
    commit(repo, 'feat(x): code', { 'src/app.ts': 'export const a = 2\n' })
    commit(repo, 'refactor(x): tidy', { 'src/app.ts': 'export const a = 2 // tidy\n' })
    const result = tddCheck()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(calls(bin, 'npm')).toEqual(['ci', 'test'])
    expect(npmRanAt()).toEqual([red, red])
    const gh = calls(bin, 'gh')
    expect(gh).toHaveLength(1)
    expect(gh[0]).toContain(`api -X POST repos/owner/repo/statuses/${red}`)
    expect(gh[0]).toContain('state=failure')
    expect(gh[0]).toContain('context=tdd-check/red')
    expect(git(repo, 'worktree', 'list')).not.toContain(red.slice(0, 7))
  })

  it('fails when the RED status cannot be recorded', () => {
    const red = commit(repo, 'test(x): failing test', { 'src/a.test.ts': 'red\n' })
    commit(repo, 'feat(x): code', { 'src/app.ts': 'export const a = 2\n' })
    fakeCommand(bin, 'gh', 'exit 1')
    const result = tddCheck()
    expect(result.status).toBe(2)
    expect(result.stderr).toContain(`could not record the RED status on ${red.slice(0, 7)}`)
  })

  it('ignores merge commits from main', () => {
    const red = commit(repo, 'test(x): failing test', { 'src/a.test.ts': 'red\n' })
    git(repo, 'checkout', '-q', 'main')
    const moved = commit(repo, 'chore: main moved', { 'other.md': 'x\n' })
    git(repo, 'update-ref', 'refs/remotes/origin/main', moved)
    git(repo, 'checkout', '-q', 'pr')
    git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'main')
    commit(repo, 'feat(x): code', { 'src/app.ts': 'export const a = 2\n' })
    const result = tddCheck()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(calls(bin, 'gh')[0]).toContain(`statuses/${red}`)
  })

  describe('after merging develop', () => {
    function moveDevelop(subject: string, files: Record<string, string>) {
      git(repo, 'checkout', '-q', 'develop')
      const moved = commit(repo, subject, files)
      git(repo, 'update-ref', 'refs/remotes/origin/develop', moved)
      git(repo, 'checkout', '-q', 'pr')
      git(repo, 'merge', '-q', '--no-ff', '--no-edit', 'develop')
    }

    beforeEach(() => {
      git(repo, 'branch', 'develop', 'main')
      git(repo, 'update-ref', 'refs/remotes/origin/develop', 'main')
    })

    it('counts only the own commits, not the non-test develop commits and the tests they change', () => {
      const red = commit(repo, 'test(x): failing test', { 'src/a.test.ts': 'red\n' })
      moveDevelop('APP-248: tracker (#80)', { 'tests/other.test.ts': 'other\n', 'src/other.ts': 'export const o = 1\n' })
      commit(repo, 'feat(x): code', { 'src/app.ts': 'export const a = 2\n' })
      const result = tddCheck({ BASE_REF: 'develop' })
      expect(result.status, result.stdout + result.stderr).toBe(0)
      expect(calls(bin, 'gh')[0]).toContain(`statuses/${red}`)
    })

    it('still requires the own first commit to be test(', () => {
      moveDevelop('test(y): elsewhere', { 'src/y.test.ts': 'red\n' })
      commit(repo, 'feat(x): code first', { 'src/app.ts': 'export const a = 2\n' })
      commit(repo, 'test(x): failing test', { 'src/a.test.ts': 'red\n' })
      commit(repo, 'fix(x): code', { 'src/app.ts': 'export const a = 3\n' })
      const result = tddCheck({ BASE_REF: 'develop' })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('first commit must start with test(')
      expect(result.stdout).toContain('feat(x): code first')
    })

    it('still rejects an own test change between the test commit and the feat( commit', () => {
      commit(repo, 'test(x): failing test', { 'src/a.test.ts': 'red\n' })
      moveDevelop('APP-248: tracker (#80)', { 'tests/other.test.ts': 'other\n' })
      commit(repo, 'feat(x): code', { 'src/app.ts': 'export const a = 2\n', 'src/a.test.ts': 'weakened\n' })
      const result = tddCheck({ BASE_REF: 'develop' })
      expect(result.status).toBe(1)
      expect(result.stdout).toContain('tests changed between the test commit and the feat/fix commit')
      expect(result.stdout).toContain('src/a.test.ts')
      expect(result.stdout).not.toContain('tests/other.test.ts')
    })
  })

  it.each([
    ['BASE_REF', { BASE_REF: '' }],
    ['HEAD_SHA', { HEAD_SHA: '' }],
    ['REPO', { REPO: '' }],
    ['a malformed HEAD_SHA', { HEAD_SHA: 'abc; rm -rf /' }],
  ])('refuses to run without %s', (_, env) => {
    commit(repo, 'feat(x): code', { 'src/app.ts': 'export const a = 2\n' })
    const result = tddCheck(env)
    expect(result.status).toBe(2)
    expect(calls(bin, 'npm')).toEqual([])
    expect(calls(bin, 'gh')).toEqual([])
  })
})
