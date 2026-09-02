import { expect, test, type Page } from '@playwright/test'
import { attachFrontendErrorCollector, settleForScreenshot } from './visual-helpers'
import {
  bundleAvailable,
  CLOUD_ORIGIN,
  cloudFrames,
  expectNoCloudFrontendErrors,
  fixedNow,
  prepareCloudPage,
  serveCloudWorkspace,
} from './cloud-workspace-fixture'

/**
 * The battery indicator of a battery-powered (ESP32) cloud frame and the
 * popup it opens (frontend/src/scenes/workspace/FrameBatteryPopover.tsx):
 *
 *   - in the /frames fleet list the glyph + number is one invisible button
 *     with a padded hit area (no dead whitespace between the two);
 *   - in the sidebar of /frames/<id> and /frames/<id>/scenes/<sceneId> it is
 *     a bordered control beside the frame selector, the same on both pages;
 *   - the frame dashboard's header metric chip opens the popup too;
 *   - clicking anywhere on it opens the popup — never the metrics page —
 *     with the charge, voltage, wake cadence, the two-week history chart
 *     and the forecast slider that re-projects the life at another cadence.
 *
 * The metrics history is a synthetic seven-day series: two days of a
 * discharge, a charge over USB, then five days at ~4.8 points a day down
 * to 77%, so the chart shows a charge event and the forecast has a "good"
 * fit to work from (utils/batteryForecast.ts).
 */

const BATTERY_FRAME_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'
const STORE_SCENE_ID = '2d936e5f-9fba-451b-8149-ea5a21e34bb9'
const RUNTIME_SCENE_ID = '66d900ea-3f43-5652-a19e-4a66988cd902'
const CYCLE_SECONDS = 900
const nowMs = Date.parse(fixedNow)

function batterySample(index: number, percent: number, onBattery: boolean) {
  const t = nowMs - (672 - index) * CYCLE_SECONDS * 1000
  return {
    id: String(10_000 + index),
    frame_id: BATTERY_FRAME_ID,
    timestamp: new Date(t).toISOString(),
    metrics: {
      event: 'metrics',
      source: 'esp32',
      renders: 1,
      wifiRssi: -50 + (index % 3),
      onBattery,
      wakeCause: 'timer',
      freeHeapKB: 107,
      freePsramKB: 2047,
      loadedScenes: 1,
      renderLastMs: 59_600 + (index % 5) * 200,
      uptimeSeconds: 63 + (index % 3),
      batteryPercent: percent,
      batteryMillivolts: 3300 + percent * 8,
    },
  }
}

/** Seven days of 15-minute wakes ending at the fixed clock. */
function batteryHistory() {
  const samples = []
  for (let index = 0; index < 672; index++) {
    const days = index / 96
    const wobble = 0.6 * Math.sin(index / 7)
    if (days < 2) {
      samples.push(batterySample(index, Math.round(44 - days * 7 + wobble), true))
    } else if (index === 192 || index === 193) {
      samples.push(batterySample(index, index === 192 ? 61 : 92, false))
    } else {
      samples.push(batterySample(index, Math.round(100 - (days - 2) * 4.8 + wobble), true))
    }
  }
  return samples
}

const history = batteryHistory()
const latest = history[history.length - 1]
const latestPercent = String(latest.metrics.batteryPercent)
const latestVolts = `${(latest.metrics.batteryMillivolts / 1000).toFixed(2)} V`

const batteryFrame = {
  id: BATTERY_FRAME_ID,
  name: 'E1004',
  frame_host: 'e1004',
  ssh_user: '',
  status: 'ready',
  connected: false,
  active_connections: 0,
  frameos_version: '2026.9.0',
  hardware: {
    platform: 'esp32-s3',
    panel: 'EPD_13in3e',
    device: 'EPD_13in3e',
    width: 1200,
    height: 1600,
    memory: { psramBytes: 8_388_608, internalHeapBytes: 377_315 },
  },
  created_at: '2026-05-01T09:00:00Z',
  last_seen_at: new Date(nowMs - 5 * 60 * 1000).toISOString(),
  last_log_at: null,
  next_wake_at: new Date(nowMs + 10 * 60 * 1000).toISOString(),
  next_render_at: new Date(nowMs + 10 * 60 * 1000 + 5000).toISOString(),
  sleep_reason: 'battery',
  linked_client_id: 'lc-cloud-3',
  assigned_checksum: 'def456',
  scenes_checksum: 'def456',
  width: 1200,
  height: 1600,
  device: 'EPD_13in3e',
  interval: CYCLE_SECONDS,
  deep_sleep: false,
  deep_sleep_on_battery: true,
  scenes: [],
  last_metrics: latest.metrics,
  last_state: { active_scene: RUNTIME_SCENE_ID },
}

const storeScene = [
  {
    id: RUNTIME_SCENE_ID,
    name: 'Weather',
    nodes: [],
    edges: [],
    fields: [],
    settings: { execution: 'interpreted' },
  },
]

async function serveBatteryWorkspace(page: Page): Promise<void> {
  await serveCloudWorkspace(page, { frames: [batteryFrame, ...cloudFrames] })
  // Registered after the fixture's mocks, so these win (Playwright checks
  // routes in reverse registration order).
  await page.route(`${CLOUD_ORIGIN}/api/frames/${BATTERY_FRAME_ID}`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ frame: batteryFrame }) })
  )
  await page.route(`${CLOUD_ORIGIN}/api/frames/${BATTERY_FRAME_ID}/scenes`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ scenes: [{ scene_id: STORE_SCENE_ID, name: 'Weather', latest_version: 3, position: 0 }] }),
    })
  )
  await page.route(`${CLOUD_ORIGIN}/api/store/scenes/${STORE_SCENE_ID}/scenes.json*`, (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(storeScene) })
  )
  await page.route(`${CLOUD_ORIGIN}/api/frames/${BATTERY_FRAME_ID}/metrics/recent*`, (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ metrics: history, reboots: [] }),
    })
  )
}

async function openBatteryPopover(page: Page, button: ReturnType<Page['locator']>) {
  await button.click()
  const popover = page.getByTestId('battery-popover')
  await expect(popover).toBeVisible()
  // The two-week history has landed once the cadence is measured.
  await expect(popover.getByTestId('battery-facts')).toContainText('every 15 min')
  await expect(popover.getByTestId('battery-forecast')).toContainText('At this pace: about 16 days left')
  return popover
}

test.describe('cloud battery indicator @e2e', () => {
  test.skip(!bundleAvailable, 'cloud-frontend/dist missing — run `pnpm --dir cloud-frontend run build`')

  for (const theme of ['light', 'dark'] as const) {
    test(`frames list: the glyph is one invisible button that opens the popup / ${theme}`, async ({ page }) => {
      const readErrors = attachFrontendErrorCollector(page)
      await page.setViewportSize({ width: 1440, height: 900 })
      await prepareCloudPage(page, theme)
      await serveBatteryWorkspace(page)

      await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
      const row = page.locator('.frameos-frame-row', { hasText: 'E1004' }).first()
      await expect(row).toBeVisible()
      await expect(row).toContainText('asleep · wakes in 10 min')

      const button = row.getByTestId('battery-button')
      await expect(button).toHaveAttribute('data-battery-variant', 'list')
      await expect(button.getByTestId('battery-indicator')).toHaveAttribute('data-battery-percent', latestPercent)
      // Looks like the plain glyph the row always had — no border, no fill —
      // but the button covers glyph, gap and number with room to spare.
      await expect(button).toHaveCSS('border-top-width', '0px')
      await expect(button).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)')
      const buttonBox = (await button.boundingBox())!
      const indicatorBox = (await button.getByTestId('battery-indicator').boundingBox())!
      expect(buttonBox.width).toBeGreaterThan(indicatorBox.width + 8)
      expect(buttonBox.height).toBeGreaterThan(indicatorBox.height + 8)

      await settleForScreenshot(page)
      await expect(row).toHaveScreenshot(`cloud-battery-frames-row--${theme}.png`)

      // Clicking the gap between the glyph and the number opens the popup
      // and never leaves the page.
      await page.mouse.click(indicatorBox.x + indicatorBox.width * 0.45, indicatorBox.y + indicatorBox.height / 2)
      await expect(page.getByTestId('battery-popover')).toBeVisible()
      expect(new URL(page.url()).pathname).toBe('/frames')
      expectNoCloudFrontendErrors(readErrors)
    })

    test(`frame page: bordered control beside the selector, popup with history and forecast / ${theme}`, async ({
      page,
    }) => {
      const readErrors = attachFrontendErrorCollector(page)
      await page.setViewportSize({ width: 1440, height: 1000 })
      await prepareCloudPage(page, theme)
      await serveBatteryWorkspace(page)

      await page.goto(`${CLOUD_ORIGIN}/frames/${BATTERY_FRAME_ID}`, { waitUntil: 'domcontentloaded' })
      const selector = page.getByTestId('frame-sidebar-selector')
      await expect(selector).toBeVisible()
      const button = selector.getByTestId('battery-button')
      await expect(button).toHaveAttribute('data-battery-variant', 'panel')
      await expect(button).toHaveCSS('border-top-width', '1px')
      await settleForScreenshot(page)
      await expect(selector).toHaveScreenshot(`cloud-battery-frame-sidebar--${theme}.png`)

      const popover = await openBatteryPopover(page, button)
      await expect(popover).toContainText(`${latestPercent}%`)
      await expect(popover).toContainText(latestVolts)
      await expect(popover.getByTestId('battery-facts')).toContainText('Awake per wake')
      await expect(popover.getByTestId('battery-facts')).toContainText('Since last charge')
      await expect(popover.getByTestId('battery-chart')).toBeVisible()
      await expect(popover.getByTestId('battery-forecast')).toContainText('(as now)')
      expect(new URL(page.url()).pathname).toBe(`/frames/${BATTERY_FRAME_ID}`)

      await settleForScreenshot(page)
      await expect(popover).toHaveScreenshot(`cloud-battery-popover--${theme}.png`)

      // The slider re-projects the life at another cadence: one wake an hour
      // buys a bit over three times the days.
      const slider = popover.getByTestId('battery-forecast-slider')
      const stops = Number(await slider.getAttribute('max'))
      const current = Number(await slider.inputValue())
      expect(current).toBeGreaterThan(0)
      expect(current).toBeLessThan(stops)
      await slider.focus()
      for (let i = current; i < stops; i++) {
        await slider.press('ArrowRight')
        const label = await popover.getByTestId('battery-forecast').textContent()
        if (label?.includes('every 1 h')) {
          break
        }
      }
      await expect(popover.getByTestId('battery-forecast')).toContainText('every 1 h')
      await expect(popover.getByTestId('battery-forecast')).toContainText('about 54 days')
      await expect(popover.getByTestId('battery-forecast')).toContainText('×3.3')
      await settleForScreenshot(page)
      await expect(popover).toHaveScreenshot(`cloud-battery-popover-slider--${theme}.png`)
      expectNoCloudFrontendErrors(readErrors)
    })
  }

  test('scene page: the same control in the same place', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await prepareCloudPage(page, 'light')
    await serveBatteryWorkspace(page)

    await page.goto(`${CLOUD_ORIGIN}/frames/${BATTERY_FRAME_ID}/scenes/${RUNTIME_SCENE_ID}`, {
      waitUntil: 'domcontentloaded',
    })
    const selector = page.getByTestId('frame-sidebar-selector')
    await expect(selector).toBeVisible()
    const button = selector.getByTestId('battery-button')
    await expect(button).toHaveAttribute('data-battery-variant', 'panel')
    await expect(button.getByTestId('battery-indicator')).toHaveAttribute('data-battery-percent', latestPercent)
    await settleForScreenshot(page)
    await expect(selector).toHaveScreenshot('cloud-battery-scene-sidebar--light.png')

    await openBatteryPopover(page, button)
    expect(new URL(page.url()).pathname).toBe(`/frames/${BATTERY_FRAME_ID}/scenes/${RUNTIME_SCENE_ID}`)
    expectNoCloudFrontendErrors(readErrors)
  })

  test('frame dashboard: the header chip opens the popup too', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1000 })
    await prepareCloudPage(page, 'light')
    await serveBatteryWorkspace(page)

    await page.goto(`${CLOUD_ORIGIN}/frames/${BATTERY_FRAME_ID}`, { waitUntil: 'domcontentloaded' })
    const chip = page.locator('.frame-header-metrics').getByTestId('battery-button')
    await expect(chip).toBeVisible()
    await expect(chip).toHaveAttribute('data-battery-variant', 'chip')
    await openBatteryPopover(page, chip)
    expect(new URL(page.url()).pathname).toBe(`/frames/${BATTERY_FRAME_ID}`)
    expectNoCloudFrontendErrors(readErrors)
  })
})
