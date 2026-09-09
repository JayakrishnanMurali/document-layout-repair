/**
 * Captures the stream panel mid-ingestion, which is where the main-thread blocking
 * evidence lives: the worst worker event for the run, and the long-task count measured
 * with `PerformanceObserver` and windowed to the run.
 *
 *   npm run build && npm run preview
 *   GPU=1 node scripts/captureStreamEvidence.mjs docs/perf/03-sse-ingestion-long-tasks.png
 */
import { chromium } from '@playwright/test'

const outputPath = process.argv[2] ?? 'docs/perf/sse-ingestion.png'
const previewUrl = process.env.PREVIEW_URL ?? 'http://localhost:4173/'
const useGpu = process.env.GPU === '1'

const browser = await chromium.launch(
  useGpu
    ? {
        headless: false,
        args: ['--use-angle=metal', '--enable-gpu-rasterization', '--ignore-gpu-blocklist'],
      }
    : {},
)
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
page.on('pageerror', (error) => console.error('[pageerror]', error.message))

await page.goto(previewUrl)
await page.getByTestId('box-count').waitFor()
await page.getByRole('button', { name: /Live extraction/ }).click()
await page.getByTestId('stream-panel').waitFor()

// Two thirds of the way through, so the panel shows a run in progress rather than a
// finished one.
await page.waitForFunction(
  () => Number.parseInt(document.querySelector('[data-testid="stream-pages"]')?.textContent ?? '0', 10) > 26,
  null,
  { timeout: 40_000 },
)

const panel = page.getByTestId('stream-panel')
console.log((await panel.innerText()).replace(/\n/g, ' | '))
await panel.screenshot({ path: outputPath })
console.log(`wrote ${outputPath}`)

await browser.close()
