import { existsSync, readFileSync } from 'fs'
import { extname, join, normalize } from 'path'
import { expect, type Page } from '@playwright/test'

/**
 * The FrameOS Cloud /frames workspace fixture shared by the cloud browser
 * specs (visual-cloud-frames-workspace.spec.ts, visual-cloud-battery.spec.ts).
 *
 * There is no Next.js server in this suite: the compiled bundle from
 * cloud-frontend/dist is served through route interception (the same pattern
 * frame-admin.spec.ts uses for the on-frame admin), and the /api/frames/**
 * surface the SPA talks to is mocked. Requires `pnpm --dir cloud-frontend run
 * build`. The cloud config the route normally injects at the
 * //__FRAMEOS_CLOUD_APP_CONFIG__ anchor is deliberately NOT injected — every
 * value falls back to window.location.origin (see src/cloudConfig.ts), which
 * keeps the fixture self-contained.
 */

export const CLOUD_ORIGIN = 'http://cloud-frames.e2e'
export const fixedNow = '2026-05-23T12:00:00Z'
const bundleDir = join(__dirname, '..', '..', '..', 'cloud-frontend', 'dist')
const logoDir = join(__dirname, '..', '..', '..', 'cloud', 'apps', 'auth-web', 'public')
export const bundleAvailable = existsSync(join(bundleDir, 'index.html'))

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
 * hardware picker shows. */
export const firmwareListing = {
  release: '2026.7.6',
  assets: [
    { name: 'frameos-2026.7.6-raspberry-pi-64.img.gz', platform: 'raspberry-pi-64', size: 341_835_776 },
    { name: 'frameos-2026.7.6-raspberry-pi-32.img.gz', platform: 'raspberry-pi-32', size: 335_544_320 },
    { name: 'frameos-2026.7.6-esp32-s3-generic.bin', platform: 'esp32-s3-generic', size: 3_407_872 },
  ],
}

/** The same release before the generic ESP32 asset existed: the panel picker
 * must stay hidden (older firmware hard-fails on any other panel). */
export const firmwareListingWithoutGenericEsp32 = {
  release: '2026.6.0',
  assets: [
    { name: 'frameos-2026.6.0-raspberry-pi-64.img.gz', platform: 'raspberry-pi-64', size: 341_835_776 },
    { name: 'frameos-2026.6.0-esp32-s3-epd7in5v2.bin', platform: 'esp32-s3-epd7in5v2', size: 3_145_728 },
  ],
}

export const cloudFrames = [
  {
    id: '11111111-2222-3333-4444-555555555555',
    name: 'Kitchen frame',
    frame_host: 'kitchen-frame',
    ssh_user: '',
    status: 'ready',
    connected: true,
    active_connections: 1,
    frameos_version: '2026.7.6',
    hardware: { platform: 'raspberry-pi-64' },
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

export const framePreviewSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480">
  <rect width="800" height="480" fill="#0f172a"/>
  <rect x="48" y="48" width="704" height="384" rx="24" fill="none" stroke="#38bdf8" stroke-width="6"/>
  <text x="80" y="260" fill="#ffffff" font-family="Arial, sans-serif" font-size="44" font-weight="700">Cloud frame</text>
  <text x="80" y="308" fill="#38bdf8" font-family="Arial, sans-serif" font-size="22">FrameOS visual fixture</text>
</svg>`.trim()

export interface CloudWorkspaceOptions {
  /** The /api/frames fleet; any frame row shape the SPA accepts. */
  frames?: Record<string, unknown>[]
  firmware?: typeof firmwareListing
}

/** Serve the built SPA and mock its /api/frames/** surface. Playwright checks
 * routes in REVERSE registration order: the static bundle fallback goes
 * first (lowest priority), then the API catch-all, then the specific mocks
 * that must win. */
export async function serveCloudWorkspace(
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
  // fontsModel reads `data.fonts`; the `{}` catch-all would feed its reducer undefined.
  await page.route(`${CLOUD_ORIGIN}/api/fonts`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ fonts: [] }) })
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
export async function prepareCloudPage(page: Page, theme: 'light' | 'dark'): Promise<void> {
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

export function expectNoCloudFrontendErrors(readErrors: () => string[]): void {
  const errors = [...new Set(readErrors())].filter(
    // The mocked API answers `{}` for endpoints this fixture doesn't model;
    // kea loaders log those misses without breaking the page.
    (error) => !/Failed to fetch|Failed to load resource/.test(error)
  )
  expect(errors, `Unexpected frontend errors:\n${errors.join('\n\n')}`).toEqual([])
}

/** The Add-frame panel's paths, by the chooser card that opens each. */
export const addFramePathTitles = {
  script: 'Install script (any Pi / most Linux)',
  sd: 'SD card image (Raspberry Pi)',
  link: 'Link a frame that already runs',
  esp32: 'Flash an ESP32 from this browser',
} as const

/** Open the Add-frame drawer and pick a path on its chooser. */
export async function openAddFrameDrawer(page: Page, path: keyof typeof addFramePathTitles = 'sd') {
  await page
    .getByRole('button', { name: /Add frame/i })
    .first()
    .click()
  const drawer = page.locator('.workspace-drawer').last()
  await expect(drawer.getByRole('heading', { name: 'Add a frame' })).toBeVisible()
  await drawer.getByRole('button', { name: addFramePathTitles[path] }).click()
  if (path === 'sd') {
    // The SD builder's board picker resolves once the release listing loads.
    await expect(drawer.getByLabel('Board')).toBeVisible()
  }
  return drawer
}
