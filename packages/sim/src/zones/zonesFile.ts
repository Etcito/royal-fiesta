import { CONTROL_NO_CELL, ZONE_DEFAULTS, validateZoneTuning } from '@gamesaloon/rollback/zones'
import type { ZoneTuning } from '@gamesaloon/rollback/zones'
import { refuse } from '../refusal.ts'

export const ZONES_FORMAT = 'royal-fiesta.zones'
export const ZONES_VERSION = 0

export interface ZonesFile {
  format: typeof ZONES_FORMAT
  version: typeof ZONES_VERSION
  course: string
  grid: {
    origin: [number, number]
    cell: [number, number]
    cols: number
    rows: number
  }
  parts: Record<string, 'kinematic' | 'physics'>
  tuning: ZoneTuning
}

interface CourseLike {
  readonly id: string
  readonly obstacles: readonly {
    readonly id: string
    readonly motion: { readonly kind: string }
  }[]
}

interface ObstacleLike {
  readonly id: string
  readonly motion: { readonly kind: string }
}

const TOP_KEYS = ['format', 'version', 'course', 'grid', 'parts', 'tuning']
const GRID_KEYS = ['origin', 'cell', 'cols', 'rows']
const COST_KEYS = ['seat', 'field', 'global']
const STRIDE_KEYS = ['maxCells', 'stride']
const TUNING_KEYS = Object.keys(ZONE_DEFAULTS)
const TUNING_ARRAYS = [
  'capacityByCpuClass', 'cpuThresholdsMs', 'bwThresholdsKbps', 'latThresholdsMs', 'farStrides', 'fieldCells',
]

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) refuse('zones', `${path}/${key}`, 'is not a known key; remove it')
  }
}

function pair(value: unknown): [number, number] | null {
  if (!Array.isArray(value) || value.length !== 2) return null
  const x = value[0]
  const z = value[1]
  if (typeof x !== 'number' || typeof z !== 'number' || !Number.isFinite(x) || !Number.isFinite(z)) return null
  return [x, z]
}

function positiveInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0
}

function checkTuningShape(raw: Record<string, unknown>, path: string): void {
  for (const key of TUNING_ARRAYS) {
    if (raw[key] !== undefined && !Array.isArray(raw[key])) {
      refuse('zones', `${path}/${key}`, 'must be an array; fix the tuning override')
    }
  }
  if (raw.costClass !== undefined && !isObject(raw.costClass)) {
    refuse('zones', `${path}/costClass`, 'must be an object; fix the tuning override')
  }
  const strides = raw.farStrides
  if (Array.isArray(strides)) {
    for (let i = 0; i < strides.length; i++) {
      const entry = strides[i]
      if (!isObject(entry)) refuse('zones', `${path}/farStrides[${i}]`, 'must be an object; fix the tuning override')
      onlyKeys(entry, STRIDE_KEYS, `${path}/farStrides[${i}]`)
    }
  }
  const costClass = raw.costClass
  if (isObject(costClass)) onlyKeys(costClass, COST_KEYS, `${path}/costClass`)
}

function parseTuning(raw: unknown, path: string): ZoneTuning {
  const overrides: Record<string, unknown> = {}
  if (raw !== undefined) {
    if (!isObject(raw)) refuse('zones', path, 'must be an object; fix the tuning override')
    onlyKeys(raw, TUNING_KEYS, path)
    checkTuningShape(raw, path)
    for (const key of Object.keys(raw)) overrides[key] = raw[key]
  }
  const tuning = { ...ZONE_DEFAULTS, ...overrides } as unknown as ZoneTuning
  try {
    validateZoneTuning(tuning)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const prefix = '[zones] tuning: '
    const detail = message.startsWith(prefix) ? message.slice(prefix.length) : message
    const field = /^[A-Za-z_][A-Za-z0-9_]*(?:\[\d+\]|\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(detail)
    refuse('zones', field ? `${path}/${field[0]}` : path, `${detail}; fix the tuning override`)
  }
  return tuning
}

export function parseZonesFile(json: unknown, path: string, course: CourseLike): ZonesFile {
  if (!isObject(json)) refuse('zones', path, 'must be a JSON object; fix the sidecar')
  onlyKeys(json, TOP_KEYS, path)
  if (json.format !== ZONES_FORMAT) {
    refuse('zones', `${path}/format`, `must be "${ZONES_FORMAT}"; fix the sidecar`)
  }
  if (json.version !== ZONES_VERSION) {
    refuse('zones', `${path}/version`, `must be ${ZONES_VERSION}; fix the sidecar`)
  }
  if (json.course !== course.id) {
    refuse('zones', `${path}/course`, `must be "${course.id}"; fix the sidecar`)
  }

  const rawGrid = json.grid
  if (!isObject(rawGrid)) refuse('zones', `${path}/grid`, 'must be an object; add the grid')
  onlyKeys(rawGrid, GRID_KEYS, `${path}/grid`)
  const origin = pair(rawGrid.origin)
  if (!origin) refuse('zones', `${path}/grid/origin`, 'must be two finite numbers; fix the grid')
  const cell = pair(rawGrid.cell)
  if (!cell) refuse('zones', `${path}/grid/cell`, 'must be two finite numbers; fix the grid')
  if (!(cell[0] > 0) || !(cell[1] > 0)) {
    refuse('zones', `${path}/grid/cell`, 'sizes must be greater than 0; fix the grid')
  }
  const cols = rawGrid.cols
  if (!positiveInt(cols)) refuse('zones', `${path}/grid/cols`, 'must be a positive integer; fix the grid')
  const rows = rawGrid.rows
  if (!positiveInt(rows)) refuse('zones', `${path}/grid/rows`, 'must be a positive integer; fix the grid')
  if (cols * rows > CONTROL_NO_CELL) {
    refuse('zones', `${path}/grid`, 'cols*rows must not exceed 0xFFFF; fix the grid')
  }

  const obstacles = new Map<string, string>()
  for (const obstacle of course.obstacles) obstacles.set(obstacle.id, obstacle.motion.kind)
  const parts: Record<string, 'kinematic' | 'physics'> = {}
  const rawParts = json.parts
  if (rawParts !== undefined) {
    if (!isObject(rawParts)) refuse('zones', `${path}/parts`, 'must be an object; fix the sidecar')
    for (const id of Object.keys(rawParts)) {
      const mode = rawParts[id]
      const kind = obstacles.get(id)
      if (kind === undefined) {
        refuse('zones', `${path}/parts/${id}`, 'is not an obstacle id of the course; use a course obstacle id')
      }
      if (mode !== 'kinematic' && mode !== 'physics') {
        refuse('zones', `${path}/parts/${id}`, 'must be "kinematic" or "physics"; fix the sidecar')
      }
      if (mode === 'physics' && kind !== 'seesaw') {
        refuse('zones', `${path}/parts/${id}`, `physics is only for seesaws, not "${kind}"; use kinematic`)
      }
      parts[id] = mode
    }
  }

  const tuning = parseTuning(json.tuning, `${path}/tuning`)

  return {
    format: ZONES_FORMAT,
    version: ZONES_VERSION,
    course: course.id,
    grid: { origin, cell, cols, rows },
    parts,
    tuning,
  }
}

export async function loadZonesFile(
  courseId: string,
  course: CourseLike,
  readText: (path: string) => Promise<string>,
): Promise<ZonesFile> {
  const path = `courses/${courseId}.zones.json`
  const text = await readText(path).catch(() => refuse(
    'zones', path, 'missing; add the sidecar (zone mode needs it, full-mesh mode does not)',
  ))
  let json: unknown
  try {
    json = JSON.parse(text)
  } catch {
    refuse('zones', path, 'is not valid JSON; fix the sidecar')
  }
  return parseZonesFile(json, path, course)
}

export function partMode(zones: ZonesFile, obstacle: ObstacleLike): 'kinematic' | 'physics' {
  const explicit = zones.parts[obstacle.id]
  if (explicit !== undefined) return explicit
  return obstacle.motion.kind === 'seesaw' ? 'physics' : 'kinematic'
}
