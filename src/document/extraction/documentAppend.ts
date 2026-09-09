import {
  createLayoutGeometry,
  ensureLayoutGeometryCapacity,
} from '@/document/geometryBuffers'
import {
  sortTableMeshesByPosition,
  type LayoutDocument,
  type LayoutNodeId,
  type PageNodeRange,
  type TableMesh,
} from '@/document/layoutTypes'

/**
 * One chunk's worth of nodes, as it travels from the worker to the main thread.
 *
 * The geometry arrives as transferable typed arrays covering exactly the appended range,
 * so a stream event costs one structured-clone of a few kilobytes rather than a copy of
 * the whole document.
 */
export type DocumentAppendPatch = {
  pageIndex: number
  firstNodeId: LayoutNodeId
  nodeCount: number
  bounds: Float32Array
  classIds: Uint8Array
  pageIndexes: Uint16Array
  parentIds: Int32Array
  confidences: Float32Array
  flags: Uint8Array
  texts: (string | null)[]
  sourceNodeIds: string[]
  rootNodeIds: LayoutNodeId[]
  /** The page's full reading order after this append, already resolved to node ids. */
  readingOrderNodeIds: LayoutNodeId[]
  tableMeshes: TableMesh[]
}

export function collectAppendPatchTransferables(patch: DocumentAppendPatch): Transferable[] {
  return [
    patch.bounds.buffer,
    patch.classIds.buffer,
    patch.pageIndexes.buffer,
    patch.parentIds.buffer,
    patch.confidences.buffer,
    patch.flags.buffer,
  ]
}

export function createEmptyLayoutDocument(pageCount: number): LayoutDocument {
  return {
    pageCount,
    geometry: createLayoutGeometry(),
    texts: [],
    sourceNodeIds: [],
    childIdsByNodeId: [],
    rootNodeIdsByPage: Array.from({ length: pageCount }, () => []),
    nodeRangesByPage: Array.from({ length: pageCount }, () => []),
    readingOrderByPage: Array.from({ length: pageCount }, (_unused, pageIndex) => ({
      pageIndex,
      nodeIds: [],
    })),
    tableMeshesByPage: Array.from({ length: pageCount }, () => []),
  }
}

/**
 * Applies an append to the main thread's copy of the document.
 *
 * The document object identity is preserved throughout a stream, so the canvas engine and
 * the editor keep the same reference and only have to be told that it grew — a fresh
 * document per event would reset selection and history on every chunk.
 */
export function applyDocumentAppend(
  layoutDocument: LayoutDocument,
  patch: DocumentAppendPatch,
): PageNodeRange {
  const { geometry } = layoutDocument
  const lastNodeId = patch.firstNodeId + patch.nodeCount

  ensureLayoutGeometryCapacity(geometry, lastNodeId)
  geometry.bounds.set(patch.bounds, patch.firstNodeId * 4)
  geometry.classIds.set(patch.classIds, patch.firstNodeId)
  geometry.pageIndexes.set(patch.pageIndexes, patch.firstNodeId)
  geometry.parentIds.set(patch.parentIds, patch.firstNodeId)
  geometry.confidences.set(patch.confidences, patch.firstNodeId)
  geometry.flags.set(patch.flags, patch.firstNodeId)
  geometry.nodeCount = Math.max(geometry.nodeCount, lastNodeId)

  for (let index = 0; index < patch.nodeCount; index += 1) {
    const nodeId = patch.firstNodeId + index
    layoutDocument.texts[nodeId] = patch.texts[index]
    layoutDocument.sourceNodeIds[nodeId] = patch.sourceNodeIds[index]
    while (layoutDocument.childIdsByNodeId.length <= nodeId) {
      layoutDocument.childIdsByNodeId.push([])
    }
  }

  // Child links are derived here rather than sent: the parent ids already came with the
  // geometry, and rebuilding them costs one pass over the appended nodes.
  for (let index = 0; index < patch.nodeCount; index += 1) {
    const nodeId = patch.firstNodeId + index
    const parentId = geometry.parentIds[nodeId]
    if (parentId < 0) {
      continue
    }
    const siblings = layoutDocument.childIdsByNodeId[parentId]
    if (siblings && !siblings.includes(nodeId)) {
      siblings.push(nodeId)
    }
  }

  const range: PageNodeRange = {
    pageIndex: patch.pageIndex,
    firstNodeId: patch.firstNodeId,
    nodeCount: patch.nodeCount,
  }
  layoutDocument.nodeRangesByPage[patch.pageIndex].push(range)
  layoutDocument.rootNodeIdsByPage[patch.pageIndex].push(...patch.rootNodeIds)
  layoutDocument.readingOrderByPage[patch.pageIndex] = {
    pageIndex: patch.pageIndex,
    nodeIds: patch.readingOrderNodeIds,
  }
  layoutDocument.tableMeshesByPage[patch.pageIndex].push(...patch.tableMeshes)
  sortTableMeshesByPosition(layoutDocument.tableMeshesByPage[patch.pageIndex])

  return range
}
