import type { ExtractionBoxPayload, PageExtractionPayload } from './extractionPayload.js'

/**
 * Wire format of the live extraction stream.
 *
 * Imports here stay relative rather than aliased, because this module is also bundled
 * into the Vite config that serves the mock endpoint — the server and the client read
 * the same definition of the protocol rather than two copies that can drift.
 */

/** Path the mock stream is served from, shared by the endpoint and its client. */
export const EXTRACTION_STREAM_PATH = '/api/extraction-stream'

export type ExtractionStreamEvent =
  | {
      kind: 'documentStarted'
      pageCount: number
      documentSeed: number
      /** How many events each page is delivered in. */
      chunksPerPage: number
    }
  | {
      kind: 'pageChunk'
      pageIndex: number
      chunkIndex: number
      chunkCount: number
      payload: PageExtractionPayload
    }
  | { kind: 'documentCompleted'; pageCount: number; boxCount: number }

/**
 * Splits a page's payload into whole blocks.
 *
 * Each chunk carries complete blocks — a root and all of its children — so a chunk is
 * self-contained and the stream can deliver them in any order without ever referring to
 * a parent that has not arrived. Every chunk also repeats the page's full reading order,
 * which is what lets the receiver rebuild the correct sequence from whatever subset of
 * blocks it currently holds.
 */
export function splitPagePayloadIntoChunks(
  payload: PageExtractionPayload,
  requestedChunkCount: number,
): PageExtractionPayload[] {
  const boxesByRootId = new Map<string, ExtractionBoxPayload[]>()
  const rootIdByBoxId = new Map<string, string>()

  for (const box of payload.boxes) {
    const rootId = box.parentId === null ? box.id : (rootIdByBoxId.get(box.parentId) ?? box.id)
    rootIdByBoxId.set(box.id, rootId)

    const group = boxesByRootId.get(rootId)
    if (group) {
      group.push(box)
    } else {
      boxesByRootId.set(rootId, [box])
    }
  }

  const rootIds = [...boxesByRootId.keys()]
  const chunkCount = Math.max(1, Math.min(requestedChunkCount, rootIds.length))
  const chunks: PageExtractionPayload[] = Array.from({ length: chunkCount }, () => ({
    pageIndex: payload.pageIndex,
    pageSize: payload.pageSize,
    boxes: [],
    tables: [],
    readingOrder: payload.readingOrder,
  }))

  rootIds.forEach((rootId, rootIndex) => {
    const chunk = chunks[rootIndex % chunkCount]
    chunk.boxes.push(...(boxesByRootId.get(rootId) ?? []))
    for (const table of payload.tables) {
      if (table.id === rootId) {
        chunk.tables.push(table)
      }
    }
  })

  return chunks.filter((chunk) => chunk.boxes.length > 0)
}
