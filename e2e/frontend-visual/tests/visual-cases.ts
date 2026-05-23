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

export const visualThemes: VisualTheme[] = ['light', 'dark']

export const visualViewports: VisualViewport[] = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'mid', width: 900, height: 900 },
  { name: 'full', width: 1440, height: 1000 },
]

async function openScheduleDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Schedule$/ }).first().click()
  await page.getByRole('heading', { name: /Schedule|Scene schedule/ }).last().waitFor()
}

async function openOverviewScheduleDrawer(page: Page): Promise<void> {
  const scheduleCard = page
    .locator('div')
    .filter({ has: page.getByText(/^Schedule$/) })
    .filter({ has: page.getByRole('button', { name: /^Open$/ }) })
    .first()
  await scheduleCard.getByRole('button', { name: /^Open$/ }).click()
  await page.getByRole('heading', { name: /Schedule|Scene schedule/ }).last().waitFor()
}

async function openSceneWorkspaceScheduleDrawer(page: Page): Promise<void> {
  await page.locator('.workspace-drawer button[title="Schedule"]').click()
  await page.getByRole('heading', { name: /Scene schedule|Schedule/i }).last().waitFor()
}

async function openAddSceneDrawer(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Add scene/i }).first().click()
  await page.getByRole('heading', { name: /Add scene/i }).last().waitFor()
}

async function fillLogsSearch(page: Page): Promise<void> {
  await page.getByPlaceholder(/Search logs/i).fill('render')
}

async function collapsePrimarySidebar(page: Page): Promise<void> {
  const logoButton = page.locator('button[title*="sidebar"], button[aria-label*="sidebar"]').first()
  if (await logoButton.count()) {
    await logoButton.click()
  }
}

async function openSettingsNetworkSection(page: Page): Promise<void> {
  await page.getByRole('button', { name: /Network/i }).first().click()
  await page.locator('#frame-settings-network').waitFor()
}

async function stabilizeTerminal(page: Page): Promise<void> {
  await page.getByText('*** connection closed ***').waitFor({ timeout: 10_000 }).catch(() => undefined)
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
      { id: 'collapsed-sidebar', prepare: collapsePrimarySidebar },
    ],
  },
  {
    id: 'frame-overview',
    title: 'Frame overview',
    path: '/frames/1?tool=overview',
    fullPage: true,
    variants: [
      { id: 'default' },
      { id: 'schedule-drawer', prepare: openOverviewScheduleDrawer },
    ],
  },
  {
    id: 'frame-scenes',
    title: 'Frame scenes',
    path: '/frames/1?tool=scenes',
    fullPage: true,
    variants: [
      { id: 'default' },
      { id: 'add-scene', prepare: openAddSceneDrawer },
      { id: 'schedule-drawer', prepare: openScheduleDrawer },
    ],
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
    variants: [
      { id: 'default' },
      { id: 'filtered-render', prepare: fillLogsSearch },
    ],
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
    variants: [
      { id: 'default' },
      { id: 'network', prepare: openSettingsNetworkSection },
    ],
  },
  {
    id: 'scene-workspace',
    title: 'Scene workspace',
    path: '/scenes/1/scene-dashboard',
    fullPage: true,
    variants: [
      { id: 'diagram' },
      {
        id: 'schedule-drawer',
        prepare: openSceneWorkspaceScheduleDrawer,
      },
    ],
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
