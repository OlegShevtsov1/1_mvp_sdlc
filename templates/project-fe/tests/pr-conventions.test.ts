import { existsSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { calls, fakeCommand, projectEnv, runScript, tempDir } from './support.ts'

// The ticket key is PROJECT_NAME from config/project.env in capitals, derived the same way as the script.
const key = projectEnv().PROJECT_NAME.toUpperCase()
const good = {
  BASE_REF: 'develop',
  HEAD_REF: `feature/${key}-12-add-login`,
  PR_TITLE: `${key}-12: Add login`,
  PR_BODY: 'What and why\n\nType: feat\n',
}
let bin: string

function check(env: Partial<typeof good> & { REPO?: string; PROJECT_ENV_FILE?: string } = {}) {
  return runScript('scripts/pr-conventions.sh', [], {
    PATH: `${bin}:${process.env.PATH}`,
    REPO: 'owner/repo',
    ...good,
    ...env,
  })
}

function errors(stdout: string): string[] {
  return stdout.split('\n').filter((line) => line.startsWith('::error::pr-conventions:'))
}

beforeEach(() => {
  bin = tempDir('pr-conventions-')
  fakeCommand(bin, 'gh', 'echo 1')
})

describe('scripts/pr-conventions.sh', () => {
  it('passes a feature branch, a key title and one Type line', () => {
    const result = check()
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('pr-conventions: ok')
    expect(calls(bin, 'gh')[0]).toContain('repos/owner/repo/git/matching-refs/heads/develop')
  })

  it.each([
    [`hotfix/${key}-3-fix-crash`, 'main'],
    ['archon/task-factory-1792086449826', 'develop'],
    ['archon/task-factory-test', 'develop'],
    ['develop', 'main'],
  ])('accepts the branch %s into %s', (head, base) => {
    const result = check({ HEAD_REF: head, BASE_REF: base })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  it.each([
    ['wip-test', 'develop'],
    [`feature/${key}-12-Add_Login`, 'develop'],
    [`feature/${key.toLowerCase()}-12-add-login`, 'develop'],
    ['feature/APP-12-add-login', 'develop'],
    ['feature/add-login', 'develop'],
    ['develop', 'develop'],
    ['main', 'develop'],
  ])('rejects the branch %s into %s', (head, base) => {
    const result = check({ HEAD_REF: head, BASE_REF: base })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::pr-conventions: branch')
  })

  it.each(['feat: add login', `${key}-12:`, 'APP-12: x'])('rejects the title %j', (title) => {
    const result = check({ PR_TITLE: title })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`PR title must match ^${key}-[0-9]+: .+$`)
  })

  // Every release has its own card; <KEY>-0 is only for card-less chores (decision 91).
  it.each([
    [`${key}-0: Release v1.2.3`, 'develop', 'main'],
    [`${key}-0: Release 1.2.3 changelog`, 'archon/task-factory-1792086449826', 'develop'],
    [`${key}-00: Release v1.2.3`, 'develop', 'main'],
  ])('rejects the card-less release title %j from %s into %s', (title, head, base) => {
    const result = check({ PR_TITLE: title, HEAD_REF: head, BASE_REF: base })
    expect(result.status).toBe(1)
    expect(errors(result.stdout)).toHaveLength(1)
    expect(result.stdout).toContain('decision 91')
    expect(result.stdout).toContain(`${key}-<n>: Release vX.Y.Z`)
  })

  it.each([`${key}-0: Sync main (abc1234)`, `${key}-12: Release v1.2.3`])(
    'accepts the title %j from develop into main',
    (title) => {
      const result = check({ PR_TITLE: title, HEAD_REF: 'develop', BASE_REF: 'main' })
      expect(result.status, result.stdout + result.stderr).toBe(0)
    },
  )

  it('accepts the key derived from config/project.env', () => {
    const result = check({ PR_TITLE: `${key}-12: x` })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  it('names the derived key in the branch error', () => {
    const result = check({ HEAD_REF: 'feature/APP-12-add-login' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain(`feature/${key}-<n>-<slug> or hotfix/${key}-<n>-<slug>`)
  })

  it.each(['bad-name', '1abc', ''])('refuses a PROJECT_NAME %j that gives no valid key', (name) => {
    const file = join(tempDir('pr-conventions-env-'), 'project.env')
    writeFileSync(file, `PROJECT_NAME=${name}\nPROJECT_ZONE=example.test\n`)
    const result = check({ PROJECT_ENV_FILE: file })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('invalid ticket key')
    expect(calls(bin, 'gh')).toEqual([])
  })

  it('rejects a body without a Type line', () => {
    const result = check({ PR_BODY: 'What and why\n' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('exactly one Type: line')
    expect(result.stdout).toContain('found 0')
  })

  it('rejects a body with two Type lines', () => {
    const result = check({ PR_BODY: 'What\n\nType: feat\nType: fix\n' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('found 2')
  })

  it('rejects a Type outside the allowed list', () => {
    const result = check({ PR_BODY: 'What\n\nType: feature\n' })
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('Type: line must be one of feat, fix, chore, docs, refactor, test, ci')
  })

  it('accepts a body edited on the web with CRLF line ends', () => {
    const result = check({ PR_BODY: 'What\r\n\r\nType: fix\r\n' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
  })

  it('names every violated rule in one run', () => {
    const result = check({ HEAD_REF: 'wip-test', PR_TITLE: 'wip', PR_BODY: '' })
    expect(result.status).toBe(1)
    const lines = errors(result.stdout)
    expect(lines).toHaveLength(3)
    expect(lines[0]).toContain('branch')
    expect(lines[1]).toContain('PR title')
    expect(lines[2]).toContain('Type: line')
  })

  it('does not apply before the develop branch exists', () => {
    fakeCommand(bin, 'gh', 'echo 0')
    const result = check({ HEAD_REF: 'wip-test', PR_TITLE: 'wip' })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(result.stdout).toContain('not applicable')
  })

  it('fails closed when GitHub answers with an error', () => {
    fakeCommand(bin, 'gh', 'exit 1')
    const result = check()
    expect(result.status).toBe(2)
  })

  it('treats the pull request text as data', () => {
    const marker = join(tempDir('pr-conventions-pwned-'), 'pwned')
    const result = check({
      PR_TITLE: `${key}-1: $(touch ${marker})`,
      PR_BODY: `\`touch ${marker}\`\n\nType: fix\n`,
    })
    expect(result.status, result.stdout + result.stderr).toBe(0)
    expect(existsSync(marker)).toBe(false)
  })

  it('refuses a malformed repository without calling GitHub', () => {
    const result = check({ REPO: 'owner/repo; x' })
    expect(result.status).toBe(2)
    expect(calls(bin, 'gh')).toEqual([])
  })
})
