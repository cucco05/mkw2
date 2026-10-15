import { defineConfig, devices } from '@playwright/test'

const baseURL = process.env.E2E_BASE_URL || 'http://127.0.0.1:3000'
// Where the browser binary is, when it was not installed by Playwright itself (e.g. a machine with a Chromium already in /opt/pw-browsers).
const chromiumPath = (process.env.E2E_CHROMIUM_PATH || '').trim()
const launchOptions = chromiumPath ? { executablePath: chromiumPath, args: ['--no-sandbox'] } : undefined
const runAgainstExisting = process.env.E2E_BASE_URL && process.env.E2E_BASE_URL.trim().length > 0

export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  webServer: runAgainstExisting
    ? undefined
    : {
        command: 'npm run dev',
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
  // The site is ONE responsive application (docs/PROGETTO.md, "Requisito permanente: responsive"): every new feature gets a test that
  // runs on a desktop and on phone-sized screens. The phone projects emulate size, touch and the mobile user agent with Chromium.
  // They do NOT replace the real-device checks (iPhone/Safari, Android) listed in docs/CHECKLIST-PRELANCIO.md: Chromium is not Safari.
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], launchOptions },
    },
    {
      name: 'mobile',
      testMatch: /.*\.responsive\.spec\.ts/,
      use: { ...devices['Pixel 5'], launchOptions },
    },
    {
      name: 'mobile-small',
      testMatch: /.*\.responsive\.spec\.ts/,
      use: { ...devices['Pixel 5'], viewport: { width: 360, height: 640 }, launchOptions },
    },
  ],
})
