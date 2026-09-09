import { generateSyntheticPageContent } from '../synthetic/pageContentGenerator'
import { createRandomSource } from '../synthetic/randomSource'
import { buildPageExtractionPayload } from './payloadBuilder'
import { splitPagePayloadIntoChunks, type ExtractionStreamEvent } from './streamEvents'

/**
 * Builds the event sequence a live extraction would produce.
 *
 * Chunks are shuffled across the whole document, so pages arrive out of order and
 * interleaved with each other — which is the case the workspace has to survive, and the
 * one a naïve "append as it arrives" receiver gets wrong.
 *
 * Shared by the mock SSE endpoint and by the in-app fallback generator, so both drive the
 * receiver through exactly the same sequence.
 */
export function createStreamEventSequence(
  pageCount: number,
  documentSeed: number,
  chunksPerPage: number,
): ExtractionStreamEvent[] {
  const chunkEvents: ExtractionStreamEvent[] = []
  let boxCount = 0

  for (let pageIndex = 0; pageIndex < pageCount; pageIndex += 1) {
    const payload = buildPageExtractionPayload(
      generateSyntheticPageContent(pageIndex, documentSeed),
      documentSeed,
    )
    boxCount += payload.boxes.length

    const chunks = splitPagePayloadIntoChunks(payload, chunksPerPage)
    chunks.forEach((chunk, chunkIndex) => {
      chunkEvents.push({
        kind: 'pageChunk',
        pageIndex,
        chunkIndex,
        chunkCount: chunks.length,
        payload: chunk,
      })
    })
  }

  shuffleInPlace(chunkEvents, documentSeed ^ 0x51de)

  return [
    { kind: 'documentStarted', pageCount, documentSeed, chunksPerPage },
    ...chunkEvents,
    { kind: 'documentCompleted', pageCount, boxCount },
  ]
}

/** Deterministic Fisher-Yates, so a seed always produces the same arrival order. */
function shuffleInPlace<ItemType>(items: ItemType[], seed: number): void {
  const random = createRandomSource(seed)
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swapIndex = random.nextInteger(0, index + 1)
    const held = items[index]
    items[index] = items[swapIndex]
    items[swapIndex] = held
  }
}
