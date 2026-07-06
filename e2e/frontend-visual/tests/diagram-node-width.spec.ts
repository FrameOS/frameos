import { expect, test } from '@playwright/test'
import { addTemporaryWeatherNode, login } from './visual-helpers'

// App nodes must grow with their content: the weather app's rows (label +
// type tag + input) used to overflow the fixed 300px node width by ~30px.
test('app node inputs stay inside the node border', async ({ page }) => {
  await login(page)
  const restoreScenes = await addTemporaryWeatherNode(page, { nodeId: 'e2e-node-width-weather' })
  try {
    await page.goto('/scenes/1/scene-gradient', { waitUntil: 'domcontentloaded' })

    const node = page.locator('[data-id="e2e-node-width-weather"]')
    await node.waitFor({ state: 'visible' })
    await page.waitForTimeout(500)

    const overflow = await page.evaluate(() => {
      const nodeEl = document.querySelector('[data-id="e2e-node-width-weather"]') as HTMLElement
      const nodeRect = nodeEl.getBoundingClientRect()
      return Array.from(nodeEl.querySelectorAll('input, select, textarea')).map((input) => {
        const rect = (input as HTMLElement).getBoundingClientRect()
        return rect.right - nodeRect.right
      })
    })

    expect(overflow.length).toBeGreaterThan(0)
    for (const rightOverflow of overflow) {
      expect(rightOverflow).toBeLessThanOrEqual(0)
    }
  } finally {
    await restoreScenes()
  }
})
