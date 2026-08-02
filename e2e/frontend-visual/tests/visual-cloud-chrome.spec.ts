import { execFile } from 'child_process'
import { join } from 'path'
import { promisify } from 'util'
import { expect, test, type Page } from '@playwright/test'
import { settleForScreenshot } from './visual-helpers'

/**
 * Visual + e2e coverage for the shared FrameOS Cloud chrome on the Next.js
 * pages: the store front (cloud/apps/auth-web/app/page.tsx, PublicShell) and
 * the account installs page (/backends → /account/installs), which now render
 * the same frameos-account-header and mist/graphite palette as the /frames
 * workspace via app/cloud-chrome.css. Dark mode is carried by the shared
 * frameos_theme cookie (app/layout.tsx renders html.theme-dark straight from
 * it, no flash) — the same cookie visual-cloud-frames-workspace.spec.ts feeds
 * the SPA, so the two suites together pin both sides of the agreement.
 *
 * These tests need the REAL cloud stack (Next.js auth-web + Postgres) — the
 * store front and account pages are server-rendered from the database, which
 * the frontend-visual CI job does not have. They only run when
 * FRONTEND_VISUAL_CLOUD_URL points at a running cloud dev server, e.g.:
 *
 *   cd cloud && scripts/db-setup.sh          # once
 *   cd cloud/apps/auth-web && pnpm dev       # serves http://localhost:3000
 *   FRONTEND_VISUAL_CLOUD_URL=http://localhost:3000 FRONTEND_VISUAL_SKIP_WEBSERVER=1 \
 *     pnpm exec playwright test -c e2e/frontend-visual/playwright.config.ts visual-cloud-chrome
 *
 * A fresh verified account is created per run (scripts/e2e-frameos-account.mjs,
 * the same helper cloud/scripts/e2e-frameos.sh uses), so the signed-in pages
 * are deterministic: no linked backends, no frames, no private scenes. The
 * store front's scene shelves depend on whatever is published in the local
 * database, so its snapshots clip to the top chrome (header + intro + search)
 * and leave the shelves to assertions.
 */

const cloudUrl = process.env.FRONTEND_VISUAL_CLOUD_URL
const cloudRoot = join(__dirname, '..', '..', '..', 'cloud')
const maskedEmail = 'e2e-account@example.com'

let sessionCookie: { name: string; value: string } | undefined
let accountEmail: string | undefined

async function createVerifiedAccount(): Promise<void> {
  const { stdout } = await promisify(execFile)('node', [join(cloudRoot, 'scripts', 'e2e-frameos-account.mjs')], {
    env: { ...process.env, CLOUD_URL: cloudUrl },
  })
  const parsed = JSON.parse(stdout.trim()) as { cookie: string; email: string }
  const [name, ...rest] = parsed.cookie.split('=')
  sessionCookie = { name: name!, value: rest.join('=') }
  accountEmail = parsed.email
}

async function signIn(page: Page): Promise<void> {
  if (!sessionCookie) {
    throw new Error('No e2e account session — createVerifiedAccount did not run')
  }
  await page.context().addCookies([{ ...sessionCookie, url: cloudUrl! }])
}

async function setTheme(page: Page, theme: 'light' | 'dark'): Promise<void> {
  // The shared cookie both surfaces read; the server renders html.theme-dark
  // from it before any client JS runs (app/layout.tsx).
  await page.context().addCookies([{ name: 'frameos_theme', value: theme, url: cloudUrl! }])
}

/** The account email is random per run; pin the rendered text so signed-in
 * snapshots compare across runs. */
async function maskAccountEmail(page: Page): Promise<void> {
  if (!accountEmail) {
    return
  }
  await page.evaluate(
    ({ email, masked }) => {
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT)
      const nodes: Text[] = []
      while (walker.nextNode()) {
        nodes.push(walker.currentNode as Text)
      }
      for (const node of nodes) {
        if (node.nodeValue && node.nodeValue.includes(email)) {
          node.nodeValue = node.nodeValue.split(email).join(masked)
        }
      }
    },
    { email: accountEmail, masked: maskedEmail }
  )
}

/** The Next.js dev-tools indicator (bottom-left badge) is dev-server chrome,
 * not product UI — and these tests only ever run against a dev server. */
async function hideNextDevIndicator(page: Page): Promise<void> {
  await page.addStyleTag({ content: 'nextjs-portal { display: none !important; }' })
}

async function expectThemeClass(page: Page, theme: 'light' | 'dark'): Promise<void> {
  const classes = (await page.locator('html').getAttribute('class')) ?? ''
  if (theme === 'dark') {
    expect(classes).toContain('theme-dark')
  } else {
    expect(classes).not.toContain('theme-dark')
  }
}

test.describe('cloud chrome: store front and account pages @e2e', () => {
  test.skip(
    !cloudUrl,
    'Set FRONTEND_VISUAL_CLOUD_URL to a running cloud dev server (needs Postgres; see the header comment)'
  )

  test.beforeAll(async () => {
    await createVerifiedAccount()
  })

  for (const theme of ['light', 'dark'] as const) {
    test(`store front chrome, signed out / ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await setTheme(page, theme)
      await page.goto(`${cloudUrl}/`, { waitUntil: 'networkidle' })

      await expectThemeClass(page, theme)
      const header = page.locator('header.frameos-account-header')
      await expect(header).toBeVisible()
      await expect(header.getByRole('link', { name: 'Scenes', exact: true })).toBeVisible()
      await expect(header.getByRole('link', { name: 'Sign in' })).toBeVisible()
      // Signed out there is nothing behind the Frames link, so it is absent.
      await expect(header.getByRole('link', { name: 'Frames', exact: true })).toHaveCount(0)

      await settleForScreenshot(page)
      // Top chrome only: the scene shelves below depend on what the local
      // database has published, so they stay out of the pixel comparison.
      await expect(page).toHaveScreenshot(`store-front--signed-out--${theme}.png`, {
        clip: { x: 0, y: 0, width: 1280, height: 200 },
      })
    })

    test(`installs page (the /backends surface), signed in / ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 })
      await signIn(page)
      await setTheme(page, theme)
      await page.goto(`${cloudUrl}/account/installs`, { waitUntil: 'networkidle' })

      await expectThemeClass(page, theme)
      await expect(page.getByRole('heading', { name: 'Linked backends' })).toBeVisible()
      await expect(page.getByText('No linked backends yet.')).toBeVisible()
      // The same header chrome as the store and the /frames workspace.
      const header = page.locator('header.frameos-account-header')
      await expect(header).toBeVisible()
      await expect(header.getByRole('link', { name: 'Frames', exact: true })).toBeVisible()

      await maskAccountEmail(page)
      await settleForScreenshot(page)
      await hideNextDevIndicator(page)
      await expect(page).toHaveScreenshot(`account-installs--${theme}.png`, { fullPage: true })
    })
  }

  test('store front shows the Frames link when signed in', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signIn(page)
    await setTheme(page, 'light')
    await page.goto(`${cloudUrl}/`, { waitUntil: 'networkidle' })

    // The point of the header change: PublicShell now offers Frames to
    // signed-in visitors, ordered as in AppShell (Scenes, Frames, Account).
    const header = page.locator('header.frameos-account-header')
    const frames = header.getByRole('link', { name: 'Frames', exact: true })
    await expect(frames).toBeVisible()
    await expect(frames).toHaveAttribute('href', /\/frames$/)
    await expect(header.getByRole('link', { name: 'Account', exact: true })).toBeVisible()
    await expect(header.getByRole('button', { name: 'Sign out' })).toBeVisible()

    // A fresh account's private-scenes shelf renders its deterministic empty
    // state above the store content.
    await expect(page.getByRole('heading', { name: 'My private scenes' })).toBeVisible()
    await expect(page.getByText('You do not have any private scenes yet.')).toBeVisible()

    await settleForScreenshot(page)
    await expect(page).toHaveScreenshot('store-front--signed-in--light.png', {
      clip: { x: 0, y: 0, width: 1280, height: 320 },
    })
  })

  test('the /frames workspace is served with the shared chrome and injected config', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 })
    await signIn(page)
    await setTheme(page, 'dark')
    await page.goto(`${cloudUrl}/frames`, { waitUntil: 'domcontentloaded' })

    // The SPA shell arrives with the deployment config injected at the
    // //__FRAMEOS_CLOUD_APP_CONFIG__ anchor (app/frames/[[...path]]/route.ts).
    await page.waitForFunction(() => Boolean((window as any).FRAMEOS_APP_CONFIG?.cloud_account_url))
    const appConfig = await page.evaluate(() => (window as any).FRAMEOS_APP_CONFIG)
    expect(String(appConfig.cloud_frames_url)).toMatch(/\/frames$/)
    expect(String(appConfig.cloud_origin)).toMatch(/^https?:\/\//)

    // Same header, same dark palette as the Next.js pages — carried by the
    // same cookie. (No pixel snapshot here: the enrollment panel mints a
    // fresh claim code per load, so the page's text is never stable.)
    await expect(page.locator('header.frameos-account-header')).toBeVisible()
    await expect(page.locator('html')).toHaveAttribute('data-frameos-theme', 'dark')
    const nav = page.locator('header.frameos-account-header nav')
    for (const link of ['Scenes', 'Frames', 'Account']) {
      await expect(nav.getByRole('link', { name: link, exact: true })).toBeVisible()
    }
  })
})
