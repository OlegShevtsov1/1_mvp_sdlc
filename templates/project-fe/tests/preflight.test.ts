import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { projectEnv, runScript, tempDir } from './support.ts'

const sha = 'c'.repeat(40)
const secrets = {
  AWS_ROLE_ARN: 'SECRET-1',
  VPN_CI_OVPN: 'SECRET-2',
  SRV_DEPLOY_SSH_KEY: 'SECRET-3',
  SENTRY_DSN: 'SECRET-4',
  EXTRA_TOKEN: 'SECRET-5',
}

let output: string

function run(env: Record<string, string> = {}) {
  const result = runScript('deploy/preflight.sh', ['dev', 'EXTRA_TOKEN'], {
    ...secrets,
    DEPLOY_SHA: sha,
    GITHUB_OUTPUT: output,
    ...env,
  })
  return { ...result, outputs: readFileSync(output, 'utf8') }
}

beforeEach(() => {
  output = join(tempDir('preflight-'), 'github_output')
  writeFileSync(output, '')
})

describe('deploy/preflight.sh', () => {
  it('passes with every secret set and publishes the deploy parameters', () => {
    const { PROJECT_NAME: name, PROJECT_ZONE: zone } = projectEnv()
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs.trim().split('\n')).toEqual([
      `project=${name}`,
      `url=https://app.dev.${zone}`,
      `image=${name}-front`,
      `cache_image=${name}-front-build-cache`,
      `service=${name}-fe-dev`,
      'mode=deploy',
      `version=sha-${sha}`,
      `sha=${sha}`,
    ])
    expect(result.stdout + result.stderr).not.toMatch(/SECRET-/)
  })

  it('lists every missing secret by name in one annotation, never a value', () => {
    const result = run({ SRV_DEPLOY_SSH_KEY: '', EXTRA_TOKEN: '' })
    expect(result.status).toBe(1)
    const error = result.stdout.split('\n').find((line) => line.startsWith('::error::'))
    expect(error).toContain('missing SRV_DEPLOY_SSH_KEY EXTRA_TOKEN')
    expect(result.stdout + result.stderr).not.toMatch(/SECRET-/)
    expect(result.outputs).toBe('')
  })

  it.each(['refs/heads/develop', 'refs/heads/hotfix/APP-92-guard', 'refs/heads/main'])(
    'deploys %s from GitHub Actions',
    (ref) => {
      const result = run({ GITHUB_ACTIONS: 'true', GITHUB_REF: ref })
      expect(result.status, result.stderr).toBe(0)
      expect(result.outputs).toContain('mode=deploy\n')
    },
  )

  it.each([
    'refs/heads/feature/APP-92-guard',
    'refs/heads/archon/task-factory-1',
    'refs/heads/hotfix',
    'refs/heads/hotfix/',
    'refs/heads/developer',
    'refs/heads/main-twin',
    'refs/tags/v1.0.0',
    'refs/pull/1/merge',
    '',
  ])('refuses %j from GitHub Actions', (ref) => {
    const result = run({ GITHUB_ACTIONS: 'true', GITHUB_REF: ref })
    expect(result.status).toBe(1)
    const error = result.stdout.split('\n').find((line) => line.startsWith('::error::'))
    expect(error).toContain('Dev Deploy guard')
    expect(error).toContain('develop')
    expect(result.outputs).toBe('')
    expect(result.stdout + result.stderr).not.toMatch(/SECRET-/)
  })

  it('does not check the ref outside GitHub Actions', () => {
    const result = run({ GITHUB_REF: 'refs/heads/feature/APP-92-guard' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs).toContain('mode=deploy\n')
  })

  it('switches to rollback mode for a full git sha', () => {
    const target = 'd'.repeat(40)
    const result = run({ ROLLBACK_TO: target })
    expect(result.status, result.stderr).toBe(0)
    expect(result.outputs).toContain('mode=rollback\n')
    expect(result.outputs).toContain(`version=sha-${target}\n`)
  })

  it.each(['abc', `sha-${'d'.repeat(40)}`, 'd'.repeat(41)])('rejects ROLLBACK_TO %j', (bad) => {
    expect(run({ ROLLBACK_TO: bad }).status).toBe(1)
  })

  it('is Dev Deploy only', () => {
    const result = runScript('deploy/preflight.sh', ['prod'], { ...secrets, DEPLOY_SHA: sha, GITHUB_OUTPUT: output })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('deploy/prod_guard.sh')
    expect(readFileSync(output, 'utf8')).toBe('')
  })
})
