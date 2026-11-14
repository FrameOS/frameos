import { defineConfig, devices } from '@playwright/test'
import path from 'path'

import { backendCount, backendPort } from './tests/backends'

const baseURL = process.env.FRONTEND_VISUAL_BASE_URL ?? `http://127.0.0.1:${backendPort(0)}`
const testDir = path.join(__dirname, 'tests')
// CI runs FRONTEND_VISUAL_WORKERS workers per shard, each against a backend
// of its own (tests/backends.ts): one worker per shard was 4.5 minutes of
// tests in a row on a 4-core runner. Locally the default stays Playwright's,
// against the one backend.
const ciWorkers = Number(process.env.FRONTEND_VISUAL_WORKERS ?? '1')
const maxDiffPixelRatio = Number(process.env.FRONTEND_VISUAL_MAX_DIFF ?? '0.001')

export default defineConfig({
  testDir,
  timeout: 45_000,
  fullyParallel: Boolean(process.env.CI || process.env.FRONTEND_VISUAL_FULLY_PARALLEL === '1'),
  workers: process.env.CI ? ciWorkers : undefined,
  expect: {
    timeout: 10_000,
    toHaveScreenshot: {
      animations: 'disabled',
      caret: 'hide',
      maxDiffPixelRatio,
      threshold: 0.2,
    },
  },
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [['list'], ['html', { open: 'never', outputFolder: path.join(__dirname, 'playwright-report') }]],
  outputDir: path.join(__dirname, 'test-results'),
  snapshotPathTemplate: '{testDir}/../snapshots/{projectName}/{testFilePath}/{arg}{ext}',
  use: {
    baseURL,
    trace: 'retain-on-failure',
    video: 'retain-on-failure',
    screenshot: 'only-on-failure',
    colorScheme: 'light',
    timezoneId: 'UTC',
    actionTimeout: 10_000,
    navigationTimeout: 30_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: process.env.FRONTEND_VISUAL_SKIP_WEBSERVER
    ? undefined
    : Array.from({ length: backendCount }, (_, instance) => ({
        command: 'bash scripts/start-backend.sh',
        env: { FRONTEND_VISUAL_INSTANCE: String(instance), FRONTEND_VISUAL_PORT: String(backendPort(instance)) },
        url: instance === 0 ? baseURL : `http://127.0.0.1:${backendPort(instance)}`,
        reuseExistingServer: process.env.FRONTEND_VISUAL_REUSE_SERVER === '1',
        timeout: 120_000,
      })),
})
