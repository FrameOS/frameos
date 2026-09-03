import { expect, test } from '@playwright/test'
import { attachFrontendErrorCollector, settleForScreenshot } from './visual-helpers'
import {
  addFramePathTitles,
  bundleAvailable,
  CLOUD_ORIGIN,
  expectNoCloudFrontendErrors,
  firmwareListingWithoutGenericEsp32,
  openAddFrameDrawer,
  prepareCloudPage,
  serveCloudWorkspace,
} from './cloud-workspace-fixture'

/**
 * Browser tests for the FrameOS Cloud /frames workspace — the cloud-frontend
 * SPA that cloud/apps/auth-web serves from /frames (see
 * app/frames/[[...path]]/route.ts and cloud-frontend/README.md). The served
 * bundle and the mocked /api/frames/** surface live in
 * cloud-workspace-fixture.ts.
 *
 * Covered here:
 *   - the shared cloud chrome: the frameos-account-header the SPA renders
 *     from the same cloud-chrome.css as the Next.js store/account pages;
 *   - light and dark theme via the shared frameos_theme cookie the two
 *     surfaces agree on (cloud-frontend/src/cloudThemeSync.ts);
 *   - the Add-frame panel: the SD image builder's Display picker (with
 *     width/height prefills, rotation, VCOM, upload URL, "Remember WiFi",
 *     claim-validity select) and the ESP32 flasher's hardware picker
 *     that only appears when the release publishes esp32-s3-generic.
 */

test.describe('cloud /frames workspace @e2e', () => {
  test.skip(!bundleAvailable, 'cloud-frontend/dist missing — run `pnpm --dir cloud-frontend run build`')

  for (const theme of ['light', 'dark'] as const) {
    test(`first-run enrollment panel / ${theme}`, async ({ page }) => {
      const readErrors = attachFrontendErrorCollector(page)
      await page.setViewportSize({ width: 1280, height: 1000 })
      await prepareCloudPage(page, theme)
      await serveCloudWorkspace(page, { frames: [] })

      await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
      // An empty fleet renders the enrollment panel as the page, centered
      // under the shared account header: a chooser of the four ways in.
      await expect(page.getByRole('heading', { name: 'Add a frame' })).toBeVisible()
      for (const title of Object.values(addFramePathTitles)) {
        await expect(page.getByRole('button', { name: title })).toBeVisible()
      }

      // The shared cloud chrome: same header classes as the Next.js pages.
      const header = page.locator('header.frameos-account-header')
      await expect(header).toBeVisible()
      for (const link of ['Scenes', 'Frames', 'Account']) {
        await expect(header.getByRole('link', { name: link, exact: true })).toBeVisible()
      }
      await expect(header.getByRole('button', { name: 'Sign out' })).toBeVisible()

      // The theme signal the two surfaces share.
      await expect(page.locator('html')).toHaveAttribute('data-frameos-theme', theme)

      await settleForScreenshot(page)
      await expect(page).toHaveScreenshot(`cloud-frames-first-run--${theme}.png`, { fullPage: true })

      // The install-script path mints a claim code into its one-liner; the
      // SD card path shows the display picker (its code is minted at build).
      await page.getByRole('button', { name: addFramePathTitles.script }).click()
      await expect(page.getByText('FRCT_e2e00000000000000000000000000000000').first()).toBeVisible()
      await page.getByRole('button', { name: 'All ways to add a frame' }).click()
      await page.getByRole('button', { name: addFramePathTitles.sd }).click()
      await expect(page.getByLabel('Display', { exact: true })).toBeVisible()
      expectNoCloudFrontendErrors(readErrors)
    })

    test(`workspace shell header and fleet / ${theme}`, async ({ page }) => {
      const readErrors = attachFrontendErrorCollector(page)
      await page.setViewportSize({ width: 1440, height: 900 })
      await prepareCloudPage(page, theme)
      await serveCloudWorkspace(page)

      await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
      await expect(page.getByText('Kitchen frame').first()).toBeVisible()
      await expect(page.getByText('Hallway e-ink').first()).toBeVisible()
      await expect(page.locator('header.frameos-account-header')).toBeVisible()

      await settleForScreenshot(page)
      await expect(page).toHaveScreenshot(`cloud-frames-home--${theme}.png`)
      expectNoCloudFrontendErrors(readErrors)
    })
  }

  test('add-frame drawer: SD builder display picker prefills panel dimensions', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1400 })
    await prepareCloudPage(page, 'light')
    await serveCloudWorkspace(page)

    await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Kitchen frame').first()).toBeVisible()
    const drawer = await openAddFrameDrawer(page)

    // Board options come from the mocked release listing; none is picked
    // for you.
    await expect(drawer.getByLabel('Board')).toHaveValue('')
    await expect(
      drawer.getByLabel('Board').locator('option', { hasText: 'Raspberry Pi Zero 2 W / 3 / 4 (64-bit)' })
    ).toHaveCount(1)
    await drawer.getByLabel('Board').selectOption('raspberry-pi-64')

    // No display picked yet: the detail fields stay hidden.
    await expect(drawer.getByLabel('Display width')).toHaveCount(0)

    // Picking a panel prefills its native dimensions.
    await drawer
      .getByLabel('Display', { exact: true })
      .selectOption({ label: 'Waveshare 13.3" (E) 1600x1200 Spectra 6 Color' })
    await expect(drawer.getByLabel('Display width')).toHaveValue('1200')
    await expect(drawer.getByLabel('Display height')).toHaveValue('1600')
    await expect(drawer.getByLabel('Rotation')).toHaveValue('0')
    // VCOM is an IT8951 knob only the 10.3\" reads — hidden for the rest.
    await expect(drawer.getByLabel('VCOM (optional)')).toHaveCount(0)
    // …and no upload URL: that belongs to http.upload (and custom).
    await expect(drawer.getByLabel('Upload URL')).toHaveCount(0)

    // A smaller panel swaps the prefill.
    await drawer
      .getByLabel('Display', { exact: true })
      .selectOption({ label: 'Waveshare 7.3" (E) 800x480 Spectra 6 Color' })
    await expect(drawer.getByLabel('Display width')).toHaveValue('800')
    await expect(drawer.getByLabel('Display height')).toHaveValue('480')

    // HTTP upload shows the upload URL field, still no VCOM.
    await drawer.getByLabel('Display', { exact: true }).selectOption({ label: 'HTTP upload' })
    await expect(drawer.getByLabel('Upload URL')).toHaveAttribute('placeholder', 'Upload URL (required)')
    await expect(drawer.getByLabel('VCOM (optional)')).toHaveCount(0)

    // The IT8951 10.3" is the one panel whose driver reads VCOM.
    await drawer
      .getByLabel('Display', { exact: true })
      .selectOption({ label: 'Waveshare 10.3" 1872x1404 16 Grayscale' })
    await expect(drawer.getByLabel('VCOM (optional)')).toBeVisible()

    // The rest of the SD builder's new controls.
    // Both add-frame flows offer it (SD builder and ESP32 flasher, sharing
    // one stored network), so the drawer has two of these.
    await expect(drawer.getByText('Remember WiFi credentials in this browser').first()).toBeVisible()
    // The card's claim code lasts forever unless you ask for a limit; the
    // validity picker only appears then, defaulting to three months.
    await expect(drawer.getByLabel('Claim code validity')).toHaveCount(0)
    await drawer.getByLabel('Stop this SD card from adding frames after a while').check()
    await expect(drawer.getByLabel('Claim code validity')).toHaveValue('90')
    await expect(drawer.getByLabel('Claim code validity').locator('option', { hasText: '3 months' })).toHaveCount(1)

    // Root login on the device is an explicit choice: a password, or a
    // deliberate passwordless opt-in — the two controls exclude each other.
    await expect(drawer.getByLabel('Root password')).toBeVisible()
    const passwordlessRoot = drawer.getByLabel(/Enable passwordless root login/)
    await expect(passwordlessRoot).not.toBeChecked()
    await drawer.getByLabel('Root password').fill('hunter2')
    await expect(passwordlessRoot).toBeDisabled()
    await drawer.getByLabel('Root password').fill('')
    await passwordlessRoot.check()
    await expect(drawer.getByLabel('Root password')).toBeDisabled()

    expectNoCloudFrontendErrors(readErrors)
  })

  test('add-frame drawer: SD builder visual state', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1400 })
    await prepareCloudPage(page, 'light')
    await serveCloudWorkspace(page)

    await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Kitchen frame').first()).toBeVisible()
    const drawer = await openAddFrameDrawer(page)

    await drawer
      .getByLabel('Display', { exact: true })
      .selectOption({ label: 'Waveshare 13.3" (E) 1600x1200 Spectra 6 Color' })
    await expect(drawer.getByLabel('Display width')).toHaveValue('1200')

    await settleForScreenshot(page)
    await expect(drawer).toHaveScreenshot('cloud-add-frame-drawer--sd-builder.png')
    expectNoCloudFrontendErrors(readErrors)
  })

  test('ESP32 flasher: hardware picker follows the esp32-s3-generic asset', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1400 })
    await prepareCloudPage(page, 'light')
    await serveCloudWorkspace(page)

    await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Kitchen frame').first()).toBeVisible()
    const drawer = await openAddFrameDrawer(page, 'esp32')

    // The release publishes the all-panels build, so the picker shows —
    // defaulting to the firmware's baked-in 7.5" V2.
    const panelPicker = drawer.getByLabel('Frame hardware')
    await expect(panelPicker).toBeVisible()
    await expect(panelPicker).toHaveValue('')
    await expect(
      panelPicker.locator('option', { hasText: 'Waveshare PhotoPainter 7.3" (ESP32-S3 — buttons, SD card)' })
    ).toHaveCount(1)

    // The full compiled-in panel table is offered for bare-panel XIAO builds.
    await expect(panelPicker.locator('option', { hasText: 'Waveshare 7.5" (V2) 800x480 Black/White' })).toHaveCount(1)

    expectNoCloudFrontendErrors(readErrors)
  })

  test('ESP32 flasher: no hardware picker when the release lacks esp32-s3-generic', async ({ page }) => {
    const readErrors = attachFrontendErrorCollector(page)
    await page.setViewportSize({ width: 1440, height: 1400 })
    await prepareCloudPage(page, 'light')
    await serveCloudWorkspace(page, { firmware: firmwareListingWithoutGenericEsp32 })

    await page.goto(`${CLOUD_ORIGIN}/frames`, { waitUntil: 'domcontentloaded' })
    await expect(page.getByText('Kitchen frame').first()).toBeVisible()
    const drawer = await openAddFrameDrawer(page, 'esp32')

    // Older releases only ship the single-panel 7.5" V2 build; offering a
    // panel choice would brick the display init, so the picker stays hidden.
    await expect(drawer.getByText('Flash an ESP32 from this browser')).toBeVisible()
    await expect(drawer.getByLabel('Frame hardware')).toHaveCount(0)

    expectNoCloudFrontendErrors(readErrors)
  })
})
