import type { RandomSource } from './randomSource'

/**
 * Vocabulary for the synthetic corpus. Page rasters, extraction payloads and the tree
 * view all read their strings from here, so what a reviewer sees on the page is exactly
 * what the bounding box and the JSON inspector claim is there.
 */

const BODY_WORDS = [
  'agreement', 'allocation', 'analysis', 'annual', 'applicable', 'approval', 'assessment',
  'assets', 'audit', 'authority', 'balance', 'baseline', 'benchmark', 'billing', 'capacity',
  'capital', 'clause', 'compliance', 'consolidated', 'contract', 'contribution', 'coverage',
  'credit', 'currency', 'deferred', 'delivery', 'department', 'deposit', 'depreciation',
  'disbursement', 'distribution', 'dividend', 'documentation', 'earnings', 'effective',
  'eligibility', 'equipment', 'equity', 'estimate', 'exchange', 'expenditure', 'exposure',
  'facility', 'financial', 'fiscal', 'forecast', 'framework', 'governance', 'guarantee',
  'headcount', 'impairment', 'incentive', 'indemnity', 'inventory', 'invoice', 'issuance',
  'jurisdiction', 'liability', 'licence', 'liquidity', 'logistics', 'maintenance', 'mandate',
  'margin', 'material', 'maturity', 'measurement', 'methodology', 'milestone', 'mitigation',
  'obligation', 'operating', 'outstanding', 'oversight', 'payable', 'penalty', 'performance',
  'portfolio', 'premium', 'previous', 'procurement', 'profitability', 'projection',
  'provision', 'quarterly', 'receivable', 'reconciliation', 'recovery', 'regional',
  'regulatory', 'reimbursement', 'remediation', 'renewal', 'reporting', 'requirement',
  'reserve', 'residual', 'resolution', 'restructuring', 'retention', 'revenue', 'reviewed',
  'schedule', 'segment', 'settlement', 'shareholder', 'statement', 'subsidiary',
  'supplier', 'surplus', 'sustainability', 'territory', 'threshold', 'transaction',
  'transfer', 'treasury', 'turnover', 'utilisation', 'valuation', 'variance', 'vendor',
  'warranty', 'withholding', 'workforce', 'yield',
] as const

const CONNECTING_WORDS = [
  'and', 'of', 'the', 'for', 'with', 'under', 'within', 'against', 'across', 'per', 'to',
  'from', 'in', 'on', 'as', 'by', 'that', 'shall', 'which', 'has', 'been', 'were', 'are',
] as const

const HEADING_LEADS = [
  'Consolidated', 'Quarterly', 'Annual', 'Regional', 'Operating', 'Financial', 'Supplier',
  'Regulatory', 'Segment', 'Treasury', 'Portfolio', 'Compliance', 'Contractual',
] as const

const HEADING_TAILS = [
  'Summary', 'Overview', 'Position', 'Disclosures', 'Reconciliation', 'Performance',
  'Obligations', 'Assessment', 'Breakdown', 'Schedule', 'Commentary', 'Highlights',
] as const

const TABLE_COLUMN_LABELS = [
  'Line item', 'Description', 'Cost centre', 'Reference', 'Period', 'Quantity', 'Unit price',
  'Amount', 'Currency', 'Variance', 'Status', 'Owner', 'Due date', 'Prior year',
] as const

const FIELD_LABELS = [
  'Invoice number', 'Issue date', 'Due date', 'Purchase order', 'Vendor name', 'Vendor ID',
  'Payment terms', 'Currency', 'Subtotal', 'Tax rate', 'Total due', 'Cost centre',
  'Contract reference', 'Approved by', 'Billing period', 'Remittance account',
] as const

const STATUS_VALUES = ['Approved', 'Pending', 'In review', 'Settled', 'Disputed', 'Draft'] as const

const MONTH_NAMES = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
] as const

export type TableColumnKind = 'label' | 'text' | 'amount' | 'quantity' | 'date' | 'reference' | 'status'

export function pickBodyWord(random: RandomSource): string {
  return random.nextBoolean(0.28) ? random.pick(CONNECTING_WORDS) : random.pick(BODY_WORDS)
}

export function makeHeading(random: RandomSource): string {
  return `${random.pick(HEADING_LEADS)} ${random.pick(HEADING_TAILS)}`
}

export function makeDocumentTitle(random: RandomSource): string {
  return `${random.pick(HEADING_LEADS)} ${random.pick(HEADING_TAILS)} ${1990 + random.nextInteger(30, 37)}`
}

export function makeFieldLabel(random: RandomSource): string {
  return random.pick(FIELD_LABELS)
}

export function makeTableColumnLabel(random: RandomSource): string {
  return random.pick(TABLE_COLUMN_LABELS)
}

export function makeAmount(random: RandomSource): string {
  const whole = random.nextInteger(120, 998_000)
  return `${whole.toLocaleString('en-US')}.${String(random.nextInteger(0, 100)).padStart(2, '0')}`
}

export function makeQuantity(random: RandomSource): string {
  return String(random.nextInteger(1, 4800))
}

export function makeDate(random: RandomSource): string {
  return `${random.nextInteger(1, 29)} ${random.pick(MONTH_NAMES)} ${2020 + random.nextInteger(0, 7)}`
}

export function makeReference(random: RandomSource): string {
  const prefix = random.pick(['INV', 'PO', 'CTR', 'REQ', 'GL', 'AP'] as const)
  return `${prefix}-${2020 + random.nextInteger(0, 7)}-${String(random.nextInteger(100, 9999)).padStart(4, '0')}`
}

export function makeStatus(random: RandomSource): string {
  return random.pick(STATUS_VALUES)
}

export function makeFieldValue(random: RandomSource, label: string): string {
  if (label.includes('date') || label.includes('period')) {
    return makeDate(random)
  }
  if (label.includes('number') || label.includes('order') || label.includes('reference') || label.includes('ID')) {
    return makeReference(random)
  }
  if (label.includes('Total') || label.includes('Subtotal')) {
    return `USD ${makeAmount(random)}`
  }
  if (label.includes('rate')) {
    return `${random.nextInteger(2, 26)}.${random.nextInteger(0, 10)}%`
  }
  if (label.includes('Currency')) {
    return random.pick(['USD', 'EUR', 'GBP', 'INR', 'SGD'] as const)
  }
  if (label.includes('terms')) {
    return `Net ${random.pick(['15', '30', '45', '60'] as const)} days`
  }
  return `${capitalize(random.pick(BODY_WORDS))} ${capitalize(random.pick(BODY_WORDS))}`
}

export function makeTableCellText(
  random: RandomSource,
  columnKind: TableColumnKind,
): string {
  switch (columnKind) {
    case 'amount':
      return makeAmount(random)
    case 'quantity':
      return makeQuantity(random)
    case 'date':
      return makeDate(random)
    case 'reference':
      return makeReference(random)
    case 'status':
      return makeStatus(random)
    case 'label':
      return `${capitalize(random.pick(BODY_WORDS))} ${random.pick(BODY_WORDS)}`
    default:
      return `${random.pick(BODY_WORDS)} ${random.pick(BODY_WORDS)}`
  }
}

export function pickTableColumnKinds(random: RandomSource, columnCount: number): TableColumnKind[] {
  const kinds: TableColumnKind[] = ['label']
  const tail: TableColumnKind[] = ['reference', 'date', 'quantity', 'amount', 'status', 'text']
  for (let columnIndex = 1; columnIndex < columnCount; columnIndex += 1) {
    kinds.push(tail[(columnIndex - 1) % tail.length] ?? 'text')
  }
  return random.nextBoolean(0.5) ? kinds : [kinds[0], ...kinds.slice(1).reverse()]
}

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1)
}

const NARROW_CHARACTERS = new Set("ijltf.,;:'!|()[]-")
const WIDE_CHARACTERS = new Set('mwMW@%')

/**
 * Font-metric-free width estimate, in world units.
 *
 * The generator runs in workers and in tests where no canvas is available, so it cannot
 * call `measureText`. The painter corrects the residual error by scaling each word to the
 * width recorded here, which keeps every bounding box flush with the ink it describes.
 */
export function estimateTextWidth(text: string, fontSizeInWorldUnits: number): number {
  let relativeWidth = 0
  for (const character of text) {
    if (character === ' ') {
      relativeWidth += 0.26
    } else if (NARROW_CHARACTERS.has(character)) {
      relativeWidth += 0.3
    } else if (WIDE_CHARACTERS.has(character)) {
      relativeWidth += 0.84
    } else if (character >= 'A' && character <= 'Z') {
      relativeWidth += 0.63
    } else {
      relativeWidth += 0.5
    }
  }
  return relativeWidth * fontSizeInWorldUnits
}
