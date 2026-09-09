import type { Plugin, PreviewServer, ViteDevServer } from 'vite'
import { createStreamEventSequence } from '../document/extraction/streamEventSource'
import { EXTRACTION_STREAM_PATH } from '../document/extraction/streamEvents'

const DEFAULT_PAGE_COUNT = 40
const DEFAULT_CHUNKS_PER_PAGE = 3
const DEFAULT_EVENT_INTERVAL_MILLISECONDS = 40
const MAXIMUM_PAGE_COUNT = 200

/**
 * Serves the mock extraction stream over Server-Sent Events, in both `dev` and `preview`.
 *
 * It exists so the workspace is exercised against a real network stream — chunked
 * transfer, an out-of-order arrival sequence, a connection that can be dropped — rather
 * than against a timer pretending to be one. The app also ships an in-app generator for
 * static hosting, and both drive the receiver through the same event sequence.
 */
export function extractionStreamPlugin(): Plugin {
  const attach = (server: ViteDevServer | PreviewServer) => {
    server.middlewares.use(EXTRACTION_STREAM_PATH, (request, response) => {
      const parameters = new URL(request.url ?? '', 'http://localhost').searchParams
      const pageCount = clampInteger(
        parameters.get('pages'),
        DEFAULT_PAGE_COUNT,
        1,
        MAXIMUM_PAGE_COUNT,
      )
      const documentSeed = clampInteger(parameters.get('seed'), 0x57ea, 0, 0xffffff)
      const chunksPerPage = clampInteger(parameters.get('chunks'), DEFAULT_CHUNKS_PER_PAGE, 1, 12)
      const intervalMilliseconds = clampInteger(
        parameters.get('interval'),
        DEFAULT_EVENT_INTERVAL_MILLISECONDS,
        0,
        2000,
      )

      response.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Chunks must reach the client as they are written, not when a buffer fills.
        'x-accel-buffering': 'no',
      })

      const events = createStreamEventSequence(pageCount, documentSeed, chunksPerPage)
      let eventIndex = 0
      let isClosed = false
      let timer: ReturnType<typeof setTimeout>

      const sendNextEvent = () => {
        if (isClosed) {
          return
        }
        if (eventIndex >= events.length) {
          response.end()
          return
        }

        response.write(`data: ${JSON.stringify(events[eventIndex])}\n\n`)
        eventIndex += 1
        timer = setTimeout(sendNextEvent, intervalMilliseconds)
      }

      timer = setTimeout(sendNextEvent, 0)

      request.on('close', () => {
        isClosed = true
        clearTimeout(timer)
      })
    })
  }

  return {
    name: 'extraction-stream',
    configureServer: attach,
    configurePreviewServer: attach,
  }
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
