import { expect, test, type Page } from '@playwright/test'

const CANVAS_CONTAINER = '[aria-label="Document layout canvas"]'
const PAGE_RASTER_CANVAS = `${CANVAS_CONTAINER} canvas:first-of-type`

/**
 * Coarse checksum of the page-raster layer. Panning shifts the document under the
 * viewport, so this changes if and only if the camera moved.
 */
async function readPageRasterSignature(page: Page): Promise<number> {
  return page.evaluate((selector) => {
    const canvas = document.querySelector<HTMLCanvasElement>(selector)
    const context = canvas?.getContext('2d')
    if (!canvas || !context) {
      throw new Error('Page raster canvas is unavailable')
    }

    const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
    let signature = 0
    // Sample a sparse grid: enough to detect a shift, cheap enough to run repeatedly.
    for (let pixelIndex = 0; pixelIndex < data.length; pixelIndex += 4 * 997) {
      signature = (signature * 31 + data[pixelIndex] + data[pixelIndex + 1] * 3) % 2147483647
    }
    return signature
  }, PAGE_RASTER_CANVAS)
}

/**
 * Page tiles stream in from a worker, so the canvas can still be changing for reasons
 * that have nothing to do with the camera. Wait until two consecutive reads agree.
 */
async function waitForStablePageRaster(page: Page): Promise<number> {
  let previousSignature = await readPageRasterSignature(page)

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await page.waitForTimeout(150)
    const signature = await readPageRasterSignature(page)
    if (signature === previousSignature) {
      return signature
    }
    previousSignature = signature
  }

  throw new Error('Page raster never settled')
}

test.describe('viewport navigation', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect
      .poll(async () =>
        Number.parseInt((await page.getByTestId('box-count').innerText()).replace(/\D/g, ''), 10),
      )
      .toBeGreaterThan(0)
  })

  test('pans the document while the pointer is held', async ({ page }) => {
    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()
    const signatureBeforePan = await waitForStablePageRaster(page)

    await page.mouse.move(viewportBox!.x + 200, viewportBox!.y + 600)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + 200, viewportBox!.y + 380, { steps: 8 })
    await page.mouse.up()

    await expect.poll(() => readPageRasterSignature(page)).not.toBe(signatureBeforePan)
  })

  /**
   * The bug this guards: a button released outside the window never reaches the canvas,
   * which used to leave the pan latched to the pointer.
   */
  test('stops panning when the button is released where the canvas cannot see it', async ({
    page,
  }) => {
    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()

    await page.mouse.move(viewportBox!.x + 200, viewportBox!.y + 600)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + 200, viewportBox!.y + 420, { steps: 6 })

    // Simulate the release happening off-window: the next move simply reports no
    // buttons held, with no pointerup ever delivered.
    await page.evaluate((selector) => {
      const container = document.querySelector<HTMLElement>(selector)
      container?.dispatchEvent(
        new PointerEvent('pointermove', {
          bubbles: true,
          pointerId: 1,
          buttons: 0,
          clientX: 400,
          clientY: 500,
        }),
      )
    }, CANVAS_CONTAINER)

    const signatureAfterPhantomRelease = await waitForStablePageRaster(page)

    await page.mouse.move(viewportBox!.x + 900, viewportBox!.y + 120, { steps: 10 })
    await page.mouse.move(viewportBox!.x + 300, viewportBox!.y + 780, { steps: 10 })
    await page.waitForTimeout(300)

    expect(await readPageRasterSignature(page)).toBe(signatureAfterPhantomRelease)
  })

  test('keeps the world point under the cursor fixed while zooming', async ({ page }) => {
    const viewport = page.locator(CANVAS_CONTAINER)
    await viewport.hover({ position: { x: 700, y: 400 } })

    const zoomBefore = Number.parseInt(await page.getByTestId('zoom-readout').innerText(), 10)
    await page.mouse.wheel(0, -900)
    await expect
      .poll(async () => Number.parseInt(await page.getByTestId('zoom-readout').innerText(), 10))
      .toBeGreaterThan(zoomBefore)

    await page.mouse.wheel(0, 900)
    await expect
      .poll(async () => Number.parseInt(await page.getByTestId('zoom-readout').innerText(), 10))
      .toBe(zoomBefore)
  })
})
