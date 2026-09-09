/**
 * Captures a screenshot of the running preview build, optionally after zooming.
 *
 *   node scripts/captureScreenshot.mjs out.png -1200
 */
import { chromium } from '@playwright/test'

const outputPath = process.argv[2] ?? 'screenshot.png'
const wheelDelta = Number(process.argv[3] ?? 0)
const previewUrl = process.env.PREVIEW_URL ?? 'http://localhost:4173/'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 2 })
page.on('pageerror', (error) => console.error('[pageerror]', error.message))

await page.goto(previewUrl)
await page.waitForTimeout(1200)

if (wheelDelta !== 0) {
  await page.locator('[aria-label="Document layout canvas"]').hover({ position: { x: 520, y: 300 } })
  await page.mouse.wheel(0, wheelDelta)
  await page.waitForTimeout(1500)
}

await page.screenshot({ path: outputPath })
console.log('wrote', outputPath)
await browser.close()
