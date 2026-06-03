import { expect, test } from '@playwright/test'
import { attachFrontendErrorCollector, login, prepareStablePage, settleForScreenshot } from './visual-helpers'
import { visualCases, visualThemes, visualViewports } from './visual-cases'

for (const visualCase of visualCases) {
  const themes = visualCase.themes ?? visualThemes
  const viewports = visualViewports.filter((viewport) => !visualCase.viewports || visualCase.viewports.includes(viewport.name))
  const variants = visualCase.variants ?? [{ id: 'default' }]

  for (const theme of themes) {
    for (const viewport of viewports) {
      for (const variant of variants) {
        const title = `${visualCase.title} / ${variant.id} / ${theme} / ${viewport.name}`

        test(title, async ({ page }) => {
          const readErrors = attachFrontendErrorCollector(page)
          await page.setViewportSize({ width: viewport.width, height: viewport.height })
          await prepareStablePage(page, theme)
          if (visualCase.authenticated !== false) {
            await login(page)
          }
          await page.goto(visualCase.path, { waitUntil: 'domcontentloaded' })
          await settleForScreenshot(page)
          await visualCase.ready?.(page)
          await variant.prepare?.(page)
          await settleForScreenshot(page)

          await expect(page).toHaveScreenshot(
            `${visualCase.id}--${variant.id}--${theme}--${viewport.name}.png`,
            {
              fullPage: variant.fullPage ?? visualCase.fullPage ?? false,
              maxDiffPixels: variant.maxDiffPixels ?? visualCase.maxDiffPixels,
              maxDiffPixelRatio: variant.maxDiffPixelRatio ?? visualCase.maxDiffPixelRatio,
            }
          )
          const errors = [...new Set(readErrors())]
          expect(errors, `Unexpected frontend errors:\n${errors.join('\n\n')}`).toEqual([])
        })
      }
    }
  }
}
