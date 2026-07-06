import { expect, test } from '@playwright/test'
import { addTemporaryWeatherNode, login } from './visual-helpers'

// Regression tests for the shared Tooltip popover (the "i" icons):
// - it must stay open after clicking the icon
// - it must anchor next to the icon, even after the diagram has been panned
test('output example tooltip stays open and follows the diagram', async ({ page }) => {
  await login(page)

  // Add a weather node to the gradient scene: its output declares an example,
  // which renders the "i" info button next to the output handle.
  const restoreScenes = await addTemporaryWeatherNode(page)
  try {
    await runTooltipChecks(page)
  } finally {
    await restoreScenes()
  }
})

async function runTooltipChecks(page: import('@playwright/test').Page): Promise<void> {
  await page.goto('/scenes/1/scene-gradient', { waitUntil: 'domcontentloaded' })

  const infoButton = page.locator('[aria-label="Example output"]').first()
  await infoButton.waitFor({ state: 'visible' })
  await infoButton.scrollIntoViewIfNeeded()

  const panel = page.locator('.frameos-tooltip-panel')

  // 1. The tooltip stays open after the opening click
  await infoButton.click()
  await expect(panel).toBeVisible()
  await page.waitForTimeout(700)
  await expect(panel).toBeVisible()

  // ...and is anchored near the button, fully inside the viewport
  const viewport = page.viewportSize()!
  const buttonBox1 = (await infoButton.boundingBox())!
  const panelBox1 = (await panel.boundingBox())!
  expect(panelBox1.x).toBeGreaterThanOrEqual(0)
  expect(panelBox1.y).toBeGreaterThanOrEqual(0)
  expect(panelBox1.x + panelBox1.width).toBeLessThanOrEqual(viewport.width + 1)
  expect(panelBox1.y + panelBox1.height).toBeLessThanOrEqual(viewport.height + 1)
  expect(horizontalDistance(panelBox1, buttonBox1)).toBeLessThan(250)

  await page.keyboard.press('Escape')
  await expect(panel).toBeHidden()

  // 2. Pan the diagram, reopen: the tooltip must follow the button's new position.
  // Pan to the right so the node stays clear of the fixed workspace sidebar.
  const pane = page.locator('.react-flow__pane')
  const paneBox = (await pane.boundingBox())!
  const startX = paneBox.x + 480
  const startY = paneBox.y + paneBox.height - 60
  await page.mouse.move(startX, startY)
  await page.mouse.down()
  await page.mouse.move(startX + 330, startY - 40, { steps: 8 })
  await page.mouse.up()

  const buttonBox2 = (await infoButton.boundingBox())!
  expect(Math.abs(buttonBox2.x - buttonBox1.x)).toBeGreaterThan(150) // the pan moved the node

  await infoButton.click()
  await expect(panel).toBeVisible()
  const panelBox2 = (await panel.boundingBox())!
  expect(horizontalDistance(panelBox2, buttonBox2)).toBeLessThan(250)
}

function horizontalDistance(panel: { x: number; width: number }, button: { x: number; width: number }): number {
  // bottom-end placement: the panel's right edge should sit near the button
  // (preventOverflow may shift it, so compare against the closest edge)
  const buttonCenter = button.x + button.width / 2
  if (buttonCenter < panel.x) {
    return panel.x - buttonCenter
  }
  if (buttonCenter > panel.x + panel.width) {
    return buttonCenter - (panel.x + panel.width)
  }
  return 0
}
