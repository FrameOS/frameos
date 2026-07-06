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
})
