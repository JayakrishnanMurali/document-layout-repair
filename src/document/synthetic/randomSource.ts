/**
 * Small deterministic PRNG (mulberry32). Page textures and extraction payloads are
 * generated in different threads, so both sides must derive identical content from the
 * same `(documentSeed, pageIndex)` pair without sharing any state.
 */
export type RandomSource = {
  nextFloat(): number
  nextInRange(minimum: number, maximum: number): number
  nextInteger(minimumInclusive: number, maximumExclusive: number): number
  nextBoolean(probability: number): boolean
  pick<T>(values: readonly T[]): T
}

export function createRandomSource(seed: number): RandomSource {
  let state = seed >>> 0

  const nextFloat = (): number => {
    state = (state + 0x6d2b79f5) >>> 0
    let mixed = state
    mixed = Math.imul(mixed ^ (mixed >>> 15), mixed | 1)
    mixed ^= mixed + Math.imul(mixed ^ (mixed >>> 7), mixed | 61)
    return ((mixed ^ (mixed >>> 14)) >>> 0) / 4294967296
  }

  return {
    nextFloat,
    nextInRange: (minimum, maximum) => minimum + nextFloat() * (maximum - minimum),
    nextInteger: (minimumInclusive, maximumExclusive) =>
      minimumInclusive + Math.floor(nextFloat() * (maximumExclusive - minimumInclusive)),
    nextBoolean: (probability) => nextFloat() < probability,
    pick: (values) => values[Math.floor(nextFloat() * values.length)] as never,
  }
}

/** Mixes a document seed with a page index so pages are independent but reproducible. */
export function derivePageSeed(documentSeed: number, pageIndex: number): number {
  return (Math.imul(documentSeed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(pageIndex + 1, 0xc2b2ae35)) >>> 0
}
