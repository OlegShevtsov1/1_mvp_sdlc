import * as Sentry from '@sentry/react'
import type { AppConfig } from './config.ts'

type SentryInit = (options: Sentry.BrowserOptions) => unknown

export function initSentry(config: AppConfig, init: SentryInit = Sentry.init): boolean {
  if (!config.SENTRY_DSN) return false
  init({
    dsn: config.SENTRY_DSN,
    // The browser never talks to the error tracker directly: the backend forwards envelopes.
    tunnel: `${config.API_URL}/api/errors`,
    environment: config.ENV_NAME,
    release: config.APP_VERSION,
  })
  return true
}
