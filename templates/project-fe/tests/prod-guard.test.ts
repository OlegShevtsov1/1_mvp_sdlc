import { describe, expect, it } from 'vitest'
import { runScript } from './support.ts'

const sha = 'e'.repeat(40)
const tag = 'v1.2.3'
const main = 'refs/heads/main'

function guard(mode: string, env: Record<string, string>) {
  return runScript('deploy/prod_guard.sh', mode ? [mode] : [], { REF: main, ...env })
}

function deploy(env: Record<string, string> = {}) {
  return guard('deploy', { ENVIRONMENT: 'prod', CONFIRM: 'prod', VERSION: tag, ...env })
}

describe('deploy/prod_guard.sh', () => {
  it('runs prod only from main', () => {
    const result = deploy({ REF: 'refs/heads/feature' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('prod runs only from main')
    expect(result.stdout).toBe('')
  })

  it('deploy accepts a release tag', () => {
    const result = deploy()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(`tag=${tag}\n`)
  })

  it.each([sha, `sha-${sha}`])('deploy refuses the commit sha %j: prod deploys only a release tag', (version) => {
    const result = deploy({ VERSION: version })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('prod deploys only a release tag vX.Y.Z (got a commit sha)')
    expect(result.stdout).toBe('')
  })

  it.each([
    [{ ENVIRONMENT: 'dev' }, "environment must be 'prod'"],
    [{ CONFIRM: 'yes' }, "confirm must be exactly 'prod'"],
    [{ CONFIRM: '' }, "confirm must be exactly 'prod'"],
    [{ VERSION: 'abc' }, 'version must be a release tag vX.Y.Z'],
    [{ VERSION: 'v1.2' }, 'version must be a release tag vX.Y.Z'],
    [{ VERSION: '1.2.3' }, 'version must be a release tag vX.Y.Z'],
    [{ VERSION: 'v1.2.3-rc.1' }, 'version must be a release tag vX.Y.Z'],
    [{ VERSION: '' }, 'version must be a release tag vX.Y.Z'],
  ])('deploy refuses %j', (env, message) => {
    const result = deploy(env)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(message)
    expect(result.stdout).toBe('')
  })

  it.each(['status', 'logs'])('manage %s needs no confirm', (action) => {
    const result = guard('manage', { ACTION: action })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('version=\nsha=\n')
  })

  it('manage restart needs confirm=prod', () => {
    expect(guard('manage', { ACTION: 'restart' }).stderr).toContain('restart needs confirm=prod')
    expect(guard('manage', { ACTION: 'restart', CONFIRM: 'prod' }).status).toBe(0)
  })

  it('manage rollback needs the typed confirm ROLLBACK-prod and a version', () => {
    const plain = guard('manage', { ACTION: 'rollback', CONFIRM: 'prod', VERSION: sha })
    expect(plain.status).toBe(1)
    expect(plain.stderr).toContain('rollback needs confirm=ROLLBACK-prod')
    const noVersion = guard('manage', { ACTION: 'rollback', CONFIRM: 'ROLLBACK-prod' })
    expect(noVersion.status).toBe(1)
    expect(noVersion.stderr).toContain('rollback needs a version')
    const result = guard('manage', { ACTION: 'rollback', CONFIRM: 'ROLLBACK-prod', VERSION: `sha-${sha}` })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(`version=sha-${sha}\nsha=${sha}\n`)
  })

  it('manage rollback accepts prod-previous', () => {
    const result = guard('manage', { ACTION: 'rollback', CONFIRM: 'ROLLBACK-prod', VERSION: 'prod-previous' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('version=prod-previous\nsha=\n')
  })

  it.each(['abc', 'v1.2.3', 'prod-current'])('manage rollback refuses the version %j', (version) => {
    const result = guard('manage', { ACTION: 'rollback', CONFIRM: 'ROLLBACK-prod', VERSION: version })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('version must be prod-previous or a 40-hex git sha')
  })

  it('manage remove needs exactly confirm=remove-prod', () => {
    const result = guard('manage', { ACTION: 'remove', CONFIRM: 'prod' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('remove needs confirm=remove-prod')
    expect(guard('manage', { ACTION: 'remove', CONFIRM: 'remove-prod' }).status).toBe(0)
  })

  it('manage refuses an unknown action', () => {
    const result = guard('manage', { ACTION: 'setup', CONFIRM: 'prod' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('unknown action')
  })

  it('needs a mode', () => {
    expect(guard('', {}).status).toBe(2)
  })
})
