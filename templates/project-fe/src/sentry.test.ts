import { describe, expect, it, vi } from 'vitest'
import { initSentry } from './sentry.ts'

const config = {
  API_URL: 'https://api.example.test',
  SENTRY_DSN: 'https://key@errors.example.test/7',
  ENV_NAME: 'dev',
  APP_VERSION: 'sha-abc123',
}

describe('initSentry', () => {
  it('stays off without a DSN', () => {
    const init = vi.fn()
    expect(initSentry({ ...config, SENTRY_DSN: '' }, init)).toBe(false)
    expect(init).not.toHaveBeenCalled()
  })

  it('sends events through the backend tunnel, tagged with the runtime environment and version', () => {
    const init = vi.fn()
    expect(initSentry(config, init)).toBe(true)
    expect(init).toHaveBeenCalledWith({
      dsn: 'https://key@errors.example.test/7',
      tunnel: 'https://api.example.test/api/errors',
      environment: 'dev',
      release: 'sha-abc123',
    })
  })
})
