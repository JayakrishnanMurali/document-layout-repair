import { expect, test, type Locator, type Page } from '@playwright/test'

const CANVAS_CONTAINER = '[aria-label="Document layout canvas"]'

type WorldRect = { x: number; y: number; width: number; height: number }
type CameraPose = { originX: number; originY: number; scale: number }

async function readCameraPose(page: Page): Promise<CameraPose> {
  const [originX, originY] = (await page.getByTestId('camera-origin').innerText())
    .split(',')
    .map((part) => Number.parseFloat(part))
  const scale = Number.parseInt(await page.getByTestId('zoom-readout').innerText(), 10) / 100

  return { originX, originY, scale }
}

/** World bounds of the current selection, straight out of the inspector. */
async function readSelectedWorldRect(page: Page): Promise<WorldRect> {
  const [x, y] = (await page.getByTestId('selection-position').innerText())
    .split(',')
    .map((part) => Number.parseFloat(part))
  const [width, height] = (await page.getByTestId('selection-size').innerText())
    .split('×')
    .map((part) => Number.parseFloat(part))

  return { x, y, width, height }
}

function toScreenPoint(
  camera: CameraPose,
  worldX: number,
  worldY: number,
): { x: number; y: number } {
  return {
    x: (worldX - camera.originX) * camera.scale,
    y: (worldY - camera.originY) * camera.scale,
  }
}

function treeRowsForPageOne(page: Page): Locator {
  // Depth-one rows: the blocks of page 1, in reading order.
  return page.getByRole('treeitem').filter({ hasNotText: 'Page ' })
}

async function readBlockOrder(page: Page): Promise<string[]> {
  return treeRowsForPageOne(page).evaluateAll((elements) =>
    elements.map((element) => (element.textContent ?? '').replace(/[▶▼]/g, '').trim()),
  )
}

/** Selects a block through the tree and returns where its connector sits on screen. */
async function locateBlockOnScreen(
  page: Page,
  rowIndex: number,
): Promise<{ connector: { x: number; y: number }; center: { x: number; y: number } }> {
  await treeRowsForPageOne(page).nth(rowIndex).click()
  await expect(page.getByTestId('selection-position')).toBeVisible()

  const worldRect = await readSelectedWorldRect(page)
  const camera = await readCameraPose(page)

  return {
    connector: toScreenPoint(
      camera,
      worldRect.x + worldRect.width,
      worldRect.y + worldRect.height / 2,
    ),
    center: toScreenPoint(
      camera,
      worldRect.x + worldRect.width / 2,
      worldRect.y + worldRect.height / 2,
    ),
  }
}

test.describe('reading order graph', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('tree-row-count')).toBeVisible()
    await expect
      .poll(async () => (await readBlockOrder(page)).length)
      .toBeGreaterThan(4)
  })

  test('draws the graph only while the reading order tool is active', async ({ page }) => {
    const countGraphPixels = () =>
      page.evaluate((selector) => {
        // The reading-order layer is the third canvas: pages, boxes, graph, chrome.
        const canvas = document.querySelectorAll<HTMLCanvasElement>(`${selector} canvas`)[2]
        const context = canvas?.getContext('2d')
        if (!canvas || !context) {
          throw new Error('Reading order canvas is unavailable')
        }
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
        let paintedPixelCount = 0
        for (let pixelIndex = 3; pixelIndex < data.length; pixelIndex += 4 * 37) {
          if (data[pixelIndex] > 0) {
            paintedPixelCount += 1
          }
        }
        return paintedPixelCount
      }, CANVAS_CONTAINER)

    expect(await countGraphPixels()).toBe(0)

    await page.getByRole('button', { name: 'Reading order' }).click()
    await expect.poll(countGraphPixels).toBeGreaterThan(0)

    await page.getByRole('button', { name: 'Select & edit' }).click()
    await expect.poll(countGraphPixels).toBe(0)
  })

  test('re-links reading order by dragging a connector onto another block', async ({ page }) => {
    const orderBefore = await readBlockOrder(page)
    await page.getByRole('button', { name: 'Reading order' }).click()

    const source = await locateBlockOnScreen(page, 0)
    const target = await locateBlockOnScreen(page, 3)

    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()
    await page.mouse.move(viewportBox!.x + source.connector.x, viewportBox!.y + source.connector.y)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + target.center.x, viewportBox!.y + target.center.y, {
      steps: 12,
    })
    await page.mouse.up()

    // The dragged-onto block must now be read second, right after the connector's block.
    await expect.poll(async () => (await readBlockOrder(page))[1]).toBe(orderBefore[3])
    await expect(page.getByTestId('undo-depth')).toHaveText(/history\s*1/)

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => readBlockOrder(page)).toEqual(orderBefore)
  })

  test('ignores a link dropped on empty paper', async ({ page }) => {
    const orderBefore = await readBlockOrder(page)
    await page.getByRole('button', { name: 'Reading order' }).click()

    const source = await locateBlockOnScreen(page, 0)
    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()

    await page.mouse.move(viewportBox!.x + source.connector.x, viewportBox!.y + source.connector.y)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + 60, viewportBox!.y + 860, { steps: 8 })
    await page.mouse.up()

    expect(await readBlockOrder(page)).toEqual(orderBefore)
    await expect(page.getByTestId('undo-depth')).toHaveCount(0)
  })

  test('leaves box editing to the select tool', async ({ page }) => {
    await page.getByRole('button', { name: 'Reading order' }).click()
    const block = await locateBlockOnScreen(page, 0)
    const sizeBeforeDrag = await page.getByTestId('selection-size').innerText()

    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()
    await page.mouse.move(viewportBox!.x + block.center.x, viewportBox!.y + block.center.y)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + block.center.x + 80, viewportBox!.y + block.center.y, {
      steps: 8,
    })
    await page.mouse.up()

    // The drag panned the canvas instead of moving the box, so the box is untouched.
    expect(await page.getByTestId('selection-size').innerText()).toBe(sizeBeforeDrag)
    await expect(page.getByTestId('undo-depth')).toHaveCount(0)
  })
})
