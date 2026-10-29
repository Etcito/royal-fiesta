import { refuse } from '../refusal.ts'

export const BEHAVIOUR_FORMAT = 'royal-fiesta.bot'
export const BEHAVIOUR_VERSION = 0

export const ROUTE_PREFERENCES = ['short', 'safe'] as const
export const BOT_PREDICATES = [
  'always', 'obstacleAhead', 'hazardNear', 'stuck', 'nearNode', 'nearFinish',
] as const
export const BOT_ACTIONS = ['jump', 'dive', 'grab', 'useLever'] as const

export type RoutePreference = typeof ROUTE_PREFERENCES[number]
export type BotPredicate = typeof BOT_PREDICATES[number]
export type BotAction = typeof BOT_ACTIONS[number]

export interface PhaseWindow { from: number; to: number }

export interface BotRule {
  id: string
  predicate: BotPredicate
  phase: PhaseWindow | null
  distance: number | null
  action: BotAction
}

export interface BotTicks {
  decisionTicks: number
  reactionTicks: number
  wobbleTicks: number
  stuckTicks: number
}

export interface BotRoute {
  preference: RoutePreference
  advanceDist: number
  arriveDist: number
}

export interface BotBehaviour {
  format: typeof BEHAVIOUR_FORMAT
  version: typeof BEHAVIOUR_VERSION
  id: string
  name: string
  tick: BotTicks
  route: BotRoute
  rules: BotRule[]
}

export interface BehaviourCourse {
  id?: string
  levers?: readonly unknown[]
}

type Obj = Record<string, unknown>

const ID_RE = /^[a-z0-9-]{1,40}$/
const MAX_TICK = 1_000_000
const MAX_DIST = 100
const MAX_RULES = 64

function fail(source: string, ptr: string, reason: string): never {
  refuse('bots', `${source}#${ptr}`, reason)
}

function object(v: unknown, source: string, ptr: string): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    fail(source, ptr, 'must be an object; provide an object')
  }
  return v as Obj
}

function exact(v: Obj, allowed: readonly string[], source: string, ptr: string): void {
  for (const k of Object.keys(v)) {
    if (!allowed.includes(k)) fail(source, `${ptr}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, `unknown key '${k}'; remove it`)
  }
}

function field(v: Obj, key: string, source: string, ptr: string): unknown {
  if (!(key in v)) fail(source, `${ptr}/${key}`, `missing required field '${key}'`)
  return v[key]
}

function text(v: unknown, source: string, ptr: string): string {
  if (typeof v !== 'string') fail(source, ptr, 'must be a string; provide text')
  if (v.length === 0) fail(source, ptr, 'must not be empty; provide text')
  return v
}

function integer(v: unknown, min: number, max: number, source: string, ptr: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    fail(source, ptr, `must be an integer; got ${String(v)}`)
  }
  if (v < min || v > max) fail(source, ptr, `must be in ${min}..${max}; got ${v}`)
  return v
}

function distance(v: unknown, min: number, source: string, ptr: string): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    fail(source, ptr, `must be a finite distance; got ${String(v)}`)
  }
  if (v < min || v > MAX_DIST) fail(source, ptr, `distance must be in ${min}..${MAX_DIST}; got ${v}`)
  return v
}

function oneOf<T extends string>(v: unknown, values: readonly T[], source: string, ptr: string, what: string): T {
  if (typeof v !== 'string' || !(values as readonly string[]).includes(v)) {
    fail(source, ptr, `${what} must be one of ${values.join(', ')}; got ${String(v)}`)
  }
  return v as T
}

function parseTicks(v: unknown, source: string): BotTicks {
  const o = object(v, source, '/tick')
  exact(o, ['decisionTicks', 'reactionTicks', 'wobbleTicks', 'stuckTicks'], source, '/tick')
  return {
    decisionTicks: integer(field(o, 'decisionTicks', source, '/tick'), 1, 600, source, '/tick/decisionTicks'),
    reactionTicks: integer(field(o, 'reactionTicks', source, '/tick'), 0, 120, source, '/tick/reactionTicks'),
    wobbleTicks: integer(field(o, 'wobbleTicks', source, '/tick'), 1, 3600, source, '/tick/wobbleTicks'),
    stuckTicks: integer(field(o, 'stuckTicks', source, '/tick'), 1, 3600, source, '/tick/stuckTicks'),
  }
}

function parseRoute(v: unknown, source: string): BotRoute {
  const o = object(v, source, '/route')
  exact(o, ['preference', 'advanceDist', 'arriveDist'], source, '/route')
  const preference = oneOf(field(o, 'preference', source, '/route'), ROUTE_PREFERENCES, source, '/route/preference', 'route preference')
  const advanceDist = distance(field(o, 'advanceDist', source, '/route'), 0, source, '/route/advanceDist')
  if (advanceDist <= 0) fail(source, '/route/advanceDist', `advanceDist must be > 0; got ${advanceDist}`)
  const arriveDist = distance(field(o, 'arriveDist', source, '/route'), 0, source, '/route/arriveDist')
  if (arriveDist >= advanceDist) {
    fail(source, '/route/arriveDist', `arriveDist ${arriveDist} must be below advanceDist ${advanceDist}`)
  }
  return { preference, advanceDist, arriveDist }
}

function parseRule(v: unknown, index: number, source: string): BotRule {
  const ptr = `/rules/${index}`
  const o = object(v, source, ptr)
  exact(o, ['id', 'predicate', 'phase', 'distance', 'action'], source, ptr)
  const id = text(field(o, 'id', source, ptr), source, `${ptr}/id`)
  if (!ID_RE.test(id)) fail(source, `${ptr}/id`, `rule id '${id}' must match ${ID_RE}; use lowercase letters, digits or '-'`)
  const predicate = oneOf(field(o, 'predicate', source, ptr), BOT_PREDICATES, source, `${ptr}/predicate`, 'rule predicate')
  const action = oneOf(field(o, 'action', source, ptr), BOT_ACTIONS, source, `${ptr}/action`, 'rule action')
  let phase: PhaseWindow | null = null
  if ('phase' in o) {
    const p = object(o.phase, source, `${ptr}/phase`)
    exact(p, ['from', 'to'], source, `${ptr}/phase`)
    const from = integer(field(p, 'from', source, `${ptr}/phase`), 0, MAX_TICK, source, `${ptr}/phase/from`)
    const to = integer(field(p, 'to', source, `${ptr}/phase`), 0, MAX_TICK, source, `${ptr}/phase/to`)
    if (from > to) fail(source, `${ptr}/phase`, `from ${from} is after to ${to}; set from <= to`)
    phase = { from, to }
  }
  let dist: number | null = null
  if ('distance' in o) dist = distance(o.distance, 0, source, `${ptr}/distance`)
  if (predicate === 'nearNode' || predicate === 'nearFinish') {
    if (dist === null) fail(source, `${ptr}/distance`, `predicate '${predicate}' needs a distance; add a positive distance`)
    if (dist <= 0) fail(source, `${ptr}/distance`, `distance must be > 0 for predicate '${predicate}'; got ${dist}`)
  }
  return { id, predicate, phase, distance: dist, action }
}

export function parseBehaviour(value: unknown, source = 'behaviour.bot.json'): BotBehaviour {
  const o = object(value, source, '')
  exact(o, ['format', 'version', 'id', 'name', 'tick', 'route', 'rules'], source, '')
  const format = text(field(o, 'format', source, ''), source, '/format')
  if (format !== BEHAVIOUR_FORMAT) {
    fail(source, '/format', `must be '${BEHAVIOUR_FORMAT}'; got '${format}'`)
  }
  const version = integer(field(o, 'version', source, ''), 0, MAX_TICK, source, '/version')
  if (version !== BEHAVIOUR_VERSION) {
    fail(source, '/version', `unsupported version ${version}; only version ${BEHAVIOUR_VERSION} is supported`)
  }
  const id = text(field(o, 'id', source, ''), source, '/id')
  if (!ID_RE.test(id)) fail(source, '/id', `behaviour id '${id}' must match ${ID_RE}; use lowercase letters, digits or '-'`)
  const name = text(field(o, 'name', source, ''), source, '/name')
  const tick = parseTicks(field(o, 'tick', source, ''), source)
  const route = parseRoute(field(o, 'route', source, ''), source)
  const raw = field(o, 'rules', source, '')
  if (!Array.isArray(raw)) fail(source, '/rules', 'must be an array of rules; provide at least one rule')
  if (raw.length === 0) fail(source, '/rules', 'must contain at least one rule')
  if (raw.length > MAX_RULES) fail(source, '/rules', `${raw.length} rules, at most ${MAX_RULES}; split the behaviour`)
  const rules: BotRule[] = []
  const ids = new Set<string>()
  for (let i = 0; i < raw.length; i++) {
    const rule = parseRule(raw[i], i, source)
    if (ids.has(rule.id)) fail(source, `/rules/${i}/id`, `duplicate rule id '${rule.id}'; use unique ids`)
    ids.add(rule.id)
    rules.push(rule)
  }
  return { format: BEHAVIOUR_FORMAT, version: BEHAVIOUR_VERSION, id, name, tick, route, rules }
}

export function loadBehaviour(textValue: string, source = 'behaviour.bot.json'): BotBehaviour {
  let value: unknown
  try {
    value = JSON.parse(textValue)
  } catch (e) {
    refuse('bots', source, `invalid JSON: ${(e as Error).message}; fix the file syntax`)
  }
  return parseBehaviour(value, source)
}

export function bindBehaviour(b: BotBehaviour, course: BehaviourCourse): BotBehaviour {
  const index = b.rules.findIndex(r => r.action === 'useLever')
  if (index < 0) return b
  if (Array.isArray(course.levers) && course.levers.length > 0) return b
  const where = course.id === undefined ? 'the course' : `course '${course.id}'`
  refuse(
    'bots',
    `behaviours/${b.id}/rules/${index}/action`,
    `useLever needs a course with levers; ${where} has none`,
  )
}
