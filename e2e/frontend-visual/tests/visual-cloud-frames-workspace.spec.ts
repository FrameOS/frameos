import { existsSync, readFileSync } from 'fs'
import { extname, join, normalize } from 'path'
import { expect, test, type Page } from '@playwright/test'
import { attachFrontendErrorCollector, settleForScreenshot } from './visual-helpers'

/**
 * Browser tests for the FrameOS Cloud /frames workspace — the cloud-frontend
 * SPA that cloud/apps/auth-web serves from /frames (see
 * app/frames/[[...path]]/route.ts and cloud-frontend/README.md).
 *
 * There is no Next.js server in this suite: the compiled bundle from
 * cloud-frontend/dist is served through route interception (the same pattern
 * frame-admin.spec.ts uses for the on-frame admin), and the /api/frames/**
 * surface the SPA talks to is mocked. Requires `pnpm --dir cloud-frontend run
 * build`. The cloud config the route normally injects at the
 * //__FRAMEOS_CLOUD_APP_CONFIG__ anchor is deliberately NOT injected — every
 * value falls back to window.location.origin (see src/cloudConfig.ts), which
 * keeps the fixture self-contained.
 *
 * Covered here:
 *   - the shared cloud chrome: the frameos-account-header the SPA renders
 *     from the same cloud-chrome.css as the Next.js store/account pages;
 *   - light and dark theme via the shared frameos_theme cookie the two
 *     surfaces agree on (cloud-frontend/src/cloudThemeSync.ts);
 *   - the Add-frame panel: the SD image builder's Display picker (with
 *     width/height prefills, rotation, VCOM, upload URL, "Remember WiFi",
 *     claim-validity select) and the ESP32 flasher's E-paper panel picker
 *     that only appears when the release publishes esp32-s3-generic.
 */

const CLOUD_ORIGIN = 'http://cloud-frames.e2e'
const fixedNow = '2026-05-23T12:00:00Z'
const bundleDir = join(__dirname, '..', '..', '..', 'cloud-frontend', 'dist')
const logoDir = join(__dirname, '..', '..', '..', 'cloud', 'apps', 'auth-web', 'public')
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

/** A deterministic /api/frames/firmware listing: both Pi SD images plus the
 * all-panels ESP32 build, so the SD board picker fills in and the flasher's
 * E-paper panel picker shows. */
const firmwareListing = {
  release: '2026.7.6',
  assets: [
    { name: 'frameos-2026.7.6-raspberry-pi-zero-2-w.img.gz', platform: 'raspberry-pi-zero-2-w', size: 341_835_776 },
    { name: 'frameos-2026.7.6-raspberry-pi-zero-w.img.gz', platform: 'raspberry-pi-zero-w', size: 335_544_320 },
    { name: 'frameos-2026.7.6-esp32-s3-generic.bin', platform: 'esp32-s3-generic', size: 3_407_872 },
  ],
}

/** The same release before the generic ESP32 asset existed: the panel picker
 * must stay hidden (older firmware hard-fails on any other panel). */
const firmwareListingWithoutGenericEsp32 = {
  release: '2026.6.0',
  assets: [
    { name: 'frameos-2026.6.0-raspberry-pi-zero-2-w.img.gz', platform: 'raspberry-pi-zero-2-w', size: 341_835_776 },
    { name: 'frameos-2026.6.0-esp32-s3-epd7in5v2.bin', platform: 'esp32-s3-epd7in5v2', size: 3_145_728 },
  ],
}

const cloudFrames = [
  {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'Kitchen frame',
    frame_host: 'kitchen-frame',
    ssh_user: '',
    status: 'ready',
    connected: true,
    active_connections: 1,
    frameos_version: '2026.7.6',
    hardware: { platform: 'raspberry-pi-zero-2-w' },
    created_at: '2026-05-01T09:00:00Z',
    last_seen_at: '2026-05-23T11:58:00Z',
    last_log_at: '2026-05-23T11:58:00Z',
    linked_client_id: 'lc-cloud-1',
    assigned_checksum: 'abc123',
    scenes_checksum: 'abc123',
    width: 800,
    height: 480,
    device: 'web_only',
    interval: 300,
    scenes: [],
    last_metrics: null,
    last_state: null,
  },
  {
    id: '66666666-7777-8888-9999-aaaaaaaaaaaa',
    name: 'Hallway e-ink',
    frame_host: 'hallway-e-ink',
    ssh_user: '',
    status: 'pending',
    connected: false,
    active_connections: 0,
    frameos_version: null,
    hardware: null,
    created_at: '2026-05-22T18:30:00Z',
    last_seen_at: null,
    last_log_at: null,
    linked_client_id: 'lc-cloud-2',
    assigned_checksum: null,
    scenes_checksum: null,
    width: null,
    height: null,
    device: null,
    interval: 300,
    scenes: [],
    last_metrics: null,
    last_state: null,
  },
]

const framePreviewSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480">
  <rect width="800" height="480" fill="#0f172a"/>
  <rect x="48" y="48" width="704" height="384" rx="24" fill="none" stroke="#38bdf8" stroke-width="6"/>
  <text x="80" y="260" fill="#ffffff" font-family="Arial, sans-serif" font-size="44" font-weight="700">Cloud frame</text>
  <text x="80" y="308" fill="#38bdf8" font-family="Arial, sans-serif" font-size="22">FrameOS visual fixture</text>
</svg>`.trim()

interface CloudWorkspaceOptions {
  frames?: typeof cloudFrames | []
  firmware?: typeof firmwareListing
}

/** Serve the built SPA and mock its /api/frames/** surface. Playwright checks
 * routes in REVERSE registration order: the static bundle fallback goes
 * first (lowest priority), then the API catch-all, then the specific mocks
 * that must win. */
async function serveCloudWorkspace(
  page: Page,
  { frames = cloudFrames, firmware = firmwareListing }: CloudWorkspaceOptions = {}
): Promise<void> {
  // Static bundle: real files for /frames-app/* (and anything else with an
  // extension that exists in dist/), the shell for SPA paths. The header's
  // logos live in the Next app's public/ directory at the origin root.
  await page.route(`${CLOUD_ORIGIN}/**`, (route) => {
    const url = new URL(route.request().url())
    let relativePath = normalize(url.pathname).replace(/^\/+/, '')
    if (relativePath === 'logo-light.svg' || relativePath === 'logo-dark.svg') {
      const logoPath = join(logoDir, relativePath)
      if (existsSync(logoPath)) {
        return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: readFileSync(logoPath) })
      }
    }
    if (relativePath.startsWith('frames-app/')) {
      relativePath = relativePath.slice('frames-app/'.length)
    }
    const filePath = join(bundleDir, relativePath)
    if (relativePath && !relativePath.startsWith('..') && existsSync(filePath) && extname(filePath)) {
      return route.fulfill({
        status: 200,
        contentType: contentTypes[extname(filePath)] ?? 'application/octet-stream',
        body: readFileSync(filePath),
      })
    }
    return route.fulfill({
      status: 200,
      contentType: 'text/html',
      body: readFileSync(join(bundleDir, 'index.html'), 'utf-8'),
    })
  })
  await page.route(`${CLOUD_ORIGIN}/api/**`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
  )
  await page.route(`${CLOUD_ORIGIN}/api/frames`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ frames }) })
  )
  await page.route(`${CLOUD_ORIGIN}/api/frames/firmware*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(firmware) })
  )
  // Minted eagerly when the Add-frame panel mounts; a fixed token keeps the
  // install command's text stable across runs.
  await page.route(`${CLOUD_ORIGIN}/api/frames/claim-tokens`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        claim_token: 'FRCT_e2e00000000000000000000000000000000',
        expires_at: '2026-05-24T12:00:00Z',
      }),
    })
  )
  await page.route(`${CLOUD_ORIGIN}/api/frames/*/image*`, (route) =>
    route.fulfill({ status: 200, contentType: 'image/svg+xml', body: framePreviewSvg })
  )
  await page.route(`${CLOUD_ORIGIN}/api/frames/*/logs*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ logs: [] }) })
  )
  await page.route(`${CLOUD_ORIGIN}/api/frames/*/metrics*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ metrics: [] }) })
  )
  await page.route(`${CLOUD_ORIGIN}/api/frames/*/metrics/recent*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ metrics: [] }) })
  )
  // Loaders that expect bare arrays (settingsLogic custom fonts,
  // repositoriesModel) — the `{}` catch-all would crash their .filter/spread.
  await page.route(`${CLOUD_ORIGIN}/api/assets*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  )
  await page.route(`${CLOUD_ORIGIN}/api/repositories`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  )
  await page.route(`${CLOUD_ORIGIN}/api/repositories/system`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: '[]' })
  )
  await page.route(`${CLOUD_ORIGIN}/api/frames/*/state`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sceneId: null, state: {} }) })
  )
  await page.route(`${CLOUD_ORIGIN}/api/frames/*/states`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ sceneId: null, states: {} }) })
  )
  // The account-wide fleet socket (frontend/src/scenes/socketLogic.tsx). No
  // cloud_ws_origin is injected, so the SPA dials this origin directly.
  await page.routeWebSocket(new RegExp('/api/frames/updates'), () => {
    // Accept the connection; the fixture pushes no events.
  })
}

/** Freeze the clock (relative "last seen" timestamps) — the same trick
 * visual-helpers' prepareStablePage uses, without its self-hosted-backend
 * route mocks, which do not apply to this origin. */
async function prepareCloudPage(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript(
    ({ fixedNow }) => {
      const fixedTimestamp = new Date(fixedNow).valueOf()
      const RealDate = Date
      class FixedDate extends RealDate {
        constructor(...args: any[]) {
          if (args.length === 0) {
            super(fixedTimestamp)
          } else {
            super(...args)
          }
        }
        static now() {
          return fixedTimestamp
        }
      }
      Object.setPrototypeOf(FixedDate, RealDate)
      ;(window as any).Date = FixedDate
      // Headless Chromium ships without WebSerial or the File System Access
      // API, so the ESP32 flasher and the SD builder would render their
      // "unsupported browser" fallbacks. Real desktop Chrome — the browser
      // these flows target — has both, so stub the capability probes
      // ('serial' in navigator, 'showSaveFilePicker' in window); no test
      // ever opens a real port or save dialog.
      Object.defineProperty(navigator, 'serial', {
        configurable: true,
        value: {
          getPorts: () => Promise.resolve([]),
          requestPort: () => Promise.reject(new Error('e2e stub: no serial ports')),
        },
      })
      Object.defineProperty(window, 'showSaveFilePicker', {
        configurable: true,
        value: () => Promise.reject(new DOMException('e2e stub', 'AbortError')),
      })
    },
    { fixedNow }
  )
  if (theme === 'dark') {
    // The shared frameos_theme cookie is the carrier both surfaces agree on:
    // the shell's pre-paint script reads it first, and cloudThemeSync seeds
    // the workspace's own storage from it before kea mounts.
    await page.context().addCookies([{ name: 'frameos_theme', value: 'dark', url: CLOUD_ORIGIN }])
  }
}

function expectNoCloudFrontendErrors(readErrors: () => string[]): void {
  const errors = [...new Set(readErrors())].filter(
    // The mocked API answers `{}` for endpoints this fixture doesn't model;
    // kea loaders log those misses without breaking the page.
    (error) => !/Failed to fetch|Failed to load resource/.test(error)
  )
  expect(errors, `Unexpected frontend errors:\n${errors.join('\n\n')}`).toEqual([])
}

async function openAddFrameDrawer(page: Page) {
  await page
    .getByRole('button', { name: /Add frame/i })
    .first()
    .click()
  const drawer = page.locator('.workspace-drawer').last()
  await expect(drawer.getByRole('heading', { name: 'Add a frame' })).toBeVisible()
  // The SD builder's board picker resolves once the release listing loads.
  await expect(drawer.getByLabel('Board')).toBeVisible()
  return drawer
}

test.describe('cloud /frames workspace @e2e', () => {
  test.skip(!bundleAvailable, 'cloud-frontend/dist missing — run `pnpm --dir cloud-frontend run build`')

  for (const theme of ['light', 'dark'] as const) {
    test(`first-run enrollment panel / ${theme}`, async ({ page }) => {
      const readErrors = attachFrontendErrorCollector(page)
      await page.setViewportSize({ width: 1280, height: 1000 })
      await prepareCloudPage(page, theme)
      await serveCloudWorkspace(page, { frames: [] })

      await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
      // An empty fleet renders the enrollment panel as the page, centered
      // under the shared account header.
      await expect(page.getByRole('heading', { name: 'Add a frame' })).toBeVisible()
      await expect(page.getByText('FRCT_e2e00000000000000000000000000000000').first()).toBeVisible()
      await expect(page.getByLabel('Display', { exact: true })).toBeVisible()

      // The shared cloud chrome: same header classes as the Next.js pages.
      const header = page.locator('header.frameos-account-header')
      await expect(header).toBeVisible()
      for (const link of ['Scenes', 'Frames', 'Account']) {
        await expect(header.getByRole('link', { name: link, exact: true })).toBeVisible()
      }
      await expect(header.getByRole('button', { name: 'Sign out' })).toBeVisible()

      // The theme signal the two surfaces share.
      await expect(page.locator('html')).toHaveAttribute('data-frameos-theme', theme)

      await settleForScreenshot(page)
      await expect(page).toHaveScreenshot(`cloud-frames-first-run--${theme}.png`, { fullPage: true })
      expectNoCloudFrontendErrors(readErrors)
    })

    test(`workspace shell header and fleet / ${theme}`, async ({ page }) => {
      const readErrors = attachFrontendErrorCollector(page)
      await page.setViewportSize({ width: 1440, height: 900 })
      await prepareCloudPage(page, theme)
      await serveCloudWorkspace(page)

      await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText('Kitchen frame').first()).toBeVisible()
      await expect(page.getByText('Hallway e-ink').first()).toBeVisible()
      await expect(page.locator('header.frameos-account-header')).toBeVisible()

      await settleForScreenshot(page)
      await expect(page).toHaveScreenshot(`cloud-frames-home--${theme}.png`)
      expectNoCloudFrontendErrors(readErrors)
    })
  }

  test('add-frame drawer: SD builder display picker prefills panel dimensions', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1400 })
    await prepareCloudPage(page, 'light')
    await serveCloudWorkspace(page)

    await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Kitchen frame').first()).toBeVisible()
    const drawer = await openAddFrameDrawer(page)

    // Board options come from the mocked release listing.
    await expect(drawer.getByLabel('Board')).toHaveValue('raspberry-pi-zero-2-w')
    await expect(drawer.getByLabel('Board').locator('option', { hasText: 'Raspberry Pi Zero 2 W (2026.7.6)' })).toHaveCount(1)

    // No display picked yet: the detail fields stay hidden.
    await expect(drawer.getByLabel('Display width')).toHaveCount(0)

    // Picking a panel prefills its native dimensions.
    await drawer.getByLabel('Display', { exact: true }).selectOption({ label: 'Waveshare 13.3" E (Spectra 6)' })
    await expect(drawer.getByLabel('Display width')).toHaveValue('1600')
    await expect(drawer.getByLabel('Display height')).toHaveValue('1200')
    await expect(drawer.getByLabel('Rotation')).toHaveValue('0')
    // VCOM is an IT8951 knob no curated panel needs — custom keys only.
    await expect(drawer.getByLabel('VCOM (optional)')).toHaveCount(0)
    // …and no upload URL: that belongs to http.upload (and custom).
    await expect(drawer.getByLabel('Upload URL')).toHaveCount(0)

    // A smaller panel swaps the prefill.
    await drawer.getByLabel('Display', { exact: true }).selectOption({ label: 'Waveshare 7.3" E (Spectra 6)' })
    await expect(drawer.getByLabel('Display width')).toHaveValue('800')
    await expect(drawer.getByLabel('Display height')).toHaveValue('480')

    // HTTP upload shows the upload URL field, still no VCOM.
    await drawer.getByLabel('Display', { exact: true }).selectOption({ label: 'HTTP upload (POST rendered PNG)' })
    await expect(drawer.getByLabel('Upload URL')).toHaveAttribute('placeholder', 'Upload URL (required)')
    await expect(drawer.getByLabel('VCOM (optional)')).toHaveCount(0)

    // Custom keys get both optional knobs.
    await drawer.getByLabel('Display', { exact: true }).selectOption({ label: 'Custom device key…' })
    await expect(drawer.getByLabel('VCOM (optional)')).toBeVisible()
    await expect(drawer.getByLabel('Upload URL')).toBeVisible()

    // The rest of the SD builder's new controls.
    await expect(drawer.getByText('Remember WiFi credentials in this browser')).toBeVisible()
    await expect(drawer.getByLabel('Claim code validity')).toHaveValue('90')
    await expect(
      drawer.getByLabel('Claim code validity').locator('option', { hasText: '3 months (default)' })
    ).toHaveCount(1)
    await expect(
      drawer.getByLabel('Claim code validity').locator('option', { hasText: 'Forever' })
    ).toHaveCount(1)

    expectNoCloudFrontendErrors(readErrors)
  })

  test('add-frame drawer: SD builder visual state', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1400 })
    await prepareCloudPage(page, 'light')
    await serveCloudWorkspace(page)

    await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Kitchen frame').first()).toBeVisible()
    const drawer = await openAddFrameDrawer(page)

    await drawer.getByLabel('Display', { exact: true }).selectOption({ label: 'Waveshare 13.3" E (Spectra 6)' })
    await expect(drawer.getByLabel('Display width')).toHaveValue('1600')
    await expect(drawer.getByText('FRCT_e2e00000000000000000000000000000000').first()).toBeVisible()

    await settleForScreenshot(page)
    await expect(drawer).toHaveScreenshot('cloud-add-frame-drawer--sd-builder.png')
    expectNoCloudFrontendErrors(readErrors)
  })

  test('ESP32 flasher: E-paper panel picker follows the esp32-s3-generic asset', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1400 })
    await prepareCloudPage(page, 'light')
    await serveCloudWorkspace(page)

    await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Kitchen frame').first()).toBeVisible()
    const drawer = await openAddFrameDrawer(page)

    // The release publishes the all-panels build, so the picker shows —
    // defaulting to the firmware's baked-in 7.5" V2.
    const panelPicker = drawer.getByLabel('E-paper panel')
    await expect(panelPicker).toBeVisible()
    await expect(panelPicker).toHaveValue('')
    await expect(
      panelPicker.locator('option', { hasText: 'Waveshare 13.3" E — 1600×1200 Spectra 6' })
    ).toHaveCount(1)

    // "Custom panel key…" reveals the free-form key input.
    await panelPicker.selectOption('custom')
    await expect(drawer.getByLabel('Custom panel key')).toBeVisible()

    expectNoCloudFrontendErrors(readErrors)
  })

  test('ESP32 flasher: no panel picker when the release lacks esp32-s3-generic', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1400 })
    await prepareCloudPage(page, 'light')
    await serveCloudWorkspace(page, { firmware: firmwareListingWithoutGenericEsp32 })

    await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Kitchen frame').first()).toBeVisible()
    const drawer = await openAddFrameDrawer(page)

    // Older releases only ship the single-panel 7.5" V2 build; offering a
    // panel choice would brick the display init, so the picker stays hidden.
    await expect(drawer.getByText('Flash an ESP32 from this browser')).toBeVisible()
    await expect(drawer.getByLabel('E-paper panel')).toHaveCount(0)

    expectNoCloudFrontendErrors(readErrors)
  })
})
