import { expect, test } from '@playwright/test'
import { apiUrl } from './apiUrl.ts'

for (const kind of ['runtime', 'rejection', 'render'] as const) {
  test(`a ${kind} error is reported only through the API tunnel`, async ({ page, baseURL }) => {
    const api = await apiUrl(page)
    const marker = `${process.env.E2E_MARKER_PREFIX ?? 'e2e'}-${kind}-${Date.now()}`
    const hosts = new Set<string>()
    page.on('request', (request) => hosts.add(new URL(request.url()).host))

    // Sentry also posts session updates to the tunnel; only the event carries the marker.
    const reported = page.waitForResponse(
      (response) =>
        response.url() === `${api}/api/errors` &&
        response.request().method() === 'POST' &&
        (response.request().postData() ?? '').includes(marker),
    )
    await page.goto(`/?error-test=${kind}&marker=${marker}`)

    expect((await reported).ok()).toBe(true)
    if (kind === 'render') await expect(page.getByRole('alert')).toBeVisible()
    const allowed = [new URL(baseURL ?? '').host, new URL(api).host]
    expect([...hosts].filter((host) => !allowed.includes(host))).toEqual([])
    console.log(`error-test marker: ${marker}`)
  })
}
