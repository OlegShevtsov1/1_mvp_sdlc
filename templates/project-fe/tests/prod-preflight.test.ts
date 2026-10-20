import { describe, expect, it } from 'vitest'
import { runScript } from './support.ts'

const secrets = {
  AWS_ROLE_ARN: 'SECRET-1',
  VPN_CI_OVPN: 'SECRET-2',
  PROD_SSH_KEY: 'SECRET-3',
  PROD_VPN_IP: 'SECRET-4',
  SENTRY_DSN: 'SECRET-5',
  EXTRA_TOKEN: 'SECRET-6',
}

function run(env: Record<string, string> = {}) {
  return runScript('deploy/prod_preflight.sh', ['EXTRA_TOKEN'], { ...secrets, ...env })
}

describe('deploy/prod_preflight.sh', () => {
  it('passes with every secret set', () => {
    const result = run()
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('all required secrets are set')
    expect(result.stdout + result.stderr).not.toMatch(/SECRET-/)
  })

  it('lists every missing secret by name in one annotation, never a value', () => {
    const result = run({ PROD_SSH_KEY: '', EXTRA_TOKEN: '' })
    expect(result.status).toBe(1)
    const errors = result.stdout.split('\n').filter((line) => line.startsWith('::error::'))
    expect(errors).toHaveLength(1)
    expect(errors[0]).toContain('missing PROD_SSH_KEY EXTRA_TOKEN')
    expect(errors[0]).toContain('Environment "prod" secrets')
    expect(result.stdout + result.stderr).not.toMatch(/SECRET-/)
  })
})
