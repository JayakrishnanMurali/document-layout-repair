import { expect, test } from '@playwright/test'

const CANVAS_SELECTOR = '[aria-label="Document layout canvas"] canvas'

/** Average luminance of the layer's backing store, read straight out of the canvas. */
async function readCanvasLuminance(page: import('@playwright/test').Page): Promise<number> {
  return page.evaluate((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector)
    if (!canvas) {
      throw new Error('Canvas not found')
    }
    const context = canvas.getContext('2d')
    if (!context) {
      throw new Error('Canvas has no 2D context')
    }
    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let total = 0
    for (let pixelIndex = 0; pixelIndex < data.length; pixelIndex += 4) {
      total += (data[pixelIndex] + data[pixelIndex + 1] + data[pixelIndex + 2]) / 3
    }
    return total / (data.length / 4)
  }, CANVAS_SELECTOR)
}

test.describe('viewport rendering', () => {
  test('sizes the backing store for the device pixel ratio', async ({ page }) => {
    await page.goto('/')
    const canvas = page.locator(CANVAS_SELECTOR).first()
    await expect(canvas).toBeAttached()

    const sizing = await canvas.evaluate((element: HTMLCanvasElement) => ({
      backingWidth: element.width,
      backingHeight: element.height,
      cssWidth: element.getBoundingClientRect().width,
      cssHeight: element.getBoundingClientRect().height,
      devicePixelRatio: window.devicePixelRatio,
    }))

    expect(sizing.devicePixelRatio).toBe(2)
    expect(sizing.backingWidth).toBe(Math.round(sizing.cssWidth * sizing.devicePixelRatio))
    expect(sizing.backingHeight).toBe(Math.round(sizing.cssHeight * sizing.devicePixelRatio))
  })

  test('rasterizes pages from the worker and composites them', async ({ page }) => {
    await page.goto('/')
    await expect
      .poll(() => readCanvasLuminance(page), { timeout: 10_000 })
      .toBeGreaterThan(40)
  })

  test('zooms toward the cursor on wheel input', async ({ page }) => {
    await page.goto('/')
    const viewport = page.locator('[aria-label="Document layout canvas"]')
    const zoomReadoutLocator = page.getByTestId('zoom-readout')
    await expect(zoomReadoutLocator).toBeVisible()

    const zoomReadout = () => zoomReadoutLocator.innerText()
    const initialZoom = await zoomReadout()

    await viewport.hover({ position: { x: 700, y: 400 } })
    await page.mouse.wheel(0, -600)

    await expect.poll(zoomReadout, { timeout: 5_000 }).not.toBe(initialZoom)
    expect(Number.parseInt(await zoomReadout(), 10)).toBeGreaterThan(
      Number.parseInt(initialZoom, 10),
    )
  })
})
