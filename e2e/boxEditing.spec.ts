import { expect, test, type Page } from '@playwright/test'

const CANVAS_CONTAINER = '[aria-label="Document layout canvas"]'

/** Clicks down a column until a box is selected, then reports where it landed. */
async function selectAnyBox(page: Page): Promise<{ x: number; y: number }> {
  const viewport = page.locator(CANVAS_CONTAINER)

  for (const offsetY of [240, 280, 320, 360, 400, 440, 480, 520, 560]) {
    const position = { x: 520, y: offsetY }
    await viewport.click({ position })
    // Selection resolves through a worker round trip, so give each click a moment.
    try {
      await expect(page.getByTestId('selection-position')).toBeVisible({ timeout: 1_500 })
      return position
    } catch {
      continue
    }
  }

  throw new Error('No box could be selected')
}

/** The class chip currently marked active in the inspector. */
async function readActiveClassName(page: Page): Promise<string> {
  return (await page.locator('[aria-pressed="true"]').last().innerText()).trim()
}

test.describe('bounding box editing', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('box-count')).toBeVisible()
    await expect
      .poll(async () => Number.parseInt((await page.getByTestId('box-count').innerText()).replace(/\D/g, ''), 10))
      .toBeGreaterThan(0)
  })

  test('edits a box by dragging it and restores it exactly with undo', async ({ page }) => {
    const pressPosition = await selectAnyBox(page)
    const positionBeforeDrag = await page.getByTestId('selection-position').innerText()
    const sizeBeforeDrag = await page.getByTestId('selection-size').innerText()

    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()
    expect(viewportBox).not.toBeNull()

    await page.mouse.move(viewportBox!.x + pressPosition.x, viewportBox!.y + pressPosition.y)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + pressPosition.x + 60, viewportBox!.y + pressPosition.y + 45, {
      steps: 12,
    })
    await page.mouse.up()

    // Depending on where the press landed the drag is a move or a handle resize; either
    // way the box must change and one transaction must be recorded.
    await expect
      .poll(async () => {
        const position = await page.getByTestId('selection-position').innerText()
        const size = await page.getByTestId('selection-size').innerText()
        return position !== positionBeforeDrag || size !== sizeBeforeDrag
      })
      .toBe(true)
    await expect(page.getByTestId('undo-depth')).toHaveText(/history\s*1/)

    await page.getByRole('button', { name: 'Undo' }).click()
    await expect
      .poll(async () => page.getByTestId('selection-position').innerText())
      .toBe(positionBeforeDrag)
    expect(await page.getByTestId('selection-size').innerText()).toBe(sizeBeforeDrag)
  })

  test('moves a small box instead of resizing it, since it has no room for handles', async ({
    page,
  }) => {
    // Fit the whole document: every box is now a few pixels tall, so handles are off.
    await page.locator(CANVAS_CONTAINER).click({ position: { x: 8, y: 8 } })
    await page.keyboard.press('0')
    await page.waitForTimeout(300)

    const pressPosition = await selectAnyBox(page)
    const sizeBeforeDrag = await page.getByTestId('selection-size').innerText()
    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()

    await page.mouse.move(viewportBox!.x + pressPosition.x, viewportBox!.y + pressPosition.y)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + pressPosition.x + 70, viewportBox!.y + pressPosition.y, {
      steps: 10,
    })
    await page.mouse.up()

    await expect(page.getByTestId('undo-depth')).toHaveText(/history\s*1/)
    // A move preserves the size; a stray handle grab would not.
    expect(await page.getByTestId('selection-size').innerText()).toBe(sizeBeforeDrag)
  })

  test('coalesces a whole drag into one undo step', async ({ page }) => {
    const pressPosition = await selectAnyBox(page)
    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()

    await page.mouse.move(viewportBox!.x + pressPosition.x, viewportBox!.y + pressPosition.y)
    await page.mouse.down()
    for (let step = 1; step <= 25; step += 1) {
      await page.mouse.move(
        viewportBox!.x + pressPosition.x + step * 3,
        viewportBox!.y + pressPosition.y + step * 2,
      )
    }
    await page.mouse.up()

    await expect(page.getByTestId('undo-depth')).toHaveText(/history\s*1/)
  })

  test('re-labels a box through the class picker and undoes it', async ({ page }) => {
    await selectAnyBox(page)
    const originalClassName = await readActiveClassName(page)
    const targetClassName = originalClassName === 'figure' ? 'caption' : 'figure'

    await page.getByRole('button', { name: targetClassName, exact: true }).click()
    await expect.poll(() => readActiveClassName(page)).toBe(targetClassName)

    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => readActiveClassName(page)).toBe(originalClassName)
  })

  test('redoes an undone edit', async ({ page }) => {
    await selectAnyBox(page)
    const originalClassName = await readActiveClassName(page)
    const targetClassName = originalClassName === 'figure' ? 'caption' : 'figure'

    await page.getByRole('button', { name: targetClassName, exact: true }).click()
    await expect.poll(() => readActiveClassName(page)).toBe(targetClassName)

    await page.keyboard.press('ControlOrMeta+z')
    await expect.poll(() => readActiveClassName(page)).toBe(originalClassName)

    await page.keyboard.press('ControlOrMeta+Shift+z')
    await expect.poll(() => readActiveClassName(page)).toBe(targetClassName)
  })

  test('marquee-selects several boxes with shift-drag', async ({ page }) => {
    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()

    await page.keyboard.down('Shift')
    await page.mouse.move(viewportBox!.x + 380, viewportBox!.y + 240)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + 700, viewportBox!.y + 560, { steps: 10 })
    await page.mouse.up()
    await page.keyboard.up('Shift')

    await expect(page.getByTestId('selection-label')).toContainText('more')
  })
})

test.describe('marquee selection', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect
      .poll(async () =>
        Number.parseInt((await page.getByTestId('box-count').innerText()).replace(/\D/g, ''), 10),
      )
      .toBeGreaterThan(0)
  })

  async function sweep(
    page: Page,
    from: { x: number; y: number },
    to: { x: number; y: number },
    isAdditive = false,
  ): Promise<void> {
    const viewportBox = await page.locator(CANVAS_CONTAINER).boundingBox()
    await page.keyboard.down('Shift')
    if (isAdditive) {
      await page.keyboard.down('ControlOrMeta')
    }
    await page.mouse.move(viewportBox!.x + from.x, viewportBox!.y + from.y)
    await page.mouse.down()
    await page.mouse.move(viewportBox!.x + to.x, viewportBox!.y + to.y, { steps: 10 })
    await page.mouse.up()
    if (isAdditive) {
      await page.keyboard.up('ControlOrMeta')
    }
    await page.keyboard.up('Shift')
  }

  async function readSelectionCount(page: Page): Promise<number> {
    if ((await page.getByTestId('selection-count').count()) === 0) {
      return 0
    }
    const text = await page.getByTestId('selection-count').innerText()
    return text.includes('boxes') ? Number.parseInt(text, 10) : 1
  }

  test('replaces the previous selection on a fresh sweep', async ({ page }) => {
    await sweep(page, { x: 380, y: 240 }, { x: 700, y: 520 })
    await expect.poll(() => readSelectionCount(page)).toBeGreaterThan(1)

    // An empty region must clear the selection, not leave the old one behind.
    await sweep(page, { x: 120, y: 700 }, { x: 200, y: 780 })
    await expect.poll(() => readSelectionCount(page)).toBe(0)
  })

  test('adds to the selection when Cmd/Ctrl is held as well', async ({ page }) => {
    await sweep(page, { x: 380, y: 240 }, { x: 700, y: 400 })
    const firstSweepCount = await readSelectionCount(page)
    expect(firstSweepCount).toBeGreaterThan(0)

    await sweep(page, { x: 380, y: 420 }, { x: 700, y: 560 }, true)
    await expect.poll(() => readSelectionCount(page)).toBeGreaterThan(firstSweepCount)
  })

  test('lists every selected box, not only the primary one', async ({ page }) => {
    await sweep(page, { x: 380, y: 240 }, { x: 700, y: 520 })

    const selectionCount = await readSelectionCount(page)
    expect(selectionCount).toBeGreaterThan(1)
    await expect(page.getByRole('listitem')).toHaveCount(Math.min(selectionCount, 60))
  })
})
