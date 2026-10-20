// @vitest-environment jsdom
import * as Sentry from '@sentry/react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import App from './App.tsx'
import type { AppConfig } from './config.ts'

const config: AppConfig = {
  API_URL: 'https://api.example.test',
  SENTRY_DSN: '',
  ENV_NAME: 'dev',
  APP_VERSION: 'sha-abc123',
}

function stubFetch(impl: () => Promise<Response>) {
  const fetch = vi.fn(impl)
  vi.stubGlobal('fetch', fetch)
  return fetch
}

// React reports an error thrown during render to console.error and, in development,
// as a window "error" event that jsdom prints. Both are expected in boundary tests.
function silenceRenderErrorReports() {
  vi.spyOn(console, 'error').mockImplementation(() => {})
  const swallow = (event: ErrorEvent) => event.preventDefault()
  window.addEventListener('error', swallow)
  onTestFinished(() => window.removeEventListener('error', swallow))
}

describe('App', () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('renders the heading, welcome text and runtime config', () => {
    stubFetch(() => new Promise(() => {}))
    render(<App config={config} errorTest={null} />)
    expect(screen.getByRole('heading', { level: 1 }).textContent).toBe('{{APP_MODULE}} App')
    expect(screen.getByText('Welcome to the {{APP_MODULE}} application')).toBeTruthy()
    expect(screen.getByText('API: https://api.example.test')).toBeTruthy()
    expect(screen.getByText('Environment: dev')).toBeTruthy()
  })

  it('shows the status the backend reports from /health', async () => {
    const fetch = stubFetch(async () => Response.json({ status: 'ok' }))
    render(<App config={config} errorTest={null} />)
    expect((await screen.findByText('API status: ok')).dataset.testid).toBe('api-status')
    expect(fetch).toHaveBeenCalledWith('https://api.example.test/health', expect.anything())
  })

  it('reports the API as unreachable when the request fails', async () => {
    stubFetch(async () => {
      throw new TypeError('Failed to fetch')
    })
    render(<App config={config} errorTest={null} />)
    expect(await screen.findByText('API status: unreachable')).toBeTruthy()
  })

  it('reports the API as unreachable on a non-2xx response', async () => {
    stubFetch(async () => new Response('down', { status: 503 }))
    render(<App config={config} errorTest={null} />)
    expect(await screen.findByText('API status: unreachable')).toBeTruthy()
  })

  it('does not call the API when no API_URL is configured', () => {
    const fetch = stubFetch(async () => Response.json({ status: 'ok' }))
    render(<App config={{ ...config, API_URL: '' }} errorTest={null} />)
    expect(screen.getByTestId('api-status').textContent).toBe('API status: not configured')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('breaks rendering for the render error test so the boundary fallback shows', () => {
    stubFetch(() => new Promise(() => {}))
    silenceRenderErrorReports()
    render(
      <Sentry.ErrorBoundary fallback={<p role="alert">fallback</p>}>
        <App config={config} errorTest={{ kind: 'render', marker: 'm1' }} />
      </Sentry.ErrorBoundary>,
    )
    expect(screen.getByRole('alert').textContent).toBe('fallback')
  })
})
