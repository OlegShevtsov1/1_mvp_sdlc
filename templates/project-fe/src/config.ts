export interface AppConfig {
  API_URL: string
  SENTRY_DSN: string
  ENV_NAME: string
  APP_VERSION: string
}

declare global {
  interface Window {
    /** Set by /config.js, which the container writes at start (docker/40-config-js.sh). */
    APP_CONFIG?: Partial<AppConfig>
  }
}

export function readConfig(served: Partial<AppConfig> | undefined): AppConfig {
  return {
    API_URL: (served?.API_URL ?? '').replace(/\/$/, ''),
    SENTRY_DSN: served?.SENTRY_DSN ?? '',
    ENV_NAME: served?.ENV_NAME ?? 'unknown',
    APP_VERSION: served?.APP_VERSION ?? 'local',
  }
}
