import type { Page } from '@playwright/test'
import type { AppConfig } from '../src/config.ts'

/** The backend URL the deployed app was started with, read from its /config.js. */
export async function apiUrl(page: Page): Promise<string> {
  await page.goto('/')
  const url: AppConfig['API_URL'] = await page.evaluate(() => window.APP_CONFIG?.API_URL ?? '')
  if (!url) throw new Error('/config.js has no API_URL')
  return url.replace(/\/$/, '')
}
