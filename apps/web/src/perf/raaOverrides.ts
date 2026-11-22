// ?raa=<key>:<value>,<key>:<value>: raa settings from the address, for A/B runs on any GPU without a rebuild.
// Applied at engine creation (and again with every re-application of the page's graphics options), after the
// player's options, so the address wins. Nothing is stored. Every key ends in the report (window.rfRaaReport and the
// ?perf=1 overlay): applied, rejected by the engine (with its message) or unknown. Never silently ignored.
//
//   msaa:1  maxInstances:4096  maxMaterials:128  powerPreference:low-power  pipeline:<name>   engine creation options
//   aoQuality:0  renderScale:0.7  postBloom:0  postGrading:0  postStrength:0.5  shading:vertex   the game's graphics options
//   pass.<name>:0|1                a pass on or off (Engine.passes() names, e.g. pass.ao.gtao:0)
//   <group>.<field>:<value>        Engine.set<Group>({ field: value }): shadows.resolution:1024, shadows.distance:30,
//                                  ao.slices:2, ssr.enabled:0, sunShafts.enabled:0, bloom.enabled:0, contactShadows.enabled:0,
//                                  fog.enabled:0, lodOptions.<field>, ... any Engine.setX taking a settings object
//   (a field named enabled takes 0/1 or true/false; other values are numbers, true/false or text)

export interface RaaEntry { key: string; value: string }
export interface RaaReportLine { key: string; value: string; status: 'applied' | 'rejected' | 'unknown'; detail: string }

const CREATION_NUMBERS = ['msaa', 'maxInstances', 'maxMaterials']
const CREATION_TEXT = ['powerPreference', 'pipeline']
const OPTION_KEYS = ['aoQuality', 'renderScale', 'postBloom', 'postGrading', 'postStrength', 'shading']

export function parseRaa(search: string): RaaEntry[] {
  const raw = new URLSearchParams(search).get('raa')
  if (raw === null) return []
  return raw.split(',').map(s => s.trim()).filter(s => s !== '').map(s => {
    const at = s.indexOf(':')
    return at < 0 ? { key: s, value: '' } : { key: s.slice(0, at).trim(), value: s.slice(at + 1).trim() }
  })
}

const entries: RaaEntry[] = typeof location === 'undefined' ? [] : parseRaa(location.search)
const report = new Map<string, RaaReportLine>()
const note = (e: RaaEntry, status: RaaReportLine['status'], detail: string): void => { report.set(e.key, { key: e.key, value: e.value, status, detail }) }

function scalar(field: string, v: string): unknown {
  if (v === 'true') return true
  if (v === 'false') return false
  if (field === 'enabled' && (v === '0' || v === '1')) return v === '1'
  const n = Number(v)
  return v !== '' && Number.isFinite(n) ? n : v
}

/** The engine creation options named in the address (msaa, maxInstances, maxMaterials, powerPreference, pipeline). */
export function raaCreationOptions(list: readonly RaaEntry[] = entries): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const e of list) {
    if (CREATION_NUMBERS.includes(e.key)) {
      const n = Number(e.value)
      if (e.value !== '' && Number.isFinite(n)) { out[e.key] = n; note(e, 'applied', 'engine creation option') } else note(e, 'rejected', 'not a number')
    } else if (CREATION_TEXT.includes(e.key)) { out[e.key] = e.value; note(e, 'applied', 'engine creation option') }
  }
  return out
}

/** The graphics options named in the address, merged over the player's by renderOptions.ts. */
export function raaOptionValues(list: readonly RaaEntry[] = entries): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const e of list) {
    if (!OPTION_KEYS.includes(e.key)) continue
    if (e.key === 'shading') out[e.key] = e.value
    else if ((e.key === 'postBloom' || e.key === 'postGrading') && (e.value === '0' || e.value === '1' || e.value === 'true' || e.value === 'false')) out[e.key] = e.value === '1' || e.value === 'true'
    else out[e.key] = Number(e.value)
    note(e, 'applied', 'graphics option, applied through raa-sdfm with the others')
  }
  return out
}

type Settable = Record<string, unknown>
const methodOf = (key: string): string => `set${key[0].toUpperCase()}${key.slice(1, key.indexOf('.'))}`

/** Applies the pass and group settings to `engine`; the report says what each key did. */
export function applyRaaOverrides(engine: object, list: readonly RaaEntry[] = entries): void {
  const e = engine as Settable
  const groups = new Map<string, Record<string, unknown>>()
  for (const entry of list) {
    const { key, value } = entry
    if (CREATION_NUMBERS.includes(key) || CREATION_TEXT.includes(key) || OPTION_KEYS.includes(key)) continue
    if (key.startsWith('pass.')) {
      try {
        if (typeof e.setPassEnabled !== 'function') { note(entry, 'unknown', 'the engine has no setPassEnabled'); continue }
        ;(e.setPassEnabled as (n: string, on: boolean) => void).call(engine, key.slice(5), value === '1' || value === 'true')
        note(entry, 'applied', 'setPassEnabled')
      } catch (err) { note(entry, 'rejected', (err as Error).message) }
      continue
    }
    const dot = key.indexOf('.')
    if (dot <= 0) { note(entry, 'unknown', 'not an engine creation option, graphics option, pass.<name> or <group>.<field>'); continue }
    const method = methodOf(key)
    if (typeof e[method] !== 'function') { note(entry, 'unknown', `the engine has no ${method}`); continue }
    groups.set(method, { ...groups.get(method), [key.slice(dot + 1)]: scalar(key.slice(dot + 1), value) })
  }
  for (const [method, settings] of groups) {
    const keys = list.filter(en => en.key.includes('.') && !en.key.startsWith('pass.') && methodOf(en.key) === method)
    try {
      ;(e[method] as (s: unknown) => void).call(engine, settings)
      for (const k of keys) note(k, 'applied', `${method}(${JSON.stringify(settings)})`)
    } catch (err) {
      for (const k of keys) note(k, 'rejected', `${method}: ${(err as Error).message}`)
    }
  }
}

export function raaReport(): RaaReportLine[] {
  for (const e of entries) if (!report.has(e.key)) note(e, 'unknown', 'not applied yet (no engine has been created)')
  return [...report.values()]
}

/** One overlay line per key, none without ?raa=. */
export function raaReportLines(): string[] {
  return raaReport().map(l => `raa ${l.key}:${l.value} -> ${l.status}${l.status === 'applied' ? '' : ` (${l.detail})`}`)
}

if (typeof window !== 'undefined' && entries.length > 0) (window as unknown as { rfRaaReport?: () => RaaReportLine[] }).rfRaaReport = raaReport
