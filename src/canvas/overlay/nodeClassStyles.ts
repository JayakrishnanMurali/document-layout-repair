import type { LayoutNodeClass } from '@/document/layoutTypes'

export type RgbaColor = readonly [number, number, number, number]

export type NodeClassStyle = {
  fillColor: RgbaColor
  borderColor: RgbaColor
  borderWidthInDevicePixels: number
}

/**
 * Overlay colours are chosen for legibility against printed paper, not against the dark
 * chrome: fills stay faint so the scan underneath stays readable, and borders carry the
 * class identity.
 */
export const NODE_CLASS_STYLES: Record<LayoutNodeClass, NodeClassStyle> = {
  title: {
    fillColor: [139, 92, 246, 26],
    borderColor: [124, 77, 235, 235],
    borderWidthInDevicePixels: 2.4,
  },
  heading: {
    fillColor: [99, 102, 241, 24],
    borderColor: [79, 82, 224, 225],
    borderWidthInDevicePixels: 2.2,
  },
  paragraph: {
    fillColor: [37, 99, 235, 14],
    borderColor: [29, 84, 209, 205],
    borderWidthInDevicePixels: 2,
  },
  line: {
    fillColor: [14, 165, 233, 8],
    borderColor: [7, 141, 204, 150],
    borderWidthInDevicePixels: 1,
  },
  table: {
    fillColor: [245, 158, 11, 16],
    borderColor: [206, 128, 0, 235],
    borderWidthInDevicePixels: 2.6,
  },
  tableCell: {
    fillColor: [180, 83, 9, 12],
    borderColor: [168, 90, 24, 160],
    borderWidthInDevicePixels: 1,
  },
  keyValuePair: {
    fillColor: [16, 185, 129, 20],
    borderColor: [9, 156, 108, 210],
    borderWidthInDevicePixels: 2,
  },
  keyLabel: {
    fillColor: [5, 150, 105, 18],
    borderColor: [4, 128, 90, 170],
    borderWidthInDevicePixels: 1.2,
  },
  valueField: {
    fillColor: [20, 184, 166, 18],
    borderColor: [13, 148, 136, 175],
    borderWidthInDevicePixels: 1.2,
  },
  figure: {
    fillColor: [236, 72, 153, 22],
    borderColor: [211, 48, 129, 225],
    borderWidthInDevicePixels: 2.2,
  },
  caption: {
    fillColor: [168, 85, 247, 16],
    borderColor: [146, 63, 226, 180],
    borderWidthInDevicePixels: 1.2,
  },
}

/** Applied to boxes the model was unsure about, so a reviewer can find them at a glance. */
export const LOW_CONFIDENCE_BORDER_COLOR: RgbaColor = [244, 63, 94, 240]
export const LOW_CONFIDENCE_FILL_COLOR: RgbaColor = [244, 63, 94, 24]

export const SELECTION_COLOR: RgbaColor = [76, 154, 255, 255]
export const HOVER_COLOR: RgbaColor = [130, 182, 255, 255]
