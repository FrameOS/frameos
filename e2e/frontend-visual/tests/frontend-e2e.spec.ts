import { expect, test, type Page } from '@playwright/test'
import { attachFrontendErrorCollector, login, prepareStablePage, settleForScreenshot } from './visual-helpers'

const frameTools = [
  { label: 'Overview', path: '/frames/1?tool=overview', text: /Kitchen dashboard/i },
  { label: 'Scenes', path: '/frames/1?tool=scenes', text: /Add scene/i },
  { label: 'Preview', path: '/frames/1?tool=preview', text: /Preview/i },
  { label: 'Logs', path: '/frames/1?tool=logs', text: /Search logs/i },
  { label: 'Metrics', path: '/frames/1?tool=metrics', text: /datapoints loaded/i },
  { label: 'Assets', path: '/frames/1?tool=assets', text: /Files/i },
  { label: 'Terminal', path: '/frames/1?tool=terminal', text: /Send command/i },
  { label: 'Ping', path: '/frames/1?tool=ping', text: /Connectivity/i },
  { label: 'Debug', path: '/frames/1?tool=debug', text: /Debug/i },
  { label: 'Settings', path: '/frames/1?tool=settings', text: /Frame info/i },
  { label: 'Schedule redirect', path: '/frames/1?tool=schedule', text: /Schedule/i },
] as const

const sceneUtilityDrawers = ['Preview', 'State variables', 'Apps', 'Events', 'JSON'] as const

const frameSettingsSections = [
  ['Info', 'frame-settings-info'],
  ['Device', 'frame-settings-device'],
  ['SSH', 'frame-settings-ssh'],
  ['Agent', 'frame-settings-agent'],
  ['Backend', 'frame-settings-backend'],
  ['HTTP API', 'frame-http-api-section'],
  ['Admin', 'frame-settings-admin'],
  ['HTTPS', 'frame-http-proxy-section'],
  ['Network', 'frame-settings-network'],
  ['Defaults', 'frame-settings-defaults'],
  ['Palette', 'frame-settings-palette'],
  ['QR code', 'frame-settings-qr'],
  ['Assets', 'frame-settings-assets'],
  ['GPIO', 'frame-settings-gpio'],
  ['Logs', 'frame-settings-logs'],
  ['Reboot', 'frame-settings-reboot'],
] as const

const globalSettingsSections = [
  ['SSH Keys', 'settings-ssh'],
  ['FrameOS Gallery', 'settings-gallery'],
  ['OpenAI', 'settings-openai'],
  ['PostHog', 'settings-posthog'],
  ['Home Assistant', 'settings-home-assistant'],
  ['GitHub', 'settings-github'],
  ['Unsplash API', 'settings-unsplash'],
  ['Cross-compilation build host', 'settings-build-host'],
  ['System information', 'settings-system'],
  ['Custom fonts', 'settings-fonts'],
] as const

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

async function openSceneWorkspaceUtilityDrawer(page: Page, label: string): Promise<void> {
  const heading = page.getByRole('heading', { name: new RegExp(`^${escapeRegex(label)}$`, 'i') }).last()
  if (await heading.isVisible().catch(() => false)) {
    return
  }

  await page
    .locator('.scene-diagram-utility-buttons')
    .getByRole('button', { name: new RegExp(`^${escapeRegex(label)}$`, 'i') })
    .first()
    .click()
  await expect(heading).toBeVisible()
}

async function prepareAuthenticatedPage(page: Page): Promise<() => string[]> {
  const readErrors = attachFrontendErrorCollector(page)
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.route('**/api/repositories/system', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: '[]',
    })
  )
  await prepareStablePage(page, 'light')
  await login(page)
  return readErrors
}

async function expectSectionNearTop(page: Page, id: string): Promise<void> {
  const locator = page.locator(`#${id}`)
  await expect(locator).toBeVisible()
  await expect(locator).toBeInViewport({ ratio: 0 })
}

function expectNoFrontendErrors(readErrors: () => string[]): void {
  const errors = [...new Set(readErrors())]
  expect(errors, `Unexpected frontend errors:\n${errors.join('\n\n')}`).toEqual([])
}

test.describe('backend frontend e2e coverage @e2e', () => {
  test('auth pages render without a logged-in session', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 900, height: 900 })
    await prepareStablePage(page, 'light')

    await page.goto('/login', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: /Log in/i })).toBeVisible()
    await expect(page.getByPlaceholder(/email@example\.com/i)).toBeVisible()

    await page.goto('/signup', { waitUntil: 'domcontentloaded' })
    await expect(page.getByRole('heading', { name: /Create account|Log in/i })).toBeVisible()
    await expect(page.getByPlaceholder(/email@example\.com/i)).toBeVisible()

    expectNoFrontendErrors(readErrors)
  })

  test('workspace route variants render from the backend fixture', async ({ page }) => {
    const readErrors = await prepareAuthenticatedPage(page)
    const routes = [
      { path: '/', text: /Kitchen dashboard/i },
      { path: '/frames/1', text: /Kitchen dashboard/i },
      { path: '/scenes', text: /Scenes/i },
      { path: '/scenes/1', text: /Scenes/i },
      { path: '/scenes/1/scene-dashboard', text: /Dashboard/i },
      { path: '/apps', text: /Apps/i },
      { path: '/apps/1', text: /Apps/i },
      { path: '/apps/1/scene-dashboard', text: /Apps/i },
      { path: '/apps/1/scene-dashboard/c3bbaf66-f11d-45d2-9bed-5395ac0c01b2', text: /Apps/i },
      { path: '/settings', text: /SSH Keys/i },
    ]

    for (const route of routes) {
      await test.step(route.path, async () => {
        await page.goto(route.path, { waitUntil: 'domcontentloaded' })
        await settleForScreenshot(page)
        await expect(page.locator('body')).toContainText(route.text)
      })
    }

    expectNoFrontendErrors(readErrors)
  })

  test('frames home does not load frame states for scene menus', async ({ page }) => {
    const readErrors = await prepareAuthenticatedPage(page)
    let statesRequests = 0

    await page.route('**/api/frames/*/states', (route) => {
      statesRequests += 1
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ sceneId: 'scene-dashboard', states: {} }),
      })
    })

    await page.goto('/', { waitUntil: 'domcontentloaded' })
    await expect(page.locator('body')).toContainText(/Kitchen dashboard/i)
    await page.waitForTimeout(500)

    expect(statesRequests).toBe(0)
    expectNoFrontendErrors(readErrors)
  })

  test('mobile workspace menu opens full screen and closes with browser back', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 390, height: 844 })
    await prepareStablePage(page, 'light')
    await login(page)

    await page.goto('/frames/1?tool=scenes', { waitUntil: 'domcontentloaded' })
    await settleForScreenshot(page)

    const sidebar = page.locator('.workspace-sidebar').first()
    await expect(sidebar).toBeVisible()
    await expect(sidebar).toHaveClass(/workspace-sidebar-collapsed/)

    const activeFrameNav = page.locator('.frameos-nav-button[title="Frame"]')
    await expect(activeFrameNav).toBeVisible()
    await activeFrameNav.click()
    await expect(sidebar).toBeVisible()
    await expect(sidebar).not.toHaveClass(/workspace-sidebar-collapsed/)
    await expect(sidebar).toHaveCSS('position', 'fixed')

    const sidebarBox = await sidebar.boundingBox()
    expect(sidebarBox?.x).toBe(0)
    expect(sidebarBox?.y).toBe(0)
    expect(Math.round(sidebarBox?.width ?? 0)).toBe(390)
    expect(Math.round(sidebarBox?.height ?? 0)).toBe(844)

    await page.goBack()
    await expect(sidebar).toHaveClass(/workspace-sidebar-collapsed/)
    await expect(page).toHaveURL(/\/frames\/1\?tool=scenes$/)

    await activeFrameNav.click()
    await expect(sidebar).toBeVisible()
    await page.locator('.frameos-nav-button[title="Hide frame panel"]').click()
    await expect(sidebar).toHaveClass(/workspace-sidebar-collapsed/)
    await expect(page).toHaveURL(/\/frames\/1\?tool=scenes$/)

    expectNoFrontendErrors(readErrors)
  })

  test('all frame tool routes render', async ({ page }) => {
    const readErrors = await prepareAuthenticatedPage(page)

    for (const tool of frameTools) {
      await test.step(tool.label, async () => {
        await page.goto(tool.path, { waitUntil: 'domcontentloaded' })
        await settleForScreenshot(page)
        await expect(page.locator('body')).toContainText(tool.text)
        await expect(page.locator('body')).not.toContainText(/Loading frame\.\.\./i)
      })
    }

    expectNoFrontendErrors(readErrors)
  })

  test('all scene workspace utility drawers render', async ({ page }) => {
    const readErrors = await prepareAuthenticatedPage(page)
    await page.goto('/scenes/1/scene-dashboard', { waitUntil: 'domcontentloaded' })
    await settleForScreenshot(page)

    for (const drawer of sceneUtilityDrawers) {
      await test.step(drawer, async () => {
        await openSceneWorkspaceUtilityDrawer(page, drawer)
      })
    }

    expectNoFrontendErrors(readErrors)
  })

  test('apps workspace AI chat opens app context', async ({ page }) => {
    const readErrors = await prepareAuthenticatedPage(page)
    await page.goto(
      '/apps/1/scene-dashboard/c3bbaf66-f11d-45d2-9bed-5395ac0c01b2?drawer=chat&sceneId=scene-dashboard&frameId=1',
      { waitUntil: 'domcontentloaded' }
    )
    await settleForScreenshot(page)

    await expect(page.locator('.workspace-drawer')).toContainText('Chat about "render/text"')
    await expect(page.locator('.workspace-drawer')).toContainText('Ask for edits to this app')

    await page.goto('/apps/1/scene-dashboard/c3bbaf66-f11d-45d2-9bed-5395ac0c01b2', {
      waitUntil: 'domcontentloaded',
    })
    await settleForScreenshot(page)

    await page.getByTitle('Open AI chat').click()

    await expect(page.locator('.workspace-drawer')).toContainText('Chat about "render/text"')
    await expect(page.locator('.workspace-drawer')).toContainText('Ask for edits to this app')
    await expect(page).toHaveURL(/drawer=chat/)
    await expect(page).toHaveURL(/nodeId=c3bbaf66-f11d-45d2-9bed-5395ac0c01b2/)

    expectNoFrontendErrors(readErrors)
  })

  test('apps workspace app header has scene navigation and discard controls', async ({ page }) => {
    const readErrors = await prepareAuthenticatedPage(page)
    await page.goto('/apps/1/scene-dashboard/c3bbaf66-f11d-45d2-9bed-5395ac0c01b2', {
      waitUntil: 'domcontentloaded',
    })
    await settleForScreenshot(page)

    await expect(page.getByRole('button', { name: 'Back to scene' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Discard changes' })).toBeDisabled()
    await expect(page.getByRole('button', { name: 'Save' })).toBeDisabled()

    await page.getByRole('button', { name: 'Back to scene' }).click()
    await expect(page).toHaveURL(
      (url) =>
        url.pathname === '/scenes/1/scene-dashboard' &&
        url.searchParams.get('nodeId') === 'c3bbaf66-f11d-45d2-9bed-5395ac0c01b2'
    )

    expectNoFrontendErrors(readErrors)
  })

  test('frame settings subsection shortcuts target every section', async ({ page }) => {
    const readErrors = await prepareAuthenticatedPage(page)
    await page.goto('/frames/1?tool=settings', { waitUntil: 'domcontentloaded' })
    await settleForScreenshot(page)

    for (const [label, id] of frameSettingsSections) {
      await test.step(label, async () => {
        await page
          .locator('.frameos-frame-tool-subnav button')
          .filter({ hasText: new RegExp(`^${escapeRegex(label)}$`) })
          .first()
          .click()
        await expectSectionNearTop(page, id)
      })
    }

    expectNoFrontendErrors(readErrors)
  })

  test('global settings navigation targets every section', async ({ page }) => {
    const readErrors = await prepareAuthenticatedPage(page)
    await page.goto('/settings', { waitUntil: 'domcontentloaded' })
    await settleForScreenshot(page)

    for (const [label, id] of globalSettingsSections) {
      await test.step(label, async () => {
        await page
          .locator('.frameos-settings-nav-link')
          .filter({ hasText: new RegExp(`^${escapeRegex(label)}$`) })
          .first()
          .click()
        await expectSectionNearTop(page, id)
      })
    }

    expectNoFrontendErrors(readErrors)
  })
})
