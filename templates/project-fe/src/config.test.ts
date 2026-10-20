import { describe, expect, it } from 'vitest'
import { readConfig } from './config.ts'

describe('readConfig', () => {
  it('returns the runtime config as served in /config.js', () => {
    const served = {
      API_URL: 'https://api.example.test',
      SENTRY_DSN: 'https://key@errors.example.test/7',
      ENV_NAME: 'dev',
      APP_VERSION: 'sha-abc123',
    }
    expect(readConfig(served)).toEqual(served)
  })

  it('falls back to defaults when /config.js is missing or partial', () => {
    const defaults = { API_URL: '', SENTRY_DSN: '', ENV_NAME: 'unknown', APP_VERSION: 'local' }
    expect(readConfig(undefined)).toEqual(defaults)
    expect(readConfig({ ENV_NAME: 'dev' })).toEqual({ ...defaults, ENV_NAME: 'dev' })
  })

  it('strips a trailing slash from API_URL', () => {
    expect(readConfig({ API_URL: 'https://api.example.test/' }).API_URL).toBe('https://api.example.test')
  })
})
