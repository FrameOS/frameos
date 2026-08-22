import { expect, test, type Page } from '@playwright/test'
import {
  attachFrontendErrorCollector,
  login,
  prepareStablePage,
  projectApiPathPattern,
  settleForScreenshot,
} from './visual-helpers'
import { visualThemes, visualViewports } from './visual-cases'

/** Visual states of the "Private cloud scenes" store integration: the
 * Templates panel with a populated/empty private cloud, the not-connected
 * promo, and the "Save to private cloud" modal. The real backend is never
 * linked during visual runs, so the /api/cloud/* surface is mocked at the
 * network layer — mocks must be installed BEFORE page.goto because
 * cloudLogic and cloudDriveLogic load on mount. */

const sceneUuids = {
  sunrise: '11111111-1111-1111-1111-111111111111',
  wordOfTheDay: '22222222-2222-2222-2222-222222222222',
  retroWeather: '33333333-3333-3333-3333-333333333333',
}

function scenePreviewSvg(label: string, background: string, accent: string): string {
  return `
<svg xmlns="http://www.w3.org/2000/svg" width="800" height="480" viewBox="0 0 800 480">
  <rect width="800" height="480" fill="${background}"/>
  <rect x="48" y="48" width="704" height="384" rx="24" fill="none" stroke="${accent}" stroke-width="6"/>
  <circle cx="640" cy="140" r="48" fill="${accent}"/>
  <text x="80" y="260" fill="#ffffff" font-family="Arial, sans-serif" font-size="44" font-weight="700">${label}</text>
  <text x="80" y="308" fill="${accent}" font-family="Arial, sans-serif" font-size="22">FrameOS visual fixture</text>
</svg>`.trim()
}

const drivePreviews: Record<string, string> = {
  [sceneUuids.sunrise]: scenePreviewSvg('Sunrise Clock', '#0f172a', '#f59e0b'),
  [sceneUuids.wordOfTheDay]: scenePreviewSvg('Word of the Day', '#1e293b', '#38bdf8'),
  [sceneUuids.retroWeather]: scenePreviewSvg('Retro Weather', '#312e81', '#a5b4fc'),
}

const driveTemplates = [
  {
    id: 'sunrise-clock',
    name: 'Sunrise Clock',
    description: 'A calm sunrise clock for the bedroom frame',
    sceneId: sceneUuids.sunrise,
    image: `/api/cloud/store/drive/image/${sceneUuids.sunrise}`,
    imageWidth: 800,
    imageHeight: 480,
    zip: `https://cloud.frameos.net/api/store/scenes/${sceneUuids.sunrise}/download`,
    url: `https://cloud.frameos.net/scenes/sunrise-clock`,
    visibility: 'private',
    author: 'visual@example.com',
    frameosVersion: '2026.7.1',
  },
  {
    id: 'word-of-the-day',
    name: 'Word of the Day',
    description: 'Learn a new word every morning',
    sceneId: sceneUuids.wordOfTheDay,
    image: `/api/cloud/store/drive/image/${sceneUuids.wordOfTheDay}`,
    imageWidth: 800,
    imageHeight: 480,
    zip: `https://cloud.frameos.net/api/store/scenes/${sceneUuids.wordOfTheDay}/download`,
    url: `https://cloud.frameos.net/scenes/word-of-the-day`,
    visibility: 'public',
    author: 'visual@example.com',
    frameosVersion: '2099.1.1',
  },
  {
    id: 'retro-weather',
    name: 'Retro Weather',
    description: 'A weather station with custom shell integrations',
    sceneId: sceneUuids.retroWeather,
    image: `/api/cloud/store/drive/image/${sceneUuids.retroWeather}`,
    imageWidth: 800,
    imageHeight: 480,
    zip: `https://cloud.frameos.net/api/store/scenes/${sceneUuids.retroWeather}/download`,
    url: `https://cloud.frameos.net/scenes/retro-weather`,
    visibility: 'public',
    author: 'visual@example.com',
    frameosVersion: '2026.7.1',
    flags: ['shell'],
  },
]

/** /api/cloud/status for a linked account whose included features (among them
 * store:publish) are granted. */
const connectedStoreStatus = {
  enabled: true,
  provider_url: 'https://cloud.frameos.net',
  default_provider_url: 'https://cloud.frameos.net',
  status: 'connected',
  can_edit_provider: false,
  poll_error: null,
  local_fallback_enabled: true,
  connection: null,
  identity: null,
  link: {
    linked_client_id: 'lc-visual-1',
    scopes: ['backend:link', 'backend:read', 'backup:scenes', 'backup:frames', 'store:publish'],
    account_id: 'acc-visual-1',
    account_email: 'visual@example.com',
    connected_at: '2026-05-20T09:00:00Z',
  },
}

async function mockCloudStoreApi(
  page: Page,
  { templates = driveTemplates }: { templates?: typeof driveTemplates } = {}
): Promise<void> {
  await page.route(projectApiPathPattern('/cloud/status'), async (route) => {
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(connectedStoreStatus) })
  })
  await page.route(projectApiPathPattern('/cloud/store/drive'), async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ name: 'Private cloud scenes', templates }),
    })
  })
  await page.route(projectApiPathPattern('/cloud/store/drive/image/*'), async (route) => {
    const sceneId = route.request().url().split('/').pop()?.split('?')[0] ?? ''
    const svg = drivePreviews[sceneId] ?? scenePreviewSvg('Scene', '#0f172a', '#94a3b8')
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: svg })
  })
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

interface CloudVisualVariant {
  id: string
  mock?: (page: Page) => Promise<void>
  prepare: (page: Page) => Promise<void>
}

interface CloudVisualCase {
  id: string
  title: string
  path: string
  viewports: Array<'mobile' | 'mid' | 'full'>
  variants: CloudVisualVariant[]
}

const cloudVisualCases: CloudVisualCase[] = [
  {
    id: 'templates-private-cloud',
    title: 'Templates panel private cloud scenes',
    path: '/frames/1',
    viewports: ['mobile', 'full'],
    variants: [
      {
        // Connected, with private and public scenes (one flagged as running
        // shell commands, one published from a newer FrameOS).
        id: 'drive-scenes',
        mock: (page) => mockCloudStoreApi(page),
        prepare: async (page) => {
          await openAddSceneDrawer(page)
          await page.getByText('Sunrise Clock').first().waitFor()
          await page.getByText('Retro Weather').first().waitFor()
        },
      },
      {
        // Connected but nothing saved yet.
        id: 'drive-empty',
        mock: (page) => mockCloudStoreApi(page, { templates: [] }),
        prepare: async (page) => {
          await openAddSceneDrawer(page)
          await page.getByText('No scenes in your cloud yet').first().waitFor()
        },
      },
      {
        // Cloud not connected: the promo with the settings link. No mocks —
        // the visual backend is genuinely unlinked.
        id: 'promo',
        prepare: async (page) => {
          await openAddSceneDrawer(page)
          await page.getByText('Keep your own copy of any scene').first().waitFor()
        },
      },
    ],
  },
  {
    id: 'workspace-save-to-private-cloud',
    title: 'Save to private cloud modal',
    path: '/scenes/1/scene-dashboard',
    viewports: ['full'],
    variants: [
      {
        id: 'modal',
        mock: (page) => mockCloudStoreApi(page),
        prepare: async (page) => {
          const sceneRow = page
            .locator('div.group')
            .filter({ has: page.getByRole('button', { name: /Dashboard/ }) })
            .first()
          await sceneRow.scrollIntoViewIfNeeded()
          await sceneRow.hover()
          // The scene dropdown trigger is the row's only other button; its
          // ellipsis icon carries no accessible name.
          await sceneRow.locator('button').last().click()
          await page.getByRole('menuitem', { name: 'Save to private cloud' }).click()
          await page.getByRole('heading', { name: 'Save to private cloud' }).first().waitFor()
          await page.getByText('Visibility').first().waitFor()
        },
      },
    ],
  },
]

for (const visualCase of cloudVisualCases) {
  const viewports = visualViewports.filter((viewport) => visualCase.viewports.includes(viewport.name))

  for (const theme of visualThemes) {
    for (const viewport of viewports) {
      for (const variant of visualCase.variants) {
        const title = `${visualCase.title} / ${variant.id} / ${theme} / ${viewport.name}`

        test(title, async ({ page }) => {
          const readErrors = attachFrontendErrorCollector(page)
          await page.setViewportSize({ width: viewport.width, height: viewport.height })
          await prepareStablePage(page, theme)
          await login(page)
          await variant.mock?.(page)
          await page.goto(visualCase.path, { waitUntil: 'domcontentloaded' })
          await settleForScreenshot(page)
          await variant.prepare(page)
          await settleForScreenshot(page)

          await expect(page).toHaveScreenshot(`${visualCase.id}--${variant.id}--${theme}--${viewport.name}.png`, {
            fullPage: true,
          })
          const errors = [...new Set(readErrors())]
          expect(errors, `Unexpected frontend errors:\n${errors.join('\n\n')}`).toEqual([])
        })
      }
    }
  }
}
