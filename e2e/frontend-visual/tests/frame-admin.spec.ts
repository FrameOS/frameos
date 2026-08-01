import { existsSync, readFileSync } from 'fs'
import { extname, join, normalize } from 'path'
import { expect, test, type Page } from '@playwright/test'
import { attachFrontendErrorCollector, connectedCloudStatus } from './visual-helpers'

/**
 * Browser tests for the ON-FRAME admin UI — the web app the frame device
 * itself serves from /admin (frameos/frontend, compiled into the Nim binary).
 *
 * There is no Nim server in this suite: the compiled bundle from
 * frameos/assets/compiled/frame_web is served through route interception with
 * the same `frameAdminMode` placeholder substitution the Nim server performs
 * (frameos/src/frameos/server/routes/common.nim), and the frame's /api and
 * /ws/admin surface is mocked. Requires `pnpm --dir frameos/frontend run build`.
 */

const FRAME_ORIGIN = 'http://frame-admin.e2e'
const bundleDir = join(__dirname, '..', '..', '..', 'frameos', 'assets', 'compiled', 'frame_web')
const bundleAvailable = existsSync(join(bundleDir, 'index.html'))

const contentTypes: Record<string, string> = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ttf': 'font/ttf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.wasm': 'application/wasm',
  '.json': 'application/json',
}

/** What the Nim server does in frameWebHtml(): inject the admin-mode flag. */
function frameAdminIndexHtml(): string {
  return readFileSync(join(bundleDir, 'index.html'), 'utf-8').replace('/*$frameAdminMode*/ false', 'true')
}

const frameFixture = {
  id: 1,
  name: 'E2E on-frame admin',
  mode: 'rpios',
  frame_host: 'frame-admin.e2e',
  frame_port: 8787,
  frame_access: 'private',
  frame_access_key: 'e2e-access-key',
  ssh_user: 'pi',
  ssh_port: 22,
  server_host: 'backend.e2e',
  server_port: 8989,
  status: 'ready',
  width: 800,
  height: 480,
  device: 'web_only',
  interval: 60,
  metrics_interval: 60,
  scaling_mode: 'contain',
  rotate: 0,
  debug: false,
  scenes: [
    {
      id: 'scene-dashboard',
      name: 'Dashboard',
      nodes: [],
      edges: [],
      fields: [],
      default: true,
    },
  ],
  network: { wifiSSID: 'E2EWifi' },
  agent: { agentEnabled: false },
}

interface FrameAdminOptions {
  authenticated?: boolean
  cloudStatus?: Record<string, unknown>
}

async function serveFrameAdmin(page: Page, { authenticated = true, cloudStatus }: FrameAdminOptions = {}): Promise<void> {
  // Playwright checks routes in REVERSE registration order: the static bundle
  // fallback goes first (lowest priority), then the API catch-all, then the
  // specific API mocks that must win.
  // Static bundle: index.html (with admin-mode substitution) for SPA paths,
  // real files for /static/* and /img/*.
  await page.route(`${FRAME_ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url())
    const relativePath = normalize(url.pathname).replace(/^\/+/, '')
    const filePath = join(bundleDir, relativePath)
    if (relativePath && !relativePath.startsWith('..') && existsSync(filePath) && extname(filePath)) {
      return route.fulfill({
        status: 200,
        contentType: contentTypes[extname(filePath)] ?? 'application/octet-stream',
        body: readFileSync(filePath),
      })
    }
    return route.fulfill({ status: 200, contentType: 'text/html', body: frameAdminIndexHtml() })
  })
  await page.route(`${FRAME_ORIGIN}/api/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  )
  await page.route(`${FRAME_ORIGIN}/api/admin/session`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ authenticated }) })
  )
  await page.route(`${FRAME_ORIGIN}/api/frames`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ frames: [frameFixture] }) })
  )
  await page.route(`${FRAME_ORIGIN}/api/frames/1`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ frame: frameFixture }) })
  )
  await page.route(`${FRAME_ORIGIN}/api/apps`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ apps: {} }) })
  )
  await page.route(`${FRAME_ORIGIN}/api/frames/1/logs*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ logs: [] }) })
  )
  await page.route(`${FRAME_ORIGIN}/api/frames/1/metrics*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ metrics: [] }) })
  )
  await page.route(`${FRAME_ORIGIN}/api/frames/1/metrics/recent*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ metrics: [] }) })
  )
  await page.route(`${FRAME_ORIGIN}/api/frames/1/assets*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assets: [] }) })
  )
  await page.route(`${FRAME_ORIGIN}/api/frames/1/state`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sceneId: 'scene-dashboard', state: {} }),
    })
  )
  await page.route(`${FRAME_ORIGIN}/api/frames/1/states`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ sceneId: 'scene-dashboard', states: { 'scene-dashboard': {} } }),
    })
  )
  await page.route(`${FRAME_ORIGIN}/api/cloud/status`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        cloudStatus ?? {
          enabled: true,
          provider_url: 'https://cloud.frameos.net',
          default_provider_url: 'https://cloud.frameos.net',
          status: 'disconnected',
          can_edit_provider: true,
          poll_error: null,
          local_fallback_enabled: true,
          backup_scenes_enabled: false,
          backup_frames_enabled: false,
          connection: null,
          link: null,
          identity: null,
        }
      ),
    })
  )
  await page.routeWebSocket('**/ws/admin', (ws) => {
    ws.onMessage((message) => {
      if (String(message) === 'ping') {
        ws.send(JSON.stringify({ event: 'pong', data: {} }))
      }
    })
  })
}

test.describe('on-frame admin UI @e2e', () => {
  test.skip(!bundleAvailable, 'frameos/assets/compiled/frame_web missing — run `pnpm --dir frameos/frontend run build`')

  test('renders the admin workspace for an authenticated session', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await serveFrameAdmin(page)

    await page.goto(`${FRAME_ORIGIN}/admin`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('E2E on-frame admin').first()).toBeVisible()
    // Still on /admin — no redirect to the on-frame login page.
    expect(new URL(page.url()).pathname).toBe('/admin')

    expectNoFrameAdminErrors(readErrors)
  })

  test('redirects to the on-frame login page without a session', async ({ page }) => {
    await page.setViewportSize({ width: 900, height: 900 })
    await serveFrameAdmin(page, { authenticated: false })

    await page.goto(`${FRAME_ORIGIN}/admin`, { waitUntil: 'domcontentloaded' })
    await page.waitForURL(`${FRAME_ORIGIN}/login`)
    await expect(page.locator('input[type="password"]').first()).toBeVisible()
  })

  test('cloud settings never expose backend-only backup controls on the frame', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1000 })
    // Worst case: a connected link that has the backup scopes granted.
    await serveFrameAdmin(page, { cloudStatus: connectedCloudStatus() })

    await page.goto(`${FRAME_ORIGIN}/admin?tool=settings`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('FrameOS Cloud').first()).toBeVisible()
    await expect(page.getByText('cloud.frameos.net').first()).toBeVisible()

    // The backup section, feature toggles, and restore buttons are backend
    // features; the on-frame admin must not render them even with the scopes.
    await expect(page.getByRole('button', { name: /^Back up now$/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Show backups$/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: /^Restore$/ })).toHaveCount(0)
    await expect(page.getByText('Enabled features')).toHaveCount(0)

    expectNoFrameAdminErrors(readErrors)
  })
})

function expectNoFrameAdminErrors(readErrors: () => string[]): void {
  const errors = [...new Set(readErrors())].filter(
    // The mocked frame API answers `{}` for endpoints this suite doesn't
    // model; kea loaders log those misses without breaking the page.
    (error) => !/Failed to fetch|Failed to load resource/.test(error)
  )
  expect(errors, `Unexpected frontend errors:\n${errors.join('\n\n')}`).toEqual([])
}
