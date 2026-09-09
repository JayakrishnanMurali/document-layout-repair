import { expect, test } from '@playwright/test'

const CANVAS_CONTAINER = '[aria-label="Document layout canvas"]'

function parseCount(text: string): number {
  return Number.parseInt(text.replace(/[^\d]/g, ''), 10)
}

test.describe('bounding box overlay', () => {
  test('draws the overlay through WebGL2', async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('overlay-renderer')).toHaveText('webgl2')
  })

  test('culls the stress document down to the visible boxes', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Stress test document/ }).click()

    await expect.poll(async () => parseCount(await page.getByTestId('box-count').innerText()), {
      timeout: 20_000,
    }).toBeGreaterThan(10_000)

    const totalBoxCount = parseCount(await page.getByTestId('box-count').innerText())
    await expect
      .poll(async () => parseCount(await page.getByTestId('drawn-box-count').innerText()), {
        timeout: 10_000,
      })
      .toBeGreaterThan(0)

    const drawnBoxCount = parseCount(await page.getByTestId('drawn-box-count').innerText())
    expect(drawnBoxCount).toBeLessThan(totalBoxCount)
  })

  test('submits every box when culling is switched off', async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Stress test document/ }).click()
    await expect.poll(async () => parseCount(await page.getByTestId('box-count').innerText()), {
      timeout: 20_000,
    }).toBeGreaterThan(10_000)

    const totalBoxCount = parseCount(await page.getByTestId('box-count').innerText())
    await page.getByRole('button', { name: 'Culling on' }).click()

    await expect
      .poll(async () => parseCount(await page.getByTestId('drawn-box-count').innerText()), {
        timeout: 10_000,
      })
      .toBe(totalBoxCount)
  })

  test('selects the most specific box under the pointer within the latency budget', async ({
    page,
  }) => {
    await page.goto('/')
    await expect.poll(async () => parseCount(await page.getByTestId('box-count').innerText()), {
      timeout: 20_000,
    }).toBeGreaterThan(0)

    const viewport = page.locator(CANVAS_CONTAINER)
    // Walk a short vertical line so the click lands on printed content, not a margin.
    for (const offsetY of [220, 260, 300, 340, 380, 420, 460, 500]) {
      await viewport.click({ position: { x: 520, y: offsetY } })
      if (await page.getByTestId('selection-label').count()) {
        break
      }
    }

    await expect(page.getByTestId('selection-label')).toBeVisible()
    const hitTestText = await page.getByTestId('hit-test-time').innerText()
    expect(Number.parseFloat(hitTestText.replace(/[^\d.]/g, ''))).toBeLessThan(2)
  })
})
