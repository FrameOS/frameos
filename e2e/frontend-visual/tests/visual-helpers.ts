import type { Page, Route } from '@playwright/test'

const fixedNow = '2026-05-23T12:00:00Z'
const e2eInstallFrameNamePattern = /^E2E (?:(?:SD card|SSH|Script|Import) \d+|install flow (?:SD card|SSH|Script|Import) \d+-[a-z0-9]+)$/
const livePreviewSvg = `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480">
  <rect width="800" height="480" fill="#111827"/>
  <g>
    <rect x="0" y="0" width="34" height="480" fill="#8b5cf6"/>
    <rect x="64" y="0" width="34" height="480" fill="#ffffff"/>
    <rect x="128" y="0" width="34" height="480" fill="#8b5cf6"/>
    <rect x="192" y="0" width="34" height="480" fill="#ffffff"/>
    <rect x="256" y="0" width="34" height="480" fill="#8b5cf6"/>
    <rect x="320" y="0" width="34" height="480" fill="#ffffff"/>
    <rect x="384" y="0" width="34" height="480" fill="#8b5cf6"/>
    <rect x="448" y="0" width="34" height="480" fill="#ffffff"/>
    <rect x="512" y="0" width="34" height="480" fill="#8b5cf6"/>
    <rect x="576" y="0" width="34" height="480" fill="#ffffff"/>
    <rect x="640" y="0" width="34" height="480" fill="#8b5cf6"/>
    <rect x="704" y="0" width="34" height="480" fill="#ffffff"/>
    <rect x="768" y="0" width="34" height="480" fill="#8b5cf6"/>
  </g>
  <rect x="48" y="48" width="704" height="384" rx="24" fill="#111827" stroke="#8b5cf6" stroke-width="4"/>
  <text x="80" y="114" fill="#ffffff" font-family="Arial, sans-serif" font-size="38" font-weight="700">Live preview</text>
  <text x="80" y="156" fill="#dbeafe" font-family="Arial, sans-serif" font-size="20">FrameOS visual fixture</text>
  <text x="80" y="388" fill="#dbeafe" font-family="Arial, sans-serif" font-size="20">800 x 480</text>
</svg>`.trim()

interface FrameListItem {
  id: number
  name?: string | null
}

function isE2EInstallFrame(frame: FrameListItem): boolean {
  return e2eInstallFrameNamePattern.test(frame.name ?? '')
}

function withoutE2EInstallFrames(payload: any): any {
  if (!Array.isArray(payload?.frames)) {
    return payload
  }
  return {
    ...payload,
    frames: payload.frames.filter((frame: FrameListItem) => !isE2EInstallFrame(frame)),
  }
}

export async function cleanupE2EInstallFrames(page: Page): Promise<void> {
  const response = await page.request.get('/api/frames')
  if (!response.ok()) {
    throw new Error(`Could not list frames for E2E install cleanup: ${response.status()}`)
  }

  const payload = await response.json()
  const frames = Array.isArray(payload?.frames) ? (payload.frames as FrameListItem[]) : []
  const framesToDelete = frames.filter(isE2EInstallFrame)

  await Promise.all(
    framesToDelete.map(async (frame) => {
      const deleteResponse = await page.request.delete(`/api/frames/${frame.id}`)
      if (!deleteResponse.ok() && deleteResponse.status() !== 404) {
        throw new Error(`Could not delete E2E install frame ${frame.id}: ${deleteResponse.status()}`)
      }
    })
  )
}

export async function prepareStablePage(page: Page, theme: 'light' | 'dark'): Promise<void> {
  await page.addInitScript(
    ({ fixedNow, theme }) => {
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
      window.localStorage.setItem('frameos.workspaceTheme', theme)
      window.localStorage.setItem('framesModel.archivedFramesExpanded', 'true')
      window.localStorage.setItem('framesModel.inactiveFramesExpanded', 'true')
    },
    { fixedNow, theme }
  )

  await page.route('**/api/frames', async (route) => {
    const response = await route.fetch()
    const payload = await response.json()
    await route.fulfill({ response, json: withoutE2EInstallFrames(payload) })
  })

  await page.route('**/api/frames/1/image**', async (route) => {
    await route.fulfill({
      body: livePreviewSvg,
      contentType: 'image/svg+xml',
    })
  })

  await page.route(
    '**/api/system/metrics',
    fulfillJson({
      disk: { totalBytes: 58_000_000_000, usedBytes: 4_100_000_000, freeBytes: 53_900_000_000 },
      memory: { totalBytes: 512_000_000, availableBytes: 302_000_000 },
      load: { one: 0.14, five: 0.1, fifteen: 0.08 },
    })
  )

  await page.route(
    '**/api/frames/1/metrics',
    fulfillJson({
      metrics: [
        {
          id: 'visual-metrics-1',
          frame_id: 1,
          timestamp: '2026-05-23T11:55:00Z',
          metrics: {
            intervalMs: 60_000,
            load: [0.14, 0.1, 0.08],
            memoryUsage: {
              total: 512_000_000,
              available: 302_000_000,
              used: 210_000_000,
              percentage: 41,
            },
            diskUsage: {
              total: 58_000_000_000,
              available: 53_900_000_000,
              free: 53_900_000_000,
              used: 4_100_000_000,
              percentage: 7,
            },
            runtime: { width: 800, height: 480, fps: 1 },
          },
        },
        {
          id: 'visual-metrics-2',
          frame_id: 1,
          timestamp: fixedNow,
          metrics: {
            intervalMs: 60_000,
            load: [0.12, 0.1, 0.08],
            memoryUsage: {
              total: 512_000_000,
              available: 302_000_000,
              used: 210_000_000,
              percentage: 41,
            },
            diskUsage: {
              total: 58_000_000_000,
              available: 53_900_000_000,
              free: 53_900_000_000,
              used: 4_100_000_000,
              percentage: 7,
            },
            runtime: { width: 800, height: 480, fps: 1 },
          },
        },
      ],
    })
  )

  await page.route(
    '**/api/ai/embeddings/status',
    fulfillJson({
      count: 0,
      total: 0,
    })
  )

  await page.route(
    '**/api/system/info',
    fulfillJson({
      disk: { totalBytes: 58_000_000_000, usedBytes: 4_100_000_000, freeBytes: 53_900_000_000 },
      memory: { totalBytes: 512_000_000, availableBytes: 302_000_000 },
      load: { one: 0.14, five: 0.1, fifteen: 0.08 },
      caches: [
        { name: 'Build cache', path: '.tmp/build-cache', sizeBytes: 42_000_000, exists: true },
        { name: 'Frontend assets', path: 'frontend/dist', sizeBytes: 18_000_000, exists: true },
      ],
      database: { path: '.tmp/frontend-visual.db', sizeBytes: 2_400_000, exists: true },
    })
  )

  await page.route('**/api/repositories', fulfillJson([]))

  await page.route(
    '**/api/frames/1/assets',
    fulfillJson({
      assets: [
        { path: '/srv/assets', size: 4096, mtime: 1_779_535_200, is_dir: true },
        { path: '/srv/assets/fonts', size: 4096, mtime: 1_779_535_200, is_dir: true },
        { path: '/srv/assets/fonts/Ubuntu-Regular.ttf', size: 297_884, mtime: 1_779_535_200, is_dir: false },
        { path: '/srv/assets/images', size: 4096, mtime: 1_779_535_200, is_dir: true },
        { path: '/srv/assets/images/dashboard.png', size: 482_400, mtime: 1_779_535_200, is_dir: false },
        { path: '/srv/assets/videos', size: 4096, mtime: 1_779_535_200, is_dir: true },
        { path: '/srv/assets/videos/status-loop.mp4', size: 2_340_000, mtime: 1_779_535_200, is_dir: false },
      ],
    })
  )

  await page.route(
    '**/api/frames/1/ping**',
    fulfillJson({
      ok: true,
      mode: 'icmp',
      target: '127.0.0.1',
      elapsed_ms: 3.7,
      status: null,
      message: 'Reply from 127.0.0.1',
    })
  )

  await page.route(
    '**/api/frames/1/states',
    fulfillJson({
      sceneId: 'scene-dashboard',
      states: {
        'scene-dashboard': { headline: 'Morning', accent: '#6f42c1' },
        'scene-gradient': {},
      },
    })
  )
  await page.route(
    '**/api/frames/1/state',
    fulfillJson({
      sceneId: 'scene-dashboard',
      state: { headline: 'Morning', accent: '#6f42c1' },
    })
  )
  await page.route(
    '**/api/frames/1/uploaded_scenes',
    fulfillJson({
      sceneId: 'scene-dashboard',
      scenes: [
        { id: 'scene-dashboard', name: 'Dashboard' },
        { id: 'scene-gradient', name: 'Gradient status' },
        { id: 'scene-gallery', name: 'Gallery' },
      ],
    })
  )
  await page.route('**/api/frames/1/event/**', fulfillText('OK'))
  await page.route('**/api/frames/1/fast_deploy', fulfillJson({ message: 'Deployment queued' }))
  await page.route('**/api/frames/1/deploy', fulfillJson({ message: 'Deployment queued' }))
  await page.route('**/api/frames/1/assets/sync', fulfillJson({ message: 'Assets synced successfully' }))
  await page.route(
    '**/api/frames/1/scene_source/**',
    fulfillJson({
      source: [
        'import frameos/apps',
        '',
        'proc renderScene*() =',
        '  let title = state{"headline"}.getStr("Morning")',
        '  renderText(title)',
        '',
      ].join('\n'),
    })
  )
  await page.route('**/api/apps/validate_source', fulfillJson({ errors: [] }))
  await page.routeWebSocket('**/ws', (ws) => {
    ws.onMessage((message) => {
      if (String(message) === 'ping') {
        ws.send(JSON.stringify({ event: 'pong', data: {} }))
      }
    })
  })
  await page.routeWebSocket('**/ws/terminal/*', (ws) => {
    ws.send('visual@frameos:~$ uptime\n 12:00 up 4 days, load average: 0.14, 0.10, 0.08\n')
    ws.onMessage((message) => ws.send(`visual@frameos:~$ ${String(message).trim()}\n`))
    setTimeout(() => {
      ws.close()
    }, 150)
  })
}

export async function login(page: Page): Promise<void> {
  const response = await page.request.post('/api/login', {
    form: {
      username: 'visual@example.com',
      password: 'visual-password',
    },
  })
  if (!response.ok()) {
    throw new Error(`Visual test login failed with ${response.status()}`)
  }
}

export async function settleForScreenshot(page: Page): Promise<void> {
  await page.addStyleTag({
    content: `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
        scroll-behavior: auto !important;
      }
      .continuous-fade-in-out { animation: none !important; opacity: 1 !important; }
      .frameos-connection-dot__flow {
        animation: none !important;
        opacity: 0 !important;
        transform: scale(1) !important;
      }
      input, textarea { caret-color: transparent !important; }
      html[data-frameos-theme='light'] *,
      html[data-frameos-theme='light'] *::before,
      html[data-frameos-theme='light'] *::after {
        scrollbar-color: transparent transparent !important;
      }
      html[data-frameos-theme='light'] *::-webkit-scrollbar,
      html[data-frameos-theme='light'] *::-webkit-scrollbar-track,
      html[data-frameos-theme='light'] *::-webkit-scrollbar-thumb,
      html[data-frameos-theme='light'] *::-webkit-scrollbar-corner {
        background: transparent !important;
        border-color: transparent !important;
      }
      html[data-frameos-theme='light'] .monaco-editor .scrollbar,
      html[data-frameos-theme='light'] .monaco-editor .scrollbar .slider,
      html[data-frameos-theme='light'] .monaco-scrollable-element > .scrollbar,
      html[data-frameos-theme='light'] .monaco-scrollable-element > .scrollbar > .slider,
      html[data-frameos-theme='light'] .monaco-scrollable-element > .shadow {
        opacity: 0 !important;
        visibility: hidden !important;
      }
    `,
  })
  await page.locator('body').waitFor({ state: 'visible' })
  await page.waitForFunction(() => {
    const body = document.body
    if (body.innerText.trim().length > 0) {
      return true
    }
    return Boolean(body.querySelector('button, canvas, img, input, select, textarea, video, [role="button"]'))
  })
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(500)
  await stabilizeActiveLogsSearchScroll(page)
}

async function stabilizeActiveLogsSearchScroll(page: Page): Promise<void> {
  const searchActive = await page
    .getByPlaceholder(/Search logs/i)
    .evaluateAll((elements) =>
      elements.some((element) => element instanceof HTMLInputElement && element.value.trim().length > 0)
    )

  if (!searchActive) {
    return
  }

  await page.evaluate(() => window.scrollTo(0, 0))
  await page.waitForFunction(() => window.scrollY === 0)
  await page.waitForTimeout(100)
}

export function attachFrontendErrorCollector(page: Page): () => string[] {
  const errors: string[] = []
  page.on('pageerror', (error) => {
    errors.push(error.stack || error.message)
  })
  page.on('console', (message) => {
    if (message.type() !== 'error') {
      return
    }
    const text = message.text()
    if (/favicon\.ico/i.test(text)) {
      return
    }
    if (/TypeError: Failed to fetch[\s\S]*\bat sync\b/.test(text)) {
      return
    }
    errors.push(text)
  })
  return () => errors
}

function fulfillJson(body: unknown): (route: Route) => Promise<void> {
  return (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(body),
    })
}

function fulfillText(body: string): (route: Route) => Promise<void> {
  return (route) =>
    route.fulfill({
      status: 200,
      contentType: 'text/plain',
      body,
    })
}
