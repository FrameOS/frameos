import { expect, test } from '@playwright/test'
import { login } from './visual-helpers'

// Shrinking a desktop window into the mobile layout must not pop open the
// sidebar overlay: on desktop the sidebar state is "open" by default, but the
// mobile overlay should start closed.
test('sidebar closes when the viewport shrinks from desktop to mobile', async ({ page }) => {
  await login(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.goto('/', { waitUntil: 'domcontentloaded' })

  const sidebar = page.locator('.workspace-sidebar-collapsed')
  await expect(sidebar).toHaveCount(0) // desktop: sidebar expanded

  await page.setViewportSize({ width: 500, height: 900 })
  await expect(page.locator('.workspace-sidebar-collapsed')).toHaveCount(1) // mobile: overlay closed

  // growing back to desktop must not animate the sidebar's size (it used to
  // fly in from the right as its width transitioned from 100vw)
  await page.setViewportSize({ width: 1440, height: 900 })
  const transition = await page.evaluate(() => {
    const sidebar = document.querySelector('.workspace-sidebar, .workspace-sidebar-collapsed')!
    const style = getComputedStyle(sidebar)
    return { property: style.transitionProperty, duration: style.transitionDuration }
  })
  const animatesSize =
    /width|height|all/.test(transition.property) && transition.duration.split(',').some((d) => parseFloat(d) > 0)
  expect(animatesSize, `sidebar transition: ${JSON.stringify(transition)}`).toBe(false)
})
