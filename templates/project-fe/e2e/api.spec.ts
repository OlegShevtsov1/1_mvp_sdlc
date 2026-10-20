import { expect, test } from '@playwright/test'
import { apiUrl } from './apiUrl.ts'

test('the page shows the result of a real cross-origin call to the API', async ({ page }) => {
  const corsMessages: string[] = []
  page.on('console', (message) => {
    if (/CORS|blocked/i.test(message.text())) corsMessages.push(message.text())
  })
  const api = await apiUrl(page)

  const health = page.waitForResponse((response) => response.url() === `${api}/health`)
  await page.reload()
  const response = await health

  expect(response.status()).toBe(200)
  expect(response.headers()['access-control-allow-origin']).toBe(new URL(page.url()).origin)
  await expect(page.getByTestId('api-status')).toHaveText('API status: ok')
  expect(corsMessages).toEqual([])
})

test('the API does not allow a foreign origin', async ({ page, request }) => {
  const api = await apiUrl(page)
  const response = await request.get(`${api}/health`, { headers: { Origin: 'https://evil.example.com' } })
  expect(response.status()).toBe(200)
  expect(response.headers()['access-control-allow-origin']).toBeUndefined()
})
