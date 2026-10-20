import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { calls, fakeCommand, projectEnv, runScript, tempDir } from './support.ts'

const prodVersion = `prod-sha-${'a'.repeat(40)}`
let bin: string

function run(args: string[], env: Record<string, string> = {}) {
  return runScript('deploy/manage.sh', args, {
    PATH: `${bin}:${process.env.PATH}`,
    PROD_VPN_IP: 'prod-host.invalid',
    SENTRY_DSN: 'SECRET-SENTINEL',
    ECR_REGISTRY: 'registry.invalid',
    KAMAL_REGISTRY_PASSWORD: 'SECRET-SENTINEL2',
    DEPLOY_WAIT_SECONDS: '1',
    DEPLOY_POLL_SECONDS: '1',
    ...env,
  })
}

beforeEach(() => {
  bin = tempDir('manage-bin-')
  const configJs = join(bin, 'config.js')
  writeFileSync(configJs, `window.APP_CONFIG = {\n  ENV_NAME: "prod",\n  APP_VERSION: "${prodVersion}",\n};\n`)
  fakeCommand(bin, 'kamal', `[ "$1 $2" != "app version" ] || echo "${prodVersion}"`)
  fakeCommand(bin, 'aws', 'exit 1')
  fakeCommand(
    bin,
    'curl',
    `case "\${@: -1}" in
  */health) echo ok ;;
  */config.js) cat "${configJs}" ;;
  *) exit 22 ;;
esac`,
  )
})

describe('deploy/manage.sh', () => {
  it('status shows the details and the running version', () => {
    const result = run(['status'])
    expect(result.status, result.stderr).toBe(0)
    expect(calls(bin, 'kamal')).toEqual(['details -d prod', 'app version -d prod'])
  })

  it('logs shows the last app log lines', () => {
    expect(run(['logs']).status).toBe(0)
    expect(calls(bin, 'kamal')).toEqual(['app logs -d prod --lines 200'])
  })

  it('restart boots the running version again and waits until it is served', () => {
    const result = run(['restart'])
    expect(result.status, result.stderr).toBe(0)
    expect(calls(bin, 'kamal')).toEqual(['app version -d prod -q', `app boot -d prod --version ${prodVersion}`])
    expect(calls(bin, 'curl').join('\n')).toContain(`https://app.${projectEnv().PROJECT_ZONE}/health`)
    expect(result.stdout).toContain(`ready: ${prodVersion}`)
  })

  it('restart boots nothing when the running version cannot be read', () => {
    fakeCommand(bin, 'kamal', `[ "$1 $2" != "app version" ] || echo "WARN no lock; ${prodVersion}"`)
    const result = run(['restart'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('could not read the running prod version')
    expect(calls(bin, 'kamal')).toEqual(['app version -d prod -q'])
  })

  it('remove removes only the app, never the shared proxy', () => {
    expect(run(['remove']).status).toBe(0)
    expect(calls(bin, 'kamal')).toEqual(['app remove -d prod'])
  })

  it('never touches the shared kamal-proxy', () => {
    for (const action of ['status', 'logs', 'restart', 'remove']) run([action])
    for (const call of calls(bin, 'kamal')) {
      expect(call).not.toMatch(/^remove/)
      expect(call).not.toContain('proxy')
    }
    expect(calls(bin, 'kamal').length).toBeGreaterThan(0)
  })

  it('refuses an unknown action without calling Kamal', () => {
    const result = run(['rollback'])
    expect(result.status).toBe(2)
    expect(calls(bin, 'kamal')).toEqual([])
  })

  it('names a missing PROD_VPN_IP without calling Kamal', () => {
    const result = run(['status'], { PROD_VPN_IP: '' })
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('PROD_VPN_IP')
    expect(calls(bin, 'kamal')).toEqual([])
  })

  it('prints no secret', () => {
    const result = run(['restart'])
    expect(result.stdout + result.stderr).not.toContain('SECRET-SENTINEL')
  })
})
