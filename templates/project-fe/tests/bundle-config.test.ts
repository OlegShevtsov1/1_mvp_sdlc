import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'
import { projectEnv, runScript, tempDir } from './support.ts'

let dir: string

function check(...dirs: string[]) {
  return runScript('scripts/check-bundle-config.sh', dirs, {})
}

function file(name: string, text: string): void {
  mkdirSync(join(dir, 'assets'), { recursive: true })
  writeFileSync(join(dir, name), text)
}

beforeEach(() => {
  dir = tempDir('bundle-config-')
})

describe('scripts/check-bundle-config.sh', () => {
  it('finds a host of the project zone and prints only file:line', () => {
    const host = `app.dev.${projectEnv().PROJECT_ZONE}`
    file('assets/index.js', `const ok = 1\nfetch("https://${host}/health")\n`)
    const result = check(dir)
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('::error::')
    expect(result.stdout).toContain(`${join(dir, 'assets/index.js')}:2`)
    expect(result.stdout + result.stderr).not.toContain(host)
  })

  it('finds an error tracker host', () => {
    file('assets/index.js', 'const t = "https://track.example.test"\n')
    expect(check(dir).status).toBe(1)
  })

  it('finds a DSN value outside test files', () => {
    file('assets/index.js', 'init({ dsn: "https://key@errors.example.test/7" })\n')
    const result = check(dir)
    expect(result.status).toBe(1)
    expect(result.stdout + result.stderr).not.toContain('key@')
  })

  it('allows a DSN value in a test file', () => {
    file('x.test.ts', 'const dsn = "https://key@errors.example.test/7"\n')
    expect(check(dir).status).toBe(0)
  })

  it('allows the name of the runtime config key', () => {
    file('config.ts', 'const dsn = config.SENTRY_DSN\n')
    const result = check(dir)
    expect(result.status, result.stdout).toBe(0)
    expect(result.stdout).toContain('bundle-config check: clean')
  })

  it('fails when a directory is missing', () => {
    const result = check(join(dir, 'dist'))
    expect(result.status).toBe(2)
    expect(result.stdout + result.stderr).toContain('run npm run build first')
  })

  it('passes the real src/', () => {
    const result = check('src')
    expect(result.status, result.stdout).toBe(0)
  })
})
