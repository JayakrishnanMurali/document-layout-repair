import type { Rect } from '@/canvas/geometry'

const DEFAULT_MAXIMUM_ITEMS_PER_NODE = 8
const DEFAULT_MAXIMUM_DEPTH = 12

export type QuadTreeOptions = {
  maximumItemsPerNode?: number
  maximumDepth?: number
}

/**
 * Node payloads are stored as parallel arrays: `itemIds[i]` describes the rectangle at
 * `itemRects[i * 4]`. Keeping the rectangle in the tree lets a point query answer
 * containment without dereferencing document state, which is what keeps hit-testing to
 * a single cache-friendly pass.
 */
class QuadTreeNode {
  readonly x: number
  readonly y: number
  readonly width: number
  readonly height: number
  readonly depth: number

  itemIds: number[] = []
  itemRects: number[] = []
  children: QuadTreeNode[] | null = null

  constructor(x: number, y: number, width: number, height: number, depth: number) {
    this.x = x
    this.y = y
    this.width = width
    this.height = height
    this.depth = depth
  }

  containsRect(x: number, y: number, width: number, height: number): boolean {
    return (
      x >= this.x &&
      y >= this.y &&
      x + width <= this.x + this.width &&
      y + height <= this.y + this.height
    )
  }

  containsPoint(x: number, y: number): boolean {
    return x >= this.x && x <= this.x + this.width && y >= this.y && y <= this.y + this.height
  }

  intersectsRect(x: number, y: number, width: number, height: number): boolean {
    return (
      x < this.x + this.width &&
      this.x < x + width &&
      y < this.y + this.height &&
      this.y < y + height
    )
  }
}

/**
 * Region quadtree over axis-aligned rectangles, sized for tens of thousands of document
 * boxes with `O(log N)` point and range queries.
 *
 * A rectangle that straddles a split stays at the node that fully contains it, so an
 * item is stored exactly once and removal never has to search sibling branches.
 */
export class QuadTree {
  private readonly root: QuadTreeNode
  private readonly maximumItemsPerNode: number
  private readonly maximumDepth: number
  private itemCount = 0

  constructor(bounds: Rect, options: QuadTreeOptions = {}) {
    this.root = new QuadTreeNode(bounds.x, bounds.y, bounds.width, bounds.height, 0)
    this.maximumItemsPerNode = options.maximumItemsPerNode ?? DEFAULT_MAXIMUM_ITEMS_PER_NODE
    this.maximumDepth = options.maximumDepth ?? DEFAULT_MAXIMUM_DEPTH
  }

  get size(): number {
    return this.itemCount
  }

  clear(): void {
    this.root.itemIds.length = 0
    this.root.itemRects.length = 0
    this.root.children = null
    this.itemCount = 0
  }

  insert(id: number, x: number, y: number, width: number, height: number): void {
    this.insertIntoNode(this.root, id, x, y, width, height)
    this.itemCount += 1
  }

  insertRect(id: number, rect: Rect): void {
    this.insert(id, rect.x, rect.y, rect.width, rect.height)
  }

  remove(id: number, x: number, y: number, width: number, height: number): boolean {
    const removed = this.removeFromNode(this.root, id, x, y, width, height)
    if (removed) {
      this.itemCount -= 1
    }
    return removed
  }

  /** Moves an item; the previous rectangle is required to locate it in `O(log N)`. */
  update(
    id: number,
    previousRect: Rect,
    nextX: number,
    nextY: number,
    nextWidth: number,
    nextHeight: number,
  ): void {
    this.remove(id, previousRect.x, previousRect.y, previousRect.width, previousRect.height)
    this.insert(id, nextX, nextY, nextWidth, nextHeight)
  }

  /** Appends the ids of every rectangle containing the point. */
  queryPoint(x: number, y: number, results: number[]): number[] {
    this.queryPointInNode(this.root, x, y, results)
    return results
  }

  /** Appends the ids of every rectangle intersecting the query rectangle. */
  queryRect(rect: Rect, results: number[]): number[] {
    this.queryRectInNode(this.root, rect.x, rect.y, rect.width, rect.height, results)
    return results
  }

  private insertIntoNode(
    node: QuadTreeNode,
    id: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    if (node.children) {
      const child = this.findContainingChild(node, x, y, width, height)
      if (child) {
        this.insertIntoNode(child, id, x, y, width, height)
        return
      }
      this.pushItem(node, id, x, y, width, height)
      return
    }

    this.pushItem(node, id, x, y, width, height)

    if (node.itemIds.length > this.maximumItemsPerNode && node.depth < this.maximumDepth) {
      this.subdivide(node)
    }
  }

  private pushItem(
    node: QuadTreeNode,
    id: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): void {
    node.itemIds.push(id)
    node.itemRects.push(x, y, width, height)
  }

  private findContainingChild(
    node: QuadTreeNode,
    x: number,
    y: number,
    width: number,
    height: number,
  ): QuadTreeNode | null {
    if (!node.children) {
      return null
    }
    for (const child of node.children) {
      if (child.containsRect(x, y, width, height)) {
        return child
      }
    }
    return null
  }

  private subdivide(node: QuadTreeNode): void {
    const halfWidth = node.width / 2
    const halfHeight = node.height / 2
    const nextDepth = node.depth + 1

    node.children = [
      new QuadTreeNode(node.x, node.y, halfWidth, halfHeight, nextDepth),
      new QuadTreeNode(node.x + halfWidth, node.y, halfWidth, halfHeight, nextDepth),
      new QuadTreeNode(node.x, node.y + halfHeight, halfWidth, halfHeight, nextDepth),
      new QuadTreeNode(node.x + halfWidth, node.y + halfHeight, halfWidth, halfHeight, nextDepth),
    ]

    const retainedIds: number[] = []
    const retainedRects: number[] = []

    for (let itemIndex = 0; itemIndex < node.itemIds.length; itemIndex += 1) {
      const rectOffset = itemIndex * 4
      const x = node.itemRects[rectOffset]
      const y = node.itemRects[rectOffset + 1]
      const width = node.itemRects[rectOffset + 2]
      const height = node.itemRects[rectOffset + 3]
      const child = this.findContainingChild(node, x, y, width, height)

      if (child) {
        this.insertIntoNode(child, node.itemIds[itemIndex], x, y, width, height)
      } else {
        retainedIds.push(node.itemIds[itemIndex])
        retainedRects.push(x, y, width, height)
      }
    }

    node.itemIds = retainedIds
    node.itemRects = retainedRects
  }

  private removeFromNode(
    node: QuadTreeNode,
    id: number,
    x: number,
    y: number,
    width: number,
    height: number,
  ): boolean {
    for (let itemIndex = 0; itemIndex < node.itemIds.length; itemIndex += 1) {
      if (node.itemIds[itemIndex] === id) {
        node.itemIds.splice(itemIndex, 1)
        node.itemRects.splice(itemIndex * 4, 4)
        return true
      }
    }

    const child = this.findContainingChild(node, x, y, width, height)
    return child ? this.removeFromNode(child, id, x, y, width, height) : false
  }

  private queryPointInNode(node: QuadTreeNode, x: number, y: number, results: number[]): void {
    if (!node.containsPoint(x, y)) {
      return
    }

    for (let itemIndex = 0; itemIndex < node.itemIds.length; itemIndex += 1) {
      const rectOffset = itemIndex * 4
      const itemX = node.itemRects[rectOffset]
      const itemY = node.itemRects[rectOffset + 1]
      if (
        x >= itemX &&
        y >= itemY &&
        x <= itemX + node.itemRects[rectOffset + 2] &&
        y <= itemY + node.itemRects[rectOffset + 3]
      ) {
        results.push(node.itemIds[itemIndex])
      }
    }

    if (node.children) {
      for (const child of node.children) {
        this.queryPointInNode(child, x, y, results)
      }
    }
  }

  private queryRectInNode(
    node: QuadTreeNode,
    x: number,
    y: number,
    width: number,
    height: number,
    results: number[],
  ): void {
    if (!node.intersectsRect(x, y, width, height)) {
      return
    }

    for (let itemIndex = 0; itemIndex < node.itemIds.length; itemIndex += 1) {
      const rectOffset = itemIndex * 4
      const itemX = node.itemRects[rectOffset]
      const itemY = node.itemRects[rectOffset + 1]
      if (
        itemX < x + width &&
        x < itemX + node.itemRects[rectOffset + 2] &&
        itemY < y + height &&
        y < itemY + node.itemRects[rectOffset + 3]
      ) {
        results.push(node.itemIds[itemIndex])
      }
    }

    if (node.children) {
      for (const child of node.children) {
        this.queryRectInNode(child, x, y, width, height, results)
      }
    }
  }
}
