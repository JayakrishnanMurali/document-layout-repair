import { expect, test, type Locator, type Page } from '@playwright/test'

const TREE_SCROLLER = '[aria-label="Document structure"]'
const CANVAS_CONTAINER = '[aria-label="Document layout canvas"]'
const ROW_HEIGHT_IN_PIXELS = 22

async function readTotalRowCount(page: Page): Promise<number> {
  return Number.parseInt(await page.getByTestId('tree-row-count').innerText(), 10)
}

function rowFor(page: Page, label: string): Locator {
  return page.getByRole('treeitem').filter({ hasText: label }).first()
}

async function readScrollTop(page: Page): Promise<number> {
  return page.locator(TREE_SCROLLER).evaluate((element) => element.scrollTop)
}

/** Rows are virtualized, so a row far down the list has to be scrolled into existence. */
async function revealRow(page: Page, label: string): Promise<void> {
  for (let scrollTop = 0; scrollTop <= 6000; scrollTop += 250) {
    await page
      .locator(TREE_SCROLLER)
      .evaluate((element, top) => element.scrollTo({ top }), scrollTop)
    await page.waitForTimeout(120)
    if ((await page.getByRole('treeitem').filter({ hasText: label }).count()) > 0) {
      return
    }
  }
  throw new Error(`Tree row not found: ${label}`)
}

test.describe('structure tree scrolling', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await page.getByRole('button', { name: /Stress test document/ }).click()
    await expect.poll(() => readTotalRowCount(page), { timeout: 30_000 }).toBeGreaterThan(100)
  })

  /**
   * The bug this guards: expanding any row re-ran scroll-into-view for the current
   * selection, yanking the reviewer back to a page they had deliberately scrolled away
   * from.
   */
  test('stays where the reviewer scrolled when an unrelated page is expanded', async ({
    page,
  }) => {
    await revealRow(page, 'Page 90')
    await rowFor(page, 'Page 90').click()

    const firstChildIndex = await page
      .getByRole('treeitem')
      .evaluateAll((elements) => elements.findIndex((el) => el.textContent?.includes('Page 90')) + 1)
    await page.getByRole('treeitem').nth(firstChildIndex).click()
    await expect(page.getByTestId('selection-count')).toBeVisible()

    await revealRow(page, 'Page 10 ')
    const scrollTopBeforeExpand = await readScrollTop(page)

    await rowFor(page, 'Page 10 ').click()
    await page.waitForTimeout(700)

    // Clicking a row that is clipped at the edge lets the browser bring it fully into
    // view, so allow a row's worth of movement — but nothing like a jump back to page 90.
    const scrollTopAfterExpand = await readScrollTop(page)
    expect(Math.abs(scrollTopAfterExpand - scrollTopBeforeExpand)).toBeLessThanOrEqual(
      ROW_HEIGHT_IN_PIXELS,
    )
  })

  /**
   * Revealing a selection expands its ancestors once, rather than deriving them every
   * render, so the reviewer can collapse that branch again afterwards.
   */
  test('lets a page holding the selection be collapsed again', async ({ page }) => {
    await revealRow(page, 'Page 90')
    await rowFor(page, 'Page 90').click()

    const firstChildIndex = await page
      .getByRole('treeitem')
      .evaluateAll((elements) => elements.findIndex((el) => el.textContent?.includes('Page 90')) + 1)
    await page.getByRole('treeitem').nth(firstChildIndex).click()
    await expect(page.getByTestId('selection-count')).toBeVisible()

    await revealRow(page, 'Page 90')
    const rowCountBeforeCollapse = await readTotalRowCount(page)
    await rowFor(page, 'Page 90').click()

    await expect.poll(() => readTotalRowCount(page)).toBeLessThan(rowCountBeforeCollapse)
  })

  test('scrolls a canvas selection into view', async ({ page }) => {
    await revealRow(page, 'Page 60')
    const scrollTopWhileBrowsing = await readScrollTop(page)
    expect(scrollTopWhileBrowsing).toBeGreaterThan(0)

    // Clicking on the canvas selects a box on the first page, far from where we scrolled.
    let hasSelection = false
    for (const offsetY of [240, 280, 320, 360, 400, 440, 480]) {
      await page.locator(CANVAS_CONTAINER).click({ position: { x: 520, y: offsetY } })
      try {
        await expect(page.getByTestId('selection-count')).toBeVisible({ timeout: 1_500 })
        hasSelection = true
        break
      } catch {
        continue
      }
    }
    expect(hasSelection).toBe(true)

    await expect.poll(() => readScrollTop(page), { timeout: 5_000 }).toBeLessThan(
      scrollTopWhileBrowsing,
    )
    await expect(page.getByRole('treeitem', { selected: true }).first()).toBeVisible()
  })
})
