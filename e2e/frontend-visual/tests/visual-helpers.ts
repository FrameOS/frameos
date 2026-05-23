import type { Page, Route } from '@playwright/test'

const fixedNow = '2026-05-23T12:00:00Z'

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

  await page.route('**/api/system/metrics', fulfillJson({
    disk: { totalBytes: 58_000_000_000, usedBytes: 4_100_000_000, freeBytes: 53_900_000_000 },
    memory: { totalBytes: 512_000_000, availableBytes: 302_000_000 },
    load: { one: 0.14, five: 0.1, fifteen: 0.08 },
  }))

  await page.route('**/api/frames/1/assets', fulfillJson({
    assets: [
      { path: '/srv/assets', size: 4096, mtime: 1_779_535_200, is_dir: true },
      { path: '/srv/assets/fonts', size: 4096, mtime: 1_779_535_200, is_dir: true },
      { path: '/srv/assets/fonts/Ubuntu-Regular.ttf', size: 297_884, mtime: 1_779_535_200, is_dir: false },
      { path: '/srv/assets/images', size: 4096, mtime: 1_779_535_200, is_dir: true },
      { path: '/srv/assets/images/dashboard.png', size: 482_400, mtime: 1_779_535_200, is_dir: false },
      { path: '/srv/assets/videos', size: 4096, mtime: 1_779_535_200, is_dir: true },
      { path: '/srv/assets/videos/status-loop.mp4', size: 2_340_000, mtime: 1_779_535_200, is_dir: false },
    ],
  }))

  await page.route('**/api/frames/1/ping**', fulfillJson({
    ok: true,
    mode: 'icmp',
    target: '127.0.0.1',
    elapsed_ms: 3.7,
    status: null,
    message: 'Reply from 127.0.0.1',
  }))

  await page.route('**/api/frames/1/event/**', fulfillText('OK'))
  await page.route('**/api/frames/1/fast_deploy', fulfillJson({ message: 'Deployment queued' }))
  await page.route('**/api/frames/1/deploy', fulfillJson({ message: 'Deployment queued' }))
  await page.route('**/api/frames/1/assets/sync', fulfillJson({ message: 'Assets synced successfully' }))
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
      input, textarea { caret-color: transparent !important; }
    `,
  })
  await page.locator('body').waitFor({ state: 'visible' })
  await page.waitForFunction(() => document.body.innerText.trim().length > 0)
  await page.waitForLoadState('domcontentloaded')
  await page.waitForTimeout(500)
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
