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
    // Asserted over a substantial run rather than a finished one: the budget is about
    // per-event cost, and waiting for completion would make this fail for reasons that
    // have nothing to do with it.
    await expect.poll(() => readIngestedPageCount(page), { timeout: 30_000 }).toBeGreaterThan(20)

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

test.describe('stream interruption', () => {
  /**
   * EventSource reports the end of a stream as an error, so a connection that drops part
   * way through looks identical to one that finished. Reporting the difference is what
   * stops the workspace claiming to still be streaming a document that stopped arriving.
   */
  test('reports a connection that drops part way through', async ({ page }) => {
    // A well-formed stream that stops after one page instead of forty. Because a page did
    // arrive, restarting is not safe, so this must surface rather than silently fall back.
    await page.route('**/api/extraction-stream*', async (route) => {
      const truncatedStream = [
        { kind: 'documentStarted', pageCount: 40, documentSeed: 0x57ea, chunksPerPage: 1 },
        {
          kind: 'pageChunk',
          pageIndex: 0,
          chunkIndex: 0,
          chunkCount: 1,
          payload: {
            pageIndex: 0,
            pageSize: { width: 1240, height: 1754 },
            boxes: [
              {
                id: 'p0-b0',
                parentId: null,
                type: 'heading',
                bbox: [96, 96, 300, 30],
                confidence: 0.9,
                text: 'Truncated stream',
              },
            ],
            tables: [],
            readingOrder: ['p0-b0'],
          },
        },
      ]
      await route.fulfill({
        status: 200,
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' },
        body: truncatedStream.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(''),
      })
    })

    await page.goto('/')
    await expect.poll(() => readBoxCount(page)).toBeGreaterThan(0)
    await page.getByRole('button', { name: /Live extraction/ }).click()

    await expect(page.getByTestId('stream-status')).toContainText('failed', { timeout: 20_000 })
    await expect(page.getByTestId('stream-panel')).toContainText('Connection closed after 1 of 40')
    // The page that did arrive is still there, and still editable.
    expect(await readBoxCount(page)).toBeGreaterThan(0)
  })
})
