import { expect, test, type Page } from '@playwright/test'

const CANVAS_CONTAINER = '[aria-label="Document layout canvas"]'

type CameraPose = { originX: number; originY: number; scale: number }

async function readCameraPose(page: Page): Promise<CameraPose> {
  const [originX, originY] = (await page.getByTestId('camera-origin').innerText())
    .split(',')
    .map((part) => Number.parseFloat(part))
  return {
    originX,
    originY,
    scale: Number.parseInt(await page.getByTestId('zoom-readout').innerText(), 10) / 100,
  }
}

async function readBoxCount(page: Page): Promise<number> {
  return Number.parseInt((await page.getByTestId('box-count').innerText()).replace(/\D/g, ''), 10)
}

/** Clicks around the first table until a cell is selected, then reports the grid. */
async function selectTableCell(page: Page): Promise<string> {
  const viewport = page.locator(CANVAS_CONTAINER)

  for (const [x, y] of [
    [400, 196],
    [400, 205],
    [350, 270],
    [450, 285],
    [500, 425],
    [600, 435],
    [380, 180],
  ]) {
    await viewport.click({ position: { x, y } })
    await page.waitForTimeout(150)
    if ((await page.getByTestId('table-mesh-address').count()) > 0) {
      const address = await page.getByTestId('table-mesh-address').innerText()
      if (address.includes('row')) {
        return address
      }
    }
  }

  throw new Error('No table cell could be selected')
}

test.describe('table mesh corrector', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect.poll(() => readBoxCount(page)).toBeGreaterThan(0)
    await page.getByRole('button', { name: 'Table mesh' }).click()
    await expect(page.getByTestId('table-mesh-tools')).toBeVisible()
  })

  test('splits a cell into columns and undoes it exactly', async ({ page }) => {
    const addressBefore = await selectTableCell(page)
    const boxCountBefore = await readBoxCount(page)
    const [, columnCountBefore] = addressBefore.match(/(\d+) × (\d+) grid/)!.slice(1, 3)

    await page.getByRole('button', { name: 'Split columns' }).click()

    await expect
      .poll(async () =>
        Number.parseInt(
          (await page.getByTestId('table-mesh-address').innerText()).match(/× (\d+) grid/)![1],
          10,
        ),
      )
      .toBe(Number.parseInt(columnCountBefore, 10) + 1)
    // Splitting a column adds one cell per row, so the document really did grow.
    expect(await readBoxCount(page)).toBeGreaterThan(boxCountBefore)
    await expect(page.getByTestId('undo-depth')).toHaveText(/history\s*1/)

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect.poll(() => page.getByTestId('table-mesh-address').innerText()).toBe(addressBefore)
    await expect.poll(() => readBoxCount(page)).toBe(boxCountBefore)
  })

  test('splits a cell into rows', async ({ page }) => {
    const addressBefore = await selectTableCell(page)
    const rowCountBefore = Number.parseInt(addressBefore.match(/(\d+) ×/)![1], 10)

    await page.getByRole('button', { name: 'Split rows' }).click()

    await expect
      .poll(async () =>
        Number.parseInt(
          (await page.getByTestId('table-mesh-address').innerText()).match(/(\d+) ×/)![1],
          10,
        ),
      )
      .toBe(rowCountBefore + 1)
  })

  test('merges a marquee of cells and unmerges them again', async ({ page }) => {
    await selectTableCell(page)
    const boxCountBefore = await readBoxCount(page)

    // Shift-drag across the first two columns of one row.
    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()
    await page.keyboard.down('Shift')
    await page.mouse.move(viewportBox!.x + 312, viewportBox!.y + 190)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + 700, viewportBox!.y + 232, { steps: 10 })
    await page.mouse.up()
    await page.keyboard.up('Shift')

    await expect(page.getByRole('button', { name: 'Merge cells' })).toBeEnabled()
    await page.getByRole('button', { name: 'Merge cells' }).click()

    // Merging hides the covered cells, so the live box count falls.
    await expect.poll(() => readBoxCount(page)).toBeLessThan(boxCountBefore)
    await expect(page.getByTestId('table-mesh-address')).toContainText(/spans [2-9]×|spans \d+×[2-9]/)

    await expect(page.getByRole('button', { name: 'Unmerge' })).toBeEnabled()
    await page.getByRole('button', { name: 'Unmerge' }).click()
    await expect.poll(() => readBoxCount(page)).toBe(boxCountBefore)
  })

  /**
   * The bug this guards: hiding a cell was never replayed to the worker, so its spatial
   * index kept answering hit-tests with cells the merge had swallowed — clicking a merged
   * cell selected an invisible fragment of it.
   */
  test('selects the merged cell, not a cell the merge swallowed', async ({ page }) => {
    await selectTableCell(page)

    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()
    await page.keyboard.down('Shift')
    await page.mouse.move(viewportBox!.x + 312, viewportBox!.y + 190)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + 700, viewportBox!.y + 232, { steps: 10 })
    await page.mouse.up()
    await page.keyboard.up('Shift')

    await expect(page.getByRole('button', { name: 'Merge cells' })).toBeEnabled()
    await page.getByRole('button', { name: 'Merge cells' }).click()
    await expect(page.getByTestId('table-mesh-address')).toContainText(/spans [2-9]×|spans \d+×[2-9]/)

    // Derive the merged cell's own rectangle, then click points inside it: every hit
    // must resolve to the merged cell rather than a fragment it swallowed.
    const camera = await readCameraPose(page)
    const [cellX, cellY] = (await page.getByTestId('selection-position').innerText())
      .split(',')
      .map((part) => Number.parseFloat(part))
    const [cellWidth, cellHeight] = (await page.getByTestId('selection-size').innerText())
      .split('×')
      .map((part) => Number.parseFloat(part))

    for (const [horizontalFraction, verticalFraction] of [
      [0.5, 0.5],
      [0.2, 0.5],
      [0.8, 0.5],
    ]) {
      await page.locator(CANVAS_CONTAINER).click({
        position: {
          x: (cellX + cellWidth * horizontalFraction - camera.originX) * camera.scale,
          y: (cellY + cellHeight * verticalFraction - camera.originY) * camera.scale,
        },
      })
      await expect
        .poll(() => page.getByTestId('table-mesh-address').innerText())
        .toMatch(/spans [2-9]×|spans \d+×[2-9]/)
    }
  })

  test('drags a column divider and recalculates the cells it bounds', async ({ page }) => {
    await selectTableCell(page)

    const camera = await readCameraPose(page)
    const [cellX, cellY] = (await page.getByTestId('selection-position').innerText())
      .split(',')
      .map((part) => Number.parseFloat(part))
    const [cellWidth, cellHeight] = (await page.getByTestId('selection-size').innerText())
      .split('×')
      .map((part) => Number.parseFloat(part))

    // The divider on the cell's right edge, at the cell's vertical middle.
    const dividerScreenX = (cellX + cellWidth - camera.originX) * camera.scale
    const dividerScreenY = (cellY + cellHeight / 2 - camera.originY) * camera.scale

    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()
    await page.mouse.move(viewportBox!.x + dividerScreenX, viewportBox!.y + dividerScreenY)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + dividerScreenX + 40, viewportBox!.y + dividerScreenY, {
      steps: 10,
    })
    await page.mouse.up()

    await expect(page.getByTestId('undo-depth')).toHaveText(/history\s*1/)
  })
})
