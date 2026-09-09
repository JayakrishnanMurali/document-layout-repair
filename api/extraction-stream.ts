import { createStreamEventSequence } from '../src/document/extraction/streamEventSource.js'

/**
 * The mock extraction stream, as an edge function.
 *
 * Edge rather than Node because Vercel bundles an edge function together with its
 * imports, which lets this share the event source with the Vite middleware that serves
 * the same endpoint locally — one definition of the sequence rather than two that can
 * drift. It also streams natively through a `ReadableStream`.
 *
 * The workspace still carries an in-worker fallback generator, for hosts with no function
 * runtime at all.
 */
export const config = { runtime: 'edge' }

const DEFAULT_PAGE_COUNT = 40
const DEFAULT_CHUNKS_PER_PAGE = 3
const DEFAULT_EVENT_INTERVAL_MILLISECONDS = 40
const MAXIMUM_PAGE_COUNT = 200

export default function handler(request: Request): Response {
  const parameters = new URL(request.url).searchParams
  const pageCount = clampInteger(parameters.get('pages'), DEFAULT_PAGE_COUNT, 1, MAXIMUM_PAGE_COUNT)
  const documentSeed = clampInteger(parameters.get('seed'), 0x57ea, 0, 0xffffff)
  const chunksPerPage = clampInteger(parameters.get('chunks'), DEFAULT_CHUNKS_PER_PAGE, 1, 12)
  const intervalMilliseconds = clampInteger(
    parameters.get('interval'),
    DEFAULT_EVENT_INTERVAL_MILLISECONDS,
    0,
    2000,
  )

  const events = createStreamEventSequence(pageCount, documentSeed, chunksPerPage)
  const encoder = new TextEncoder()

  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      for (const event of events) {
        if (request.signal.aborted) {
          break
        }
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`))
        if (intervalMilliseconds > 0) {
          await new Promise((resolve) => setTimeout(resolve, intervalMilliseconds))
        }
      }
      controller.close()
    },
  })

  return new Response(body, {
    headers: {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache, no-transform',
      // Chunks must reach the client as they are written, not when a buffer fills.
      'x-accel-buffering': 'no',
    },
  })
}

function clampInteger(
  rawValue: string | null,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  const parsed = rawValue === null ? Number.NaN : Number.parseInt(rawValue, 10)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(Math.max(parsed, minimum), maximum)
}
