import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const script = join(import.meta.dirname, '..', 'docker', '40-config-js.sh')

function run(env: Record<string, string>) {
  const out = join(mkdtempSync(join(tmpdir(), 'config-js-')), 'config.js')
  const result = spawnSync('sh', [script], {
    env: { PATH: process.env.PATH ?? '', CONFIG_JS_PATH: out, ...env },
    encoding: 'utf8',
  })
  return { ...result, out }
}

const valid = {
  API_URL: 'https://api.example.test',
  SENTRY_DSN: 'https://key@errors.example.test/7',
  ENV_NAME: 'dev',
}

describe('docker/40-config-js.sh', () => {
  it('writes config.js from the container env, with APP_VERSION from KAMAL_VERSION', () => {
    const { status, out } = run({ ...valid, KAMAL_VERSION: 'sha-abc123' })
    expect(status).toBe(0)
    expect(readFileSync(out, 'utf8')).toBe(
      [
        'window.APP_CONFIG = {',
        '  API_URL: "https://api.example.test",',
        '  SENTRY_DSN: "https://key@errors.example.test/7",',
        '  ENV_NAME: "dev",',
        '  APP_VERSION: "sha-abc123",',
        '};',
        '',
      ].join('\n'),
    )
  })

  it('uses APP_VERSION "local" outside Kamal', () => {
    const { status, out } = run(valid)
    expect(status).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain('  APP_VERSION: "local",\n')
  })

  it('accepts an empty SENTRY_DSN (Sentry off)', () => {
    const { status, out } = run({ ...valid, SENTRY_DSN: '' })
    expect(status).toBe(0)
    expect(readFileSync(out, 'utf8')).toContain('  SENTRY_DSN: "",\n')
  })

  it('fails without API_URL and writes nothing', () => {
    const { status, stderr, out } = run({ SENTRY_DSN: '', ENV_NAME: 'dev' })
    expect(status).not.toBe(0)
    expect(stderr).toContain('API_URL')
    expect(existsSync(out)).toBe(false)
  })

  it('fails without ENV_NAME and writes nothing', () => {
    const { status, stderr, out } = run({ API_URL: valid.API_URL })
    expect(status).not.toBe(0)
    expect(stderr).toContain('ENV_NAME')
    expect(existsSync(out)).toBe(false)
  })

  it.each([
    ['API_URL', 'https://x".example.test'],
    ['SENTRY_DSN', 'https://k@x/1<script>'],
    ['ENV_NAME', "dev'; alert(1)"],
  ])('rejects %s with characters unsafe in JS, without echoing the value', (name, value) => {
    const { status, stderr, out } = run({ ...valid, [name]: value })
    expect(status).not.toBe(0)
    expect(stderr).toContain(`${name} has invalid characters`)
    expect(stderr).not.toContain(value)
    expect(existsSync(out)).toBe(false)
  })
})
