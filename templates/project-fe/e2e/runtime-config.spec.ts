import { expect, test } from '@playwright/test'
import { apiUrl } from './apiUrl.ts'

test('serves this environment\'s runtime config, with no URL baked into the bundle', async ({
  page,
  request,
  baseURL,
}) => {
  const envName = process.env.E2E_ENV_NAME
  if (!envName) throw new Error('Set E2E_ENV_NAME to the environment the app runs as, for example E2E_ENV_NAME=prod')

  const health = await request.get('/health')
  expect(health.status()).toBe(200)
  expect((await health.text()).trim()).toBe('ok')
  expect((await request.get('/config.js')).headers()['cache-control']).toBe('no-store')

  const api = await apiUrl(page)
  const config = await page.evaluate(() => window.APP_CONFIG)
  const appHost = new URL(baseURL ?? '').host
  const apiHost = new URL(api).host
  expect(config?.ENV_NAME).toBe(envName)
  expect(apiHost).toBe(appHost.replace(/^app\./, ''))
  expect(config?.APP_VERSION).toMatch(/^(prod-)?sha-[0-9a-f]{40}$/)

  const scripts = await page.locator('script[src]').evaluateAll((elements) =>
    elements.map((element) => (element as HTMLScriptElement).src),
  )
  const bundles = scripts.filter((src) => new URL(src).pathname !== '/config.js')
  expect(bundles.length).toBeGreaterThan(0)
  for (const src of bundles) {
    const body = await (await request.get(src)).text()
    expect(body, src).not.toContain(apiHost)
    expect(body, src).not.toContain(appHost)
  }
})
