/**
 * Records a Chrome DevTools performance trace while the viewport is panned under load,
 * and writes it where it can be dropped straight into the Performance panel.
 *
 *   npm run build && npm run preview
 *   GPU=1 node scripts/capturePerformanceTrace.mjs
 *
 * Headless Chromium rasterizes on the CPU, which is not representative of a real display;
 * pass GPU=1 to record in a GPU-backed window.
 */
import { createGzip } from 'node:zlib'
import { mkdir } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { Readable } from 'node:stream'
import { chromium } from '@playwright/test'

const presetName = process.argv[2] ?? 'Stress test document'
const outputPath = process.argv[3] ?? 'docs/performance/pan-trace.json'
const wheelDelta = Number(process.argv[4] ?? 2600)
const previewUrl = process.env.PREVIEW_URL ?? 'http://localhost:4173/'
const useGpu = process.env.GPU === '1'

/**
 * Timeline categories, without the CPU sampling profiler.
 *
 * The profiler is what makes a Performance recording enormous, and the evidence here is
 * about frame stability rather than which function was on the stack — so the trace stays
 * small enough to keep in the repository and still shows every frame, task, raster and
 * GPU event in the Performance panel.
 */
const TRACE_CATEGORIES = [
  '-*',
  'devtools.timeline',
  'disabled-by-default-devtools.timeline',
  'disabled-by-default-devtools.timeline.frame',
  'blink.user_timing',
  'latencyInfo',
  'toplevel',
].join(',')

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
await page.getByRole('button', { name: new RegExp(presetName) }).click()
await page.waitForFunction(
  () =>
    Number.parseInt(
      (document.querySelector('[data-testid="box-count"]')?.textContent ?? '0').replace(/\D/g, ''),
      10,
    ) > 0,
  null,
  { timeout: 30_000 },
)

const viewport = page.locator('[aria-label="Document layout canvas"]')
await viewport.hover({ position: { x: 520, y: 400 } })
await page.mouse.wheel(0, wheelDelta)
await page.waitForTimeout(2_000)

const devtools = await page.context().newCDPSession(page)
const traceChunks = []
devtools.on('Tracing.dataCollected', ({ value }) => traceChunks.push(...value))
const tracingComplete = new Promise((resolve) => devtools.once('Tracing.tracingComplete', resolve))

await devtools.send('Tracing.start', {
  categories: TRACE_CATEGORIES,
  options: 'sampling-frequency=10000',
  transferMode: 'ReportEvents',
})

// A continuous pan: one camera write and one render request per pointer event.
await page.mouse.move(700, 450)
await page.mouse.down()
for (let step = 0; step < 90; step += 1) {
  await page.mouse.move(700 + Math.sin(step / 9) * 300, 450 + Math.cos(step / 11) * 200)
  await page.waitForTimeout(10)
}

// Captured while the pan is still in progress: the statistics cover the last second, and
// releasing the pointer first would let the viewport go idle and report an idle frame
// rate instead of the one under load.
const statistics = (await viewport.innerText()).replace(/\n/g, ' ')
const viewportBox = await viewport.boundingBox()
await page.screenshot({
  path: outputPath.replace(/\.json$/, '-hud.png'),
  clip: { x: viewportBox.x, y: viewportBox.y, width: 300, height: 240 },
})
await page.mouse.up()

await devtools.send('Tracing.end')
await tracingComplete

console.log('viewport statistics during the pan:', statistics)

await mkdir(dirname(outputPath), { recursive: true })

// Gzipped: a raw timeline recording is several megabytes, and the Performance panel
// opens a `.json.gz` trace directly.
const gzippedPath = `${outputPath}.gz`
await pipeline(
  Readable.from([JSON.stringify({ traceEvents: traceChunks })]),
  createGzip({ level: 9 }),
  createWriteStream(gzippedPath),
)
console.log(`wrote ${gzippedPath} (${traceChunks.length} trace events)`)

await browser.close()
