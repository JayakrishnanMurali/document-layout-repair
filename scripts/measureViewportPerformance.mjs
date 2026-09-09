/**
 * Drives a continuous pan over the loaded document and reports the in-app frame
 * statistics before, during and after the gesture.
 *
 * Run against a production build:
 *   npm run build && npm run preview
 *   node scripts/measureViewportPerformance.mjs
 *
 * Headless Chromium falls back to software rasterization, which is not representative
 * of a real display. Pass GPU=1 to launch a GPU-backed window instead:
 *   GPU=1 node scripts/measureViewportPerformance.mjs "Stress test document"
 */
import { chromium } from '@playwright/test'

const presetName = process.argv[2] ?? 'Stress test document'
const wheelDelta = Number(process.argv[3] ?? -1200)
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
await page.getByRole('button', { name: new RegExp(presetName) }).click()
await page.waitForTimeout(600)

if (process.env.CULLING === 'off') {
  await page.getByRole('button', { name: /Culling on/ }).click()
}

const viewport = page.locator('[aria-label="Document layout canvas"]')
await viewport.hover({ position: { x: 520, y: 400 } })
if (wheelDelta !== 0) {
  await page.mouse.wheel(0, wheelDelta)
}
await page.waitForTimeout(1500)

const readStatistics = async () => (await viewport.innerText()).replace(/\n/g, ' ')
console.log('before pan :', await readStatistics())

await page.mouse.move(700, 450)
await page.mouse.down()
for (let step = 0; step < 100; step += 1) {
  await page.mouse.move(700 + Math.sin(step / 7) * 260, 450 + step * 2.2)
  await page.waitForTimeout(8)
}
console.log('during pan :', await readStatistics())

await page.mouse.up()
await browser.close()
