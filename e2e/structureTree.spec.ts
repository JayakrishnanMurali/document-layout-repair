import { expect, test, type Page } from '@playwright/test'

const CANVAS_CONTAINER = '[aria-label="Document layout canvas"]'

async function readTotalRowCount(page: Page): Promise<number> {
  return Number.parseInt(await page.getByTestId('tree-row-count').innerText(), 10)
}

async function selectFirstRowLabelled(page: Page, label: string): Promise<void> {
  await page.getByRole('treeitem').filter({ hasText: label }).first().click()
}

test.describe('structure tree', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('tree-row-count')).toBeVisible()
    await expect.poll(() => readTotalRowCount(page)).toBeGreaterThan(1)
  })

  test('lists pages and reveals a page’s blocks when expanded', async ({ page }) => {
    const rowCountBefore = await readTotalRowCount(page)
    await page.getByRole('treeitem').first().click()

    await expect.poll(() => readTotalRowCount(page)).toBeLessThan(rowCountBefore)

    await page.getByRole('treeitem').first().click()
    await expect.poll(() => readTotalRowCount(page)).toBe(rowCountBefore)
  })

  test('selecting a tree row selects the box on the canvas', async ({ page }) => {
    await selectFirstRowLabelled(page, 'title')

    await expect(page.getByTestId('selection-label')).toContainText('title')
    await expect(page.getByRole('treeitem', { selected: true }).first()).toContainText('title')
  })

  /** Canvas → tree: the row must be revealed and highlighted, even inside a collapsed branch. */
  test('selecting a box on the canvas highlights its row in the tree', async ({ page }) => {
    const viewport = page.locator(CANVAS_CONTAINER)

    for (const offsetY of [240, 280, 320, 360, 400, 440, 480]) {
      await viewport.click({ position: { x: 520, y: offsetY } })
      try {
        await expect(page.getByTestId('selection-label')).toBeVisible({ timeout: 1_500 })
        break
      } catch {
        continue
      }
    }

    const selectedLabel = await page.getByTestId('selection-label').innerText()
    const selectedClassName = selectedLabel.split(' · ')[0]

    const selectedRow = page.getByRole('treeitem', { selected: true }).first()
    await expect(selectedRow).toBeVisible()
    await expect(selectedRow).toContainText(selectedClassName)
  })

  test('mounts only a window of rows for a hundred-page document', async ({ page }) => {
    await page.getByRole('button', { name: /Stress test document/ }).click()
    await expect.poll(() => readTotalRowCount(page), { timeout: 25_000 }).toBeGreaterThan(100)

    const totalRowCount = await readTotalRowCount(page)
    const mountedRowCount = await page.getByRole('treeitem').count()

    expect(mountedRowCount).toBeLessThan(totalRowCount)
    expect(mountedRowCount).toBeGreaterThan(0)
  })

  test('hovering a tree row paints a highlight on the canvas', async ({ page }) => {
    // The interaction layer is the topmost canvas and is otherwise transparent, so its
    // painted-pixel count is a direct read on whether the hover reached the canvas.
    const countPaintedPixels = () =>
      page.evaluate((selector) => {
        const canvases = document.querySelectorAll<HTMLCanvasElement>(`${selector} canvas`)
        const canvas = canvases[canvases.length - 1]
        const context = canvas?.getContext('2d')
        if (!canvas || !context) {
          throw new Error('Interaction canvas is unavailable')
        }
        const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
        let paintedPixelCount = 0
        for (let pixelIndex = 3; pixelIndex < data.length; pixelIndex += 4 * 41) {
          if (data[pixelIndex] > 0) {
            paintedPixelCount += 1
          }
        }
        return paintedPixelCount
      }, CANVAS_CONTAINER)

    expect(await countPaintedPixels()).toBe(0)

    await page.getByRole('treeitem').filter({ hasText: 'title' }).first().hover()
    await expect.poll(countPaintedPixels).toBeGreaterThan(0)

    await page.locator('[aria-label="Document structure"]').hover({ position: { x: 5, y: 5 } })
    await page.mouse.move(10, 10)
    await expect.poll(countPaintedPixels).toBe(0)
  })

  test('double-clicking a row eases the camera onto that box', async ({ page }) => {
    const zoomBefore = Number.parseInt(await page.getByTestId('zoom-readout').innerText(), 10)
    await page.getByRole('treeitem').filter({ hasText: 'title' }).first().dblclick()

    await expect
      .poll(async () => Number.parseInt(await page.getByTestId('zoom-readout').innerText(), 10), {
        timeout: 5_000,
      })
      .not.toBe(zoomBefore)
  })
})

test.describe('JSON and Markdown panes', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect(page.getByTestId('tree-row-count')).toBeVisible()
    await expect.poll(() => readTotalRowCount(page)).toBeGreaterThan(1)
  })

  test('serializes the selected box as the payload it will export', async ({ page }) => {
    await selectFirstRowLabelled(page, 'title')
    await page.getByRole('button', { name: 'JSON', exact: true }).click()

    const json = await page.getByTestId('inspector-json').innerText()
    const parsed = JSON.parse(json) as { class: string; page: number; bounds: { x: number } }

    expect(parsed.class).toBe('title')
    expect(parsed.page).toBe(1)
    // Page-local coordinates: a title sits at the page margin, not out in world space.
    expect(parsed.bounds.x).toBeLessThan(200)
  })

  test('renders a selected table as a Markdown table', async ({ page }) => {
    await selectFirstRowLabelled(page, 'table')
    await page.getByRole('button', { name: 'Markdown', exact: true }).click()

    const markdown = await page.getByTestId('inspector-markdown').innerText()
    expect(markdown).toContain('|')
    expect(markdown).toContain('---')
  })

  test('falls back to the whole page when nothing is selected', async ({ page }) => {
    await page.getByRole('button', { name: 'Markdown', exact: true }).click()

    const markdown = await page.getByTestId('inspector-markdown').innerText()
    expect(markdown).toContain('# ')
    expect(markdown.length).toBeGreaterThan(200)
  })
})
