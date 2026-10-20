import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL
if (!baseURL) {
  throw new Error('Set E2E_BASE_URL to the deployed app, for example E2E_BASE_URL=https://app.dev.<zone> npm run e2e')
}

// Checks a deployed app against its real backend, so there is no web server to start here.
export default defineConfig({
  testDir: 'e2e',
  retries: 0,
  reporter: 'list',
  use: { baseURL },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
})
