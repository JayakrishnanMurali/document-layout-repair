/**
 * Repeats the load / edit / undo / redo cycle and reports the JavaScript heap after each
 * pass, to check that nothing accumulates.
 *
 * The cycle deliberately covers every subsystem that owns non-garbage-collected
 * resources: preset switches tear down the render engine, its GL buffers and the page
 * raster worker's ImageBitmap cache, while the edits exercise the transaction stack and
 * the worker's spatial index.
 *
 *   npm run build && npm run preview
 *   node scripts/measureMemoryStability.mjs [cycles]
 */
import { chromium } from '@playwright/test'

const cycleCount = Number(process.argv[2] ?? 8)
const previewUrl = process.env.PREVIEW_URL ?? 'http://localhost:4173/'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
page.on('pageerror', (error) => console.error('[pageerror]', error.message))

await page.goto(previewUrl)
await page.getByTestId('box-count').waitFor()

/**
 * `performance.memory` is quantized by Chrome, so it cannot show a slow leak. The
 * DevTools protocol reports the real used heap, and can force a collection first.
 */
const devtools = await page.context().newCDPSession(page)
await devtools.send('HeapProfiler.enable')

const readHeapMegabytes = async () => {
  await devtools.send('HeapProfiler.collectGarbage')
  await page.waitForTimeout(150)
  const { usedSize } = await devtools.send('Runtime.getHeapUsage')
  return usedSize / (1024 * 1024)
}

const waitForBoxes = async (minimumCount) => {
  await page.waitForFunction(
    (minimum) =>
      Number.parseInt(
        (document.querySelector('[data-testid="box-count"]')?.textContent ?? '0').replace(/\D/g, ''),
        10,
      ) > minimum,
    minimumCount,
    { timeout: 30_000 },
  )
}

let completedEditCount = 0

/** Selects a box on the canvas, re-labels it, then undoes and redoes the edit. */
const runEditCycle = async () => {
  const viewport = page.locator('[aria-label="Document layout canvas"]')
  for (const offsetY of [240, 300, 360, 420, 480]) {
    await viewport.click({ position: { x: 520, y: offsetY } })
    if (await page.getByTestId('selection-label').count()) {
      break
    }
  }
  if ((await page.getByRole('button', { name: 'figure', exact: true }).count()) === 0) {
    return
  }
  await page.getByRole('button', { name: 'figure', exact: true }).click()
  await page.keyboard.press('ControlOrMeta+z')
  await page.keyboard.press('ControlOrMeta+Shift+z')
  await page.keyboard.press('ControlOrMeta+z')
  completedEditCount += 1
}

console.log('cycle  heapMB  delta')
let baselineHeapMegabytes = Number.NaN
const heapSamples = []

for (let cycle = 1; cycle <= cycleCount; cycle += 1) {
  await page.getByRole('button', { name: /Stress test document/ }).click()
  await waitForBoxes(10_000)
  await page.locator('[aria-label="Document layout canvas"]').click({ position: { x: 8, y: 8 } })
  await page.keyboard.press('0')
  await page.waitForTimeout(400)

  await page.getByRole('button', { name: /Sample document/ }).click()
  await waitForBoxes(100)
  for (let edit = 0; edit < 5; edit += 1) {
    await runEditCycle()
  }

  const heapMegabytes = await readHeapMegabytes()
  heapSamples.push(heapMegabytes)
  if (cycle === 2) {
    // The first pass includes lazily created workers and warm caches.
    baselineHeapMegabytes = heapMegabytes
  }
  const delta = Number.isNaN(baselineHeapMegabytes) ? 0 : heapMegabytes - baselineHeapMegabytes
  console.log(
    `${String(cycle).padStart(5)}  ${heapMegabytes.toFixed(1).padStart(6)}  ${delta >= 0 ? '+' : ''}${delta.toFixed(1)}`,
  )
}

const settled = heapSamples.slice(1)
const growthPerCycle =
  (settled[settled.length - 1] - settled[0]) / Math.max(1, settled.length - 1)
console.log(
  `\n${completedEditCount} edit/undo/redo cycles completed\n` +
    `settled range ${Math.min(...settled).toFixed(1)}-${Math.max(...settled).toFixed(1)} MB, ` +
    `${growthPerCycle >= 0 ? '+' : ''}${growthPerCycle.toFixed(2)} MB per cycle`,
)

await browser.close()
