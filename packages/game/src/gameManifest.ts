// Game manifest `sdfm.game.json` (S14): parsed strictly, then checked against the game's own loader
// (MOTION_KINDS and courseV1's MOTION_FIELDS) so SDF Modeler sees exactly the keys the game reads.
import { MOTION_KINDS } from '@royal-fiesta/sim/course'
import type { MotionKind } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import { MOTION_FIELDS } from './courseV1.ts'
import { MECHANISM_PRESETS } from './mechanismsJson.ts'
import type { MechanismPreset } from './mechanismsJson.ts'
import type { JointKind, LinkTarget } from '@royal-fiesta/sim/mechanismSpec'
import type { World } from './gameAsset.ts'

export type FieldType = 'number' | 'integer' | 'boolean' | 'string' | 'vec3' | 'quat' | { enum: readonly string[] } | { readonly [k: string]: FieldType }
export interface GameManifest {
  format: 'sdfm.game'
  version: 1
  id: string
  name: string
  folders: { assets: string; courses: string; ui: string; audio: string }
  worlds: World[]
  courseFormat: string
  courseVersion: 1
  markers: Record<string, Record<string, FieldType>>
  motions: Record<MotionKind, Record<string, FieldType>>
  play: { dev: string }
  mechanisms?: ManifestMechanisms
}

// S14: the S12/S13 mechanism schemas declared to sdfm.
export interface ManifestMechanisms { version: 1; jointKinds: JointKind[]; linkTargets: LinkTarget['kind'][]; presets: MechanismPreset[] }

const JOINT_KINDS: readonly JointKind[] = ['fixed', 'hinge', 'slider', 'ball', 'spring', 'rope']
const LINK_TARGETS: readonly LinkTarget['kind'][] = ['motor', 'door', 'spring', 'animation']

const TOP_KEYS = ['format', 'version', 'id', 'name', 'folders', 'worlds', 'courseFormat', 'courseVersion', 'markers', 'motions', 'play']
const FOLDER_KEYS = ['assets', 'courses', 'ui']
const OPTIONAL_TOP = ['mechanisms']
const WORLDS: readonly World[] = ['candy', 'ice', 'jungle', 'neon', 'common']
const SCALARS = ['number', 'integer', 'boolean', 'string', 'vec3', 'quat']
const MARKERS = ['spawn', 'checkpoint', 'finish', 'killPlane', 'queuePad', 'podiumSpot']
// JSON.parse keeps these as own keys; copying them onto a plain object would touch the prototype.
const FORBIDDEN_KEYS = ['__proto__', 'constructor', 'prototype']

type Obj = Record<string, unknown>

function fail(path: string, ptr: string, reason: string): never {
  return refuse('manifest', `${path}#${ptr}`, reason)
}

function escapePointer(s: string): string { return s.replace(/~/g, '~0').replace(/\//g, '~1') }

function obj(v: unknown, path: string, ptr: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, ptr, 'must be an object; provide an object')
  for (const k of Object.keys(v)) {
    if (FORBIDDEN_KEYS.includes(k)) fail(path, `${ptr}/${escapePointer(k)}`, `key '${k}' is not allowed; rename it`)
  }
  return v as Obj
}

function exactKeys(v: Obj, allowed: readonly string[], path: string, ptr: string, optional: readonly string[] = []): void {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k) && !optional.includes(k)) fail(path, `${ptr}/${escapePointer(k)}`, `unknown key '${k}'; remove it or use a supported field`)
  }
  for (const k of allowed) {
    if (!Object.hasOwn(v, k)) fail(path, `${ptr}/${escapePointer(k)}`, `missing key '${k}'; add it`)
  }
}

function text(v: unknown, path: string, ptr: string): string {
  if (typeof v !== 'string' || v.length === 0) fail(path, ptr, 'must be a non-empty string; provide text')
  return v
}

function literal<T>(v: unknown, want: T, path: string, ptr: string): T {
  if (v !== want) fail(path, ptr, `must be ${JSON.stringify(want)}; set it to ${JSON.stringify(want)}`)
  return want
}

function fieldType(v: unknown, path: string, ptr: string): FieldType {
  if (typeof v === 'string') {
    if (!SCALARS.includes(v)) fail(path, ptr, `unknown field type '${v}'; use one of ${SCALARS.join(', ')}, {enum:[...]} or a nested object`)
    return v as FieldType
  }
  const o = obj(v, path, ptr)
  if (Object.hasOwn(o, 'enum') && Array.isArray(o.enum)) {
    exactKeys(o, ['enum'], path, ptr)
    const values = o.enum
    if (values.length === 0) fail(path, `${ptr}/enum`, 'enum is empty; list at least one value')
    values.forEach((e, i) => {
      text(e, path, `${ptr}/enum/${i}`)
      if (values.indexOf(e) !== i) fail(path, `${ptr}/enum/${i}`, `duplicate enum value '${e}'; list each value once`)
    })
    return { enum: [...values] as string[] }
  }
  return fields(o, path, ptr)
}

function fields(o: Obj, path: string, ptr: string): Record<string, FieldType> {
  const out: Record<string, FieldType> = {}
  for (const [k, t] of Object.entries(o)) out[k] = fieldType(t, path, `${ptr}/${escapePointer(k)}`)
  return out
}

function schemaTable(v: unknown, path: string, ptr: string): Record<string, Record<string, FieldType>> {
  const o = obj(v, path, ptr)
  const out: Record<string, Record<string, FieldType>> = {}
  for (const [k, f] of Object.entries(o)) {
    const p = `${ptr}/${escapePointer(k)}`
    out[k] = fields(obj(f, path, p), path, p)
  }
  return out
}

export function parseGameManifest(json: unknown, path: string): GameManifest {
  const m = obj(json, path, '')
  exactKeys(m, TOP_KEYS, path, '', OPTIONAL_TOP)
  const folders = obj(m.folders, path, '/folders')
  exactKeys(folders, FOLDER_KEYS, path, '/folders', ['audio'])
  const list = m.worlds
  if (!Array.isArray(list)) fail(path, '/worlds', 'must be an array; list the worlds')
  const worlds = list.map((w, i): World => {
    if (!WORLDS.includes(w as World)) fail(path, `/worlds/${i}`, `unknown world '${String(w)}'; use one of ${WORLDS.join(', ')}`)
    if (list.indexOf(w) !== i) fail(path, `/worlds/${i}`, `duplicate world '${w}'; list each world once`)
    return w as World
  })
  const play = obj(m.play, path, '/play')
  exactKeys(play, ['dev'], path, '/play')
  const dev = text(play.dev, path, '/play/dev')
  if (!dev.includes('{id}')) fail(path, '/play/dev', 'must contain {id}; put {id} where the course id goes')
  return {
    format: literal(m.format, 'sdfm.game', path, '/format'),
    version: literal(m.version, 1, path, '/version'),
    id: text(m.id, path, '/id'),
    name: text(m.name, path, '/name'),
    folders: {
      assets: text(folders.assets, path, '/folders/assets'),
      courses: text(folders.courses, path, '/folders/courses'),
      ui: text(folders.ui, path, '/folders/ui'),
      audio: Object.hasOwn(folders, 'audio') ? text(folders.audio, path, '/folders/audio') : 'audio',
    },
    worlds,
    courseFormat: literal(m.courseFormat, 'royal-fiesta.course', path, '/courseFormat'),
    courseVersion: literal(m.courseVersion, 1, path, '/courseVersion'),
    markers: schemaTable(m.markers, path, '/markers'),
    // Missing or extra motion kinds parse; manifestCoverage reports them.
    motions: schemaTable(m.motions, path, '/motions') as Record<MotionKind, Record<string, FieldType>>,
    play: { dev },
    ...(Object.hasOwn(m, 'mechanisms') ? { mechanisms: mechanismsOf(m.mechanisms, path) } : {}),
  }
}

function subset<T extends string>(v: unknown, allowed: readonly T[], path: string, ptr: string): T[] {
  if (!Array.isArray(v)) fail(path, ptr, 'must be an array; list the supported values')
  return v.map((x, i): T => {
    if (!allowed.includes(x as T)) fail(path, `${ptr}/${i}`, `unknown value '${String(x)}'; use one of ${allowed.join(', ')}`)
    if (v.indexOf(x) !== i) fail(path, `${ptr}/${i}`, `duplicate value '${x}'; list each value once`)
    return x as T
  })
}

function mechanismsOf(v: unknown, path: string): ManifestMechanisms {
  const o = obj(v, path, '/mechanisms')
  exactKeys(o, ['version', 'jointKinds', 'linkTargets', 'presets'], path, '/mechanisms')
  return {
    version: literal(o.version, 1, path, '/mechanisms/version'),
    jointKinds: subset(o.jointKinds, JOINT_KINDS, path, '/mechanisms/jointKinds'),
    linkTargets: subset(o.linkTargets, LINK_TARGETS, path, '/mechanisms/linkTargets'),
    presets: subset(o.presets, MECHANISM_PRESETS, path, '/mechanisms/presets'),
  }
}

// A deep, order-sensitive description of a field type, used for comparison and messages.
function describe(t: FieldType | undefined): string {
  if (t === undefined) return 'nothing'
  if (typeof t === 'string') return t
  if (Object.hasOwn(t, 'enum') && Array.isArray(t.enum)) return `{enum:[${(t.enum as readonly string[]).join(',')}]}`
  const o = t as { readonly [k: string]: FieldType }
  return `{${Object.keys(o).sort().map(k => `${k}:${describe(o[k])}`).join(',')}}`
}

export interface ManifestCoverage {
  missingMotions: string[]; extraMotions: string[]; keyMismatches: string[]; missingMarkers: string[]
  audioFolder: string
  // null when the manifest declares no mechanisms; otherwise what the game reads but the manifest omits.
  mechanisms: { missingJointKinds: string[]; missingLinkTargets: string[]; missingPresets: string[] } | null
}

export function manifestCoverage(m: GameManifest): ManifestCoverage {
  const kinds: readonly string[] = MOTION_KINDS
  const motions: Record<string, Record<string, FieldType>> = m.motions
  const declared = Object.keys(motions)
  const keyMismatches: string[] = []
  for (const kind of MOTION_KINDS) {
    if (!Object.hasOwn(motions, kind)) continue
    const got = motions[kind]
    const want: Readonly<Record<string, FieldType>> = MOTION_FIELDS[kind]
    for (const key of Object.keys(want)) {
      if (!Object.hasOwn(got, key)) keyMismatches.push(`${kind}.${key}: missing key`)
      else if (describe(got[key]) !== describe(want[key])) keyMismatches.push(`${kind}.${key}: expected ${describe(want[key])}, got ${describe(got[key])}`)
    }
    for (const key of Object.keys(got)) {
      if (!Object.hasOwn(want, key)) keyMismatches.push(`${kind}.${key}: extra key`)
    }
  }
  return {
    missingMotions: kinds.filter(k => !Object.hasOwn(motions, k)),
    extraMotions: declared.filter(k => !kinds.includes(k)),
    keyMismatches,
    missingMarkers: MARKERS.filter(k => !Object.hasOwn(m.markers, k)),
    audioFolder: m.folders.audio,
    mechanisms: m.mechanisms ? {
      missingJointKinds: JOINT_KINDS.filter(k => !m.mechanisms!.jointKinds.includes(k)),
      missingLinkTargets: LINK_TARGETS.filter(k => !m.mechanisms!.linkTargets.includes(k)),
      missingPresets: MECHANISM_PRESETS.filter(k => !m.mechanisms!.presets.includes(k)),
    } : null,
  }
}
