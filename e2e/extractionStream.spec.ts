import { expect, test, type Page } from '@playwright/test'

async function readBoxCount(page: Page): Promise<number> {
  return Number.parseInt((await page.getByTestId('box-count').innerText()).replace(/\D/g, ''), 10)
}

async function readIngestedPageCount(page: Page): Promise<number> {
  return Number.parseInt(await page.getByTestId('stream-pages').innerText(), 10)
}

test.describe('live extraction stream', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/')
    await expect.poll(() => readBoxCount(page)).toBeGreaterThan(0)
    await page.getByRole('button', { name: /Live extraction/ }).click()
    await expect(page.getByTestId('stream-panel')).toBeVisible()
  })

  test('fills the workspace from the mock server-sent event stream', async ({ page }) => {
    await expect(page.getByTestId('stream-status')).toContainText('sse')

    // Boxes must appear while the stream is still running, not only at the end.
    await expect.poll(() => readIngestedPageCount(page), { timeout: 20_000 }).toBeGreaterThan(3)
    const partialBoxCount = await readBoxCount(page)
    expect(partialBoxCount).toBeGreaterThan(0)

    await expect
      .poll(() => page.getByTestId('stream-status').innerText(), { timeout: 40_000 })
      .toContain('completed')

    expect(await readIngestedPageCount(page)).toBe(40)
    expect(await readBoxCount(page)).toBeGreaterThan(partialBoxCount)
  })

  test('keeps every event inside the worker’s frame budget', async ({ page }) => {
    await expect
      .poll(() => page.getByTestId('stream-status').innerText(), { timeout: 40_000 })
      .toContain('completed')

    const worstEventText = await page.getByTestId('stream-worst-event').innerText()
    expect(Number.parseFloat(worstEventText)).toBeLessThan(16)
  })

  test('logs arrivals out of order, interleaved across pages', async ({ page }) => {
    await expect.poll(() => readIngestedPageCount(page), { timeout: 20_000 }).toBeGreaterThan(8)

    const loggedPages = await page
      .getByTestId('stream-log')
      .locator('> div')
      .evaluateAll((rows) =>
        rows.map((row) => Number.parseInt(row.textContent?.replace(/^p/, '') ?? '0', 10)),
      )

    expect(loggedPages.length).toBeGreaterThan(5)
    // Newest first, so a purely sequential stream would be strictly descending.
    const isStrictlyOrdered = loggedPages.every(
      (pageNumber, index) => index === 0 || pageNumber <= loggedPages[index - 1],
    )
    expect(isStrictlyOrdered).toBe(false)
  })

  test('can be disconnected mid-stream and reconnected', async ({ page }) => {
    await expect.poll(() => readIngestedPageCount(page), { timeout: 20_000 }).toBeGreaterThan(2)

    await page.getByRole('button', { name: 'disconnect' }).click()
    await expect(page.getByTestId('stream-status')).toContainText('completed')

    const pageCountAtDisconnect = await readIngestedPageCount(page)
    await page.waitForTimeout(1_200)
    // Nothing more arrives once the connection is closed.
    expect(await readIngestedPageCount(page)).toBe(pageCountAtDisconnect)

    await page.getByRole('button', { name: 'reconnect' }).click()
    await expect(page.getByTestId('stream-status')).toContainText('streaming')
  })

  test('survives editing while pages are still arriving', async ({ page }) => {
    await expect.poll(() => readIngestedPageCount(page), { timeout: 20_000 }).toBeGreaterThan(2)

    const viewport = page.locator('[aria-label="Document layout canvas"]')
    let hasSelection = false
    for (const offsetY of [240, 280, 320, 360, 400, 440, 480]) {
      await viewport.click({ position: { x: 520, y: offsetY } })
      try {
        await expect(page.getByTestId('selection-label')).toBeVisible({ timeout: 1_500 })
        hasSelection = true
        break
      } catch {
        continue
      }
    }
    expect(hasSelection).toBe(true)

    await page.getByRole('button', { name: 'figure', exact: true }).click()
    await expect(page.getByTestId('undo-depth')).toHaveText(/history\s*1/)

    // The stream keeps appending, and the edit is still undoable afterwards.
    await expect
      .poll(() => page.getByTestId('stream-status').innerText(), { timeout: 40_000 })
      .toContain('completed')
    await expect(page.getByTestId('undo-depth')).toHaveText(/history\s*1/)
    await page.getByRole('button', { name: 'Undo' }).click()
    await expect(page.getByTestId('undo-depth')).toHaveCount(0)
  })
})

test.describe('stream fallback', () => {
  /**
   * A static deployment has no endpoint behind it, so the same event sequence has to be
   * generated inside the worker instead — without the workspace behaving differently.
   */
  test('generates the stream in the worker when the endpoint is unreachable', async ({ page }) => {
    await page.route('**/api/extraction-stream*', (route) => route.abort())

    await page.goto('/')
    await expect.poll(() => readBoxCount(page)).toBeGreaterThan(0)
    await page.getByRole('button', { name: /Live extraction/ }).click()

    await expect(page.getByTestId('stream-panel')).toBeVisible()
    await expect(page.getByTestId('stream-status')).toContainText('simulated', { timeout: 15_000 })

    await expect.poll(() => readIngestedPageCount(page), { timeout: 30_000 }).toBeGreaterThan(5)
    await expect
      .poll(() => page.getByTestId('stream-status').innerText(), { timeout: 40_000 })
      .toContain('completed')
    expect(await readIngestedPageCount(page)).toBe(40)
  })
})
