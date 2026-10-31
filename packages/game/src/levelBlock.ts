import { SURFACES } from '@royal-fiesta/sim/course'
import type { FeatureSpec, GroupSpec, HomeSpec, LevelSpec, ObstacleSpec } from '@royal-fiesta/sim/course'
import { FEATURE_KINDS } from '@royal-fiesta/sim/features/catalog'
import { refuse } from '@royal-fiesta/sim/refusal'
import { ROUND_KINDS, STAGE_IDS } from '@royal-fiesta/sim/season/kinds'
import { degToRad, v3, yawFacing } from '@royal-fiesta/sim/vec'

type Obj = Record<string, unknown>
const ROLES = ['floor', 'wall', 'hazard', 'mover', 'objective', 'respawn', 'route', 'decor'] as const
const ID = /^[a-z0-9-]{1,40}$/

function fail(path: string, reason: string): never { return refuse('course', path, reason) }
function obj(v: unknown, path: string, allowed?: readonly string[]): Obj {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(path, 'must be an object; provide an object')
  const o = v as Obj
  if (allowed) for (const k of Object.keys(o)) {
    if (!allowed.includes(k)) fail(`${path}/${k.replace(/~/g, '~0').replace(/\//g, '~1')}`, `unknown key '${k}'; remove it or use a supported field`)
  }
  return o
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) fail(path, 'must be an array; provide an array')
  return v
}
function str(v: unknown, path: string): string {
  if (typeof v !== 'string') fail(path, 'must be a string; provide text')
  return v
}
function num(v: unknown, path: string, min = -Infinity, max = Infinity): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) fail(path, 'must be a finite number; provide a finite JSON number')
  if (v < min || v > max) fail(path, `must be in ${min}..${max}; use a number in that range`)
  return v
}
function int(v: unknown, path: string, min = -Infinity, max = Infinity): number {
  const n = num(v, path, min, max)
  if (!Number.isInteger(n)) fail(path, 'must be an integer; use a whole number')
  return n
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== 'boolean') fail(path, 'must be a boolean; use true or false')
  return v
}
function choice<T extends string>(v: unknown, values: readonly T[], path: string): T {
  if (typeof v !== 'string' || !values.includes(v as T)) fail(path, `unsupported value '${String(v)}'; use ${values.join(', ')}`)
  return v as T
}
function ticks(v: unknown, path: string, zero: boolean): number {
  const s = num(v, path, 0)
  const n = Math.round(s * 60)
  if (!Number.isFinite(n) || (s === 0 ? !zero : n < 1)) fail(path, `duration must round to at least one tick${zero ? ' or be zero' : ''}; increase the seconds`)
  return n
}
function vec(v: unknown, path: string) {
  const a = arr(v, path)
  if (a.length !== 3) fail(path, 'must have three components; use [x,y,z]')
  return v3(num(a[0], `${path}/0`), num(a[1], `${path}/1`), num(a[2], `${path}/2`))
}

// The optional lists let the v1 loader validate group references before resolving assets.
type LevelCourse = {
  kind: string; checkpoints: unknown[]; obstacles: { id: string }[]; finish: unknown | null
  features?: readonly { id: string }[]; decor?: readonly { id: string }[]
}

export function parseLevelBlock(json: unknown, path: string, course: LevelCourse): LevelSpec {
  const p = `${path}#/level`
  const o = obj(json, p, ['season', 'map', 'kind', 'finalRule', 'stages', 'capacity', 'usual', 'quota', 'timeCapS', 'overtimeS', 'respawn', 'route', 'teams', 'homes', 'groups', 'grab'])
  const kind = choice(o.kind, ROUND_KINDS, `${p}/kind`)
  const finalRule = o.finalRule === null ? null : choice(o.finalRule, ['crown', 'lastStanding'] as const, `${p}/finalRule`)
  const survival = kind === 'survival' || (kind === 'final' && finalRule === 'lastStanding')
  const stages = arr(o.stages, `${p}/stages`).map((v, i) => choice(v, STAGE_IDS, `${p}/stages/${i}`))
  if (stages.length === 0 || new Set(stages).size !== stages.length) fail(`${p}/stages`, 'stages must be non-empty and unique; list each allowed stage once')
  const capacity = int(o.capacity, `${p}/capacity`, 1, 60)
  const usual = arr(o.usual, `${p}/usual`).map((v, i) => int(v, `${p}/usual/${i}`))
  const quota = o.quota === null ? null : int(obj(o.quota, `${p}/quota`, ['count']).count, `${p}/quota/count`, 1, capacity)
  const homes: HomeSpec[] = arr(o.homes, `${p}/homes`).map((v, i) => {
    const h = `${p}/homes/${i}`
    const home = obj(v, h, ['team', 'center', 'half', 'respawn'])
    const center = vec(home.center, `${h}/center`)
    const half = vec(home.half, `${h}/half`)
    if (half.x <= 0 || half.y <= 0 || half.z <= 0) fail(`${h}/half`, 'box half extents must be > 0; use positive extents')
    const respawn = arr(home.respawn, `${h}/respawn`).map((v, j) => {
      const s = `${h}/respawn/${j}`
      const spawn = obj(v, s, ['t', 'yawDeg'])
      return { t: vec(spawn.t, `${s}/t`), facing: yawFacing(degToRad(num(spawn.yawDeg, `${s}/yawDeg`)), { x: 0, z: 1 }) }
    })
    if (respawn.length === 0) fail(`${h}/respawn`, 'home needs respawn spawns; add at least one spawn')
    return { team: int(home.team, `${h}/team`, 0, 1), box: { center, half }, respawn }
  })
  const r = obj(o.respawn, `${p}/respawn`, ['mode', 'waitS', 'protectS', 'slots', 'spacingM'])
  const mode = r.mode === undefined ? (survival ? 'none' : 'checkpoint') : choice(r.mode, ['checkpoint', 'home', 'none'] as const, `${p}/respawn/mode`)
  if (mode === 'none' && !survival) fail(`${p}/respawn/mode`, 'none requires survival or final lastStanding; use checkpoint or home')
  if (mode === 'home' && homes.length === 0) fail(`${p}/homes`, 'home respawn needs homes; add a home with respawn spawns')
  const spacingM = num(r.spacingM, `${p}/respawn/spacingM`, 0)
  if (spacingM === 0) fail(`${p}/respawn/spacingM`, 'spacing must be > 0; use positive metres')
  const respawn = { mode, waitTicks: ticks(r.waitS, `${p}/respawn/waitS`, true), protectTicks: ticks(r.protectS, `${p}/respawn/protectS`, true), slots: int(r.slots, `${p}/respawn/slots`, 1, 12), spacingM }
  const rt = obj(o.route, `${p}/route`, ['ordered', 'laps', 'stages'])
  const laps = int(rt.laps, `${p}/route/laps`, 1)
  if (laps > 1 && course.finish == null) fail(`${p}/route/laps`, 'multiple laps need a finish box; add a finish or use one lap')
  const routeStages = arr(rt.stages, `${p}/route/stages`).map((v, i) => int(v, `${p}/route/stages/${i}`, 0))
  if (routeStages.length !== course.checkpoints.length) fail(`${p}/route/stages`, 'needs one stage per checkpoint; match the checkpoint count')
  for (let i = 0; i < routeStages.length; i++) {
    if ((i === 0 && routeStages[i] !== 0) || (i > 0 && routeStages[i] < routeStages[i - 1])) fail(`${p}/route/stages/${i}`, 'stages must start at 0 and be non-decreasing; reorder or renumber the stages')
  }
  const route = { ordered: bool(rt.ordered, `${p}/route/ordered`), laps, stages: routeStages }
  let teams: LevelSpec['teams'] = null
  if (o.teams !== null) {
    const t = obj(o.teams, `${p}/teams`, ['count', 'maxPerTeam'])
    int(t.count, `${p}/teams/count`, 2, 2)
    teams = { count: 2, maxPerTeam: int(t.maxPerTeam, `${p}/teams/maxPerTeam`, 1, 30) }
  }
  const ids = new Set<string>()
  const assigned = new Set<string>()
  const members = new Set([...course.obstacles, ...(course.features ?? []), ...(course.decor ?? [])].map(v => v.id))
  const groups: GroupSpec[] = arr(o.groups, `${p}/groups`).map((v, i) => {
    const g = `${p}/groups/${i}`
    const group = obj(v, g, ['id', 'role', 'friction', 'surface', 'members'])
    const id = str(group.id, `${g}/id`)
    if (ids.has(id)) fail(`${g}/id`, `duplicate group id '${id}'; give each group a unique id`)
    ids.add(id)
    return {
      id, role: choice(group.role, ROLES, `${g}/role`),
      friction: group.friction === null ? null : num(group.friction, `${g}/friction`, 0, 2),
      surface: group.surface === null ? null : choice(group.surface, SURFACES, `${g}/surface`),
      members: arr(group.members, `${g}/members`).map((v, j) => {
        const m = `${g}/members/${j}`
        const member = str(v, m)
        if (!members.has(member)) fail(m, `unknown member '${member}'; use an obstacle, feature or decor id from this course`)
        if (assigned.has(member)) fail(m, `member '${member}' is already grouped; assign each member only once`)
        assigned.add(member)
        return member
      }),
    }
  })
  const grab = o.grab === undefined ? {} : obj(o.grab, `${p}/grab`, ['players', 'objects'])
  return {
    season: o.season === null ? null : str(o.season, `${p}/season`),
    map: o.map === null ? null : str(o.map, `${p}/map`), kind, finalRule, stages, capacity, usual, quota,
    timeCapTicks: ticks(o.timeCapS, `${p}/timeCapS`, false), overtimeTicks: ticks(o.overtimeS, `${p}/overtimeS`, true),
    respawn, route, teams, homes, groups,
    grab: { players: grab.players === undefined ? !survival : bool(grab.players, `${p}/grab/players`), objects: grab.objects === undefined ? true : bool(grab.objects, `${p}/grab/objects`) },
  }
}

export function parseFeatureList(json: unknown, path: string): FeatureSpec[] {
  const p = `${path}#/features`
  const list = arr(json, p)
  if (list.length > 32) fail(p, 'too many features; keep at most 32')
  const ids = new Set<string>()
  return list.map((v, i) => {
    const f = `${p}/${i}`
    const o = obj(v, f)
    const id = str(o.id, `${f}/id`)
    if (!ID.test(id)) fail(`${f}/id`, 'invalid feature id; use 1..40 lowercase letters, digits or hyphens')
    if (ids.has(id)) fail(`${f}/id`, `duplicate feature id '${id}'; give each feature a unique id`)
    ids.add(id)
    const kind = str(o.kind, `${f}/kind`)
    if (!Object.hasOwn(FEATURE_KINDS, kind)) fail(`${f}/kind`, `unknown feature kind '${kind}'; use ${Object.keys(FEATURE_KINDS).join(', ')}`)
    const { id: _id, kind: _kind, ...params } = o
    const spec = { id, kind, params }
    FEATURE_KINDS[kind](spec, f)
    return spec
  })
}

export function applyGroups(level: LevelSpec, obstacles: ObstacleSpec[]): void {
  const byId = new Map(obstacles.map(o => [o.id, o]))
  for (const group of level.groups) for (const id of group.members) {
    const obstacle = byId.get(id)
    if (!obstacle) continue
    if (group.friction !== null) obstacle.friction = group.friction
    if (group.surface !== null) obstacle.surface = group.surface
  }
}
