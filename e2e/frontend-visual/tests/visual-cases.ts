import type { Page } from '@playwright/test'
import { mockCloudBackupsApi } from './visual-helpers'

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
  /** Runs before page.goto — for network mocks that must catch mount-time requests. Overrides the case-level setup. */
  setup?: (page: Page) => Promise<void>
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
  /** Runs before page.goto — for network mocks that must catch mount-time requests. */
  setup?: (page: Page) => Promise<void>
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
  await sceneDrawer.getByText(/^Scene control$/).waitFor()
}

async function fillLogsSearch(page: Page): Promise<void> {
  await page.getByPlaceholder(/Search logs/i).fill('render')
  await page.getByText('18 of 45 lines').waitFor()
}

async function scrollLogsToLatest(page: Page): Promise<void> {
  const latestTimestamp = page.getByText('2026-05-23 12:00:00')
  const scrollButton = page.getByRole('button', { name: /^Scroll to latest$/ })

  await page.getByPlaceholder(/Search logs/i).waitFor()
  await page.getByText('45 lines').waitFor()

  for (let attempt = 0; attempt < 6; attempt++) {
    if (await latestTimestamp.isVisible().catch(() => false)) {
      break
    }
    if (await scrollButton.isVisible().catch(() => false)) {
      // The panel can auto-follow to the bottom between the visibility check
      // and the click, which hides the button — that is the state this
      // helper is trying to reach, not a failure. A short timeout plus
      // swallow keeps the loop's own retry (and the final asserts below) as
      // the source of truth instead of deadlocking on a vanished button.
      await scrollButton.click({ timeout: 1000 }).catch(() => {})
    }
    await page.evaluate(() => {
      const scrollElement = document.scrollingElement ?? document.documentElement
      window.scrollTo(0, scrollElement.scrollHeight)
    })
    await page.waitForTimeout(150)
  }

  await latestTimestamp.waitFor({ state: 'visible' })
  await scrollButton.waitFor({ state: 'hidden' })
}

async function closeSecondaryPanel(page: Page): Promise<void> {
  const collapsedSidebar = page.locator('.workspace-sidebar-collapsed').first()
  if (await collapsedSidebar.isVisible().catch(() => false)) {
    return
  }
  // Let click() do the waiting instead of a point-in-time isVisible() check:
  // skipping the click when the button has not rendered yet turns into a
  // guaranteed timeout on the collapsed sidebar below.
  await page.locator('.frameos-nav-button[title^="Hide "]').first().click()
  await collapsedSidebar.waitFor()
}

async function openAddFrameDrawer(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: /Add frame/i })
    .first()
    .click()
  const drawer = page.locator('.workspace-drawer').filter({ hasText: /Installation method/i }).last()
  await drawer.waitFor()
  await drawer.getByRole('button', { name: /Download SD card/i }).waitFor()
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

async function openSettingsCloudSection(page: Page): Promise<void> {
  await page.locator('#settings-cloud').scrollIntoViewIfNeeded()
}

async function showCloudBackupsList(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Show backups$/ }).click()
  await page.getByText('Living room frame').waitFor()
  await page.getByText('Morning dashboard scene').waitFor()
  await openSettingsCloudSection(page)
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
    variants: [{ id: 'default', prepare: scrollLogsToLatest }, { id: 'filtered-render', prepare: fillLogsSearch }],
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
  {
    id: 'global-settings-cloud-backups',
    title: 'Global settings cloud backups',
    path: '/settings',
    fullPage: true,
    viewports: ['mobile', 'full'],
    setup: async (page) => {
      await mockCloudBackupsApi(page)
    },
    variants: [
      { id: 'connected', prepare: openSettingsCloudSection },
      { id: 'backups-list', prepare: showCloudBackupsList },
      {
        id: 'switched-off',
        setup: async (page) => {
          await mockCloudBackupsApi(page, { backupScenesEnabled: false, backupFramesEnabled: false })
        },
        prepare: openSettingsCloudSection,
      },
    ],
  },
]
