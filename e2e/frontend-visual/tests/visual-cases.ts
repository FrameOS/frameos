import type { Page } from '@playwright/test'

export type VisualTheme = 'light' | 'dark'
export type VisualViewportName = 'mobile' | 'mid' | 'full'

export interface VisualViewport {
  name: VisualViewportName
  width: number
  height: number
}

export interface VisualVariant {
  id: string
  label?: string
  prepare?: (page: Page) => Promise<void>
  fullPage?: boolean
}

export interface VisualCase {
  id: string
  title: string
  path: string
  authenticated?: boolean
  themes?: VisualTheme[]
  viewports?: VisualViewportName[]
  fullPage?: boolean
  ready?: (page: Page) => Promise<void>
  variants?: VisualVariant[]
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

export const visualThemes: VisualTheme[] = ['light', 'dark']

export const visualViewports: VisualViewport[] = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'mid', width: 900, height: 900 },
  { name: 'full', width: 1440, height: 1000 },
]

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
  await heading.waitFor()
}

async function openSceneWorkspacePreviewDrawer(page: Page): Promise<void> {
  await openSceneWorkspaceUtilityDrawer(page, 'Preview')
}

async function openSceneWorkspaceAppsDrawer(page: Page): Promise<void> {
  await openSceneWorkspaceUtilityDrawer(page, 'Apps')
}

async function openSceneWorkspaceEventsDrawer(page: Page): Promise<void> {
  await openSceneWorkspaceUtilityDrawer(page, 'Events')
}

async function openSceneWorkspaceJsonDrawer(page: Page): Promise<void> {
  await openSceneWorkspaceUtilityDrawer(page, 'JSON')
}

async function openAddSceneDrawer(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /Add scene/i })
    .first()
    .click()
  await page
    .getByRole('heading', { name: /Add scene/i })
    .last()
    .waitFor()
}

async function expandDashboardScene(page: Page): Promise<void> {
  const legacySceneRow = page.locator('[data-scene-id="scene-dashboard"]').first()
  if (await legacySceneRow.count()) {
    await legacySceneRow.scrollIntoViewIfNeeded()

    const openEditorButton = legacySceneRow.getByRole('button', { name: /^Open editor$/ })
    if (!(await openEditorButton.isVisible().catch(() => false))) {
      await legacySceneRow
        .getByText(/^Dashboard$/)
        .first()
        .click()
    }

    await openEditorButton.waitFor()
    await legacySceneRow.getByRole('button', { name: /^Delete$/ }).waitFor()
    return
  }

  const sceneButton = page.getByRole('button', { name: /Dashboard.*nodes/i }).first()
  await sceneButton.scrollIntoViewIfNeeded()
  await sceneButton.click()

  const sceneDrawer = page
    .locator('.workspace-drawer')
    .filter({ has: page.getByRole('heading', { name: /^Dashboard$/ }) })
    .last()
  await sceneDrawer.getByRole('link', { name: /^Open editor$/ }).waitFor()
  await sceneDrawer.getByRole('button', { name: /^Delete$/ }).waitFor()
}

async function fillLogsSearch(page: Page): Promise<void> {
  await page.getByPlaceholder(/Search logs/i).fill('render')
}

async function closeSecondaryPanel(page: Page): Promise<void> {
  const activeNavigationButton = page.locator('.frameos-nav-button[title^="Hide "]').first()
  if (await activeNavigationButton.isVisible().catch(() => false)) {
    await activeNavigationButton.click()
  }
  await page.locator('.workspace-sidebar-collapsed').first().waitFor()
}

async function openAddFrameDrawer(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /Add frame/i })
    .first()
    .click()
  await page
    .getByRole('heading', { name: /Add frame/i })
    .last()
    .waitFor()
}

async function openSettingsNetworkSection(page: Page): Promise<void> {
  const networkShortcut = page
    .locator('.frameos-frame-tool-subnav button')
    .filter({ hasText: /^Network$/ })
    .first()
  if (await networkShortcut.isVisible().catch(() => false)) {
    await networkShortcut.click()
  }
  await page.locator('#frame-settings-network').scrollIntoViewIfNeeded()
}

async function stabilizeTerminal(page: Page): Promise<void> {
  await page
    .getByText('*** connection closed ***')
    .waitFor({ timeout: 10_000 })
    .catch(() => undefined)
  await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
  await page.waitForTimeout(250)
}

export const visualCases: VisualCase[] = [
  {
    id: 'auth-login',
    title: 'Login',
    path: '/login',
    authenticated: false,
    variants: [{ id: 'default' }],
  },
  {
    id: 'auth-signup',
    title: 'Signup',
    path: '/signup',
    authenticated: false,
    variants: [{ id: 'default' }],
  },
  {
    id: 'frames-home',
    title: 'Frames home',
    path: '/',
    fullPage: true,
    variants: [
      { id: 'default' },
      { id: 'secondary-panel-closed', prepare: closeSecondaryPanel },
      { id: 'add-frame', prepare: openAddFrameDrawer },
    ],
  },
  {
    id: 'frame-overview-route',
    title: 'Frame overview route',
    path: '/frames/1',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
  {
    id: 'frame-overview',
    title: 'Frame overview',
    path: '/frames/1?tool=overview',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
  {
    id: 'frame-scenes',
    title: 'Frame scenes',
    path: '/frames/1?tool=scenes',
    fullPage: true,
    variants: [
      { id: 'default' },
      { id: 'expanded-scene', prepare: expandDashboardScene },
      { id: 'add-scene', prepare: openAddSceneDrawer },
    ],
  },
  {
    id: 'frame-schedule-route',
    title: 'Frame schedule route',
    path: '/frames/1?tool=schedule',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
  {
    id: 'frame-preview',
    title: 'Frame preview',
    path: '/frames/1?tool=preview',
    variants: [{ id: 'default' }],
  },
  {
    id: 'frame-logs',
    title: 'Frame logs',
    path: '/frames/1?tool=logs',
    variants: [{ id: 'default' }, { id: 'filtered-render', prepare: fillLogsSearch }],
  },
  {
    id: 'frame-metrics',
    title: 'Frame metrics',
    path: '/frames/1?tool=metrics',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
  {
    id: 'frame-assets',
    title: 'Frame assets',
    path: '/frames/1?tool=assets',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
  {
    id: 'frame-terminal',
    title: 'Frame terminal',
    path: '/frames/1?tool=terminal',
    variants: [{ id: 'default', prepare: stabilizeTerminal }],
  },
  {
    id: 'frame-ping',
    title: 'Frame ping',
    path: '/frames/1?tool=ping',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
  {
    id: 'frame-debug',
    title: 'Frame debug',
    path: '/frames/1?tool=debug',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
  {
    id: 'frame-settings',
    title: 'Frame settings',
    path: '/frames/1?tool=settings',
    fullPage: true,
    variants: [{ id: 'default' }, { id: 'network', prepare: openSettingsNetworkSection }],
  },
  {
    id: 'scene-workspace',
    title: 'Scene workspace',
    path: '/scenes/1/scene-dashboard',
    fullPage: true,
    variants: [
      { id: 'diagram' },
      { id: 'preview-drawer', prepare: openSceneWorkspacePreviewDrawer },
      { id: 'apps-drawer', prepare: openSceneWorkspaceAppsDrawer },
      { id: 'events-drawer', prepare: openSceneWorkspaceEventsDrawer },
      { id: 'json-drawer', prepare: openSceneWorkspaceJsonDrawer },
    ],
  },
  {
    id: 'apps-workspace-root',
    title: 'Apps workspace root',
    path: '/apps',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
  {
    id: 'apps-workspace-frame',
    title: 'Apps workspace frame',
    path: '/apps/1',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
  {
    id: 'apps-workspace-scene',
    title: 'Apps workspace scene',
    path: '/apps/1/scene-dashboard',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
  {
    id: 'apps-workspace',
    title: 'Apps workspace',
    path: '/apps/1/scene-dashboard/c3bbaf66-f11d-45d2-9bed-5395ac0c01b2',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
  {
    id: 'global-settings',
    title: 'Global settings',
    path: '/settings',
    fullPage: true,
    variants: [{ id: 'default' }],
  },
]
