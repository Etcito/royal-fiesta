import { refuse } from '@royal-fiesta/sim/refusal'
import { ROUND_KINDS, STAGE_IDS, SEASON_SEATS } from '@royal-fiesta/sim/season/kinds'
import type { RoundKind, StageId, FinalRule } from '@royal-fiesta/sim/season/kinds'

export const SEASON_FORMAT = 'royal-fiesta.season'
export const SEASON_VERSION = 0
export type MapStatus = 'planned' | 'built' | 'cut'
export interface SeasonMap {
  id: string; slug: string; name: string; course: string; kind: RoundKind
  finalRule: FinalRule | null; family: string; stages: StageId[]; capacity: number; usual: number[]
  teams: { count: 2; maxPerTeam: number; usualPerTeam: number } | null
  timeCapS: number; overtimeS: number; plan: string; assets: string
  files: { course: string; zones: string }; status: MapStatus; reason: string | null
}
export interface SeasonData {
  format: string; version: 0; id: string; name: string; world: string
  plans: { default: number[]; long: number[] }
  rules: {
    maxTeamRoundsPerShow: number; finalReservedFirst: boolean
    noBackToBack: [string, string][]; cutMaps: string[]
    floor: { final: number; race: number; survivalOrScore: number; team: number }
  }
  maps: SeasonMap[]
}
export interface SchedMap {
  id: string; course: string; kind: RoundKind; finalRule: FinalRule | null
  family: string; stages: StageId[]; capacity: number; teams: SeasonMap['teams']
  timeCapS: number; overtimeS: number
}

const MAP_IDS = ['A', 'B', 'C1', 'C2', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N', 'O', 'P', 'Q']

export function parseSeason(json: unknown, path: string): SeasonData {
  const fail = (ptr: string, reason: string, fix: string): never => refuse('season', `${path}#${ptr}`, `${reason}; fix: ${fix}`)
  const object = (v: unknown, ptr: string): Record<string, unknown> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) fail(ptr, 'expected an object', 'provide an object')
    return v as Record<string, unknown>
  }
  const array = (v: unknown, ptr: string): unknown[] => {
    if (!Array.isArray(v)) fail(ptr, 'expected an array', 'provide an array')
    return v as unknown[]
  }
  const string = (v: unknown, ptr: string): string => {
    if (typeof v !== 'string') fail(ptr, 'expected a string', 'provide text')
    return v as string
  }
  const integer = (v: unknown, ptr: string, min = 0, max = Number.MAX_SAFE_INTEGER): void => {
    if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
      fail(ptr, `expected an integer in ${min}..${max}`, 'provide a whole number in that range')
    }
  }
  const choice = (v: unknown, ptr: string, choices: readonly unknown[]): void => {
    if (!choices.includes(v)) fail(ptr, `unsupported value ${String(v)}`, `use ${choices.map(String).join(' | ')}`)
  }
  const ints = (v: unknown, ptr: string): void => {
    array(v, ptr).forEach((n, i) => integer(n, `${ptr}/${i}`, 1, SEASON_SEATS))
  }
  const s = object(json, '')
  choice(s.format, '/format', [SEASON_FORMAT])
  choice(s.version, '/version', [SEASON_VERSION])
  for (const key of ['id', 'name', 'world']) string(s[key], `/${key}`)
  const plans = object(s.plans, '/plans')
  for (const key of ['default', 'long']) ints(plans[key], `/plans/${key}`)
  const ids = new Set<string>()
  array(s.maps, '/maps').forEach((value, i) => {
    const p = `/maps/${i}`
    const m = object(value, p)
    const id = string(m.id, `${p}/id`)
    choice(id, `${p}/id`, MAP_IDS)
    if (ids.has(id)) fail(`${p}/id`, `duplicate map id ${id}`, 'use a unique map id from the roster')
    ids.add(id)
    for (const key of ['slug', 'name', 'family', 'plan', 'assets']) string(m[key], `${p}/${key}`)
    choice(m.course, `${p}/course`, [`s1-${id.toLowerCase()}-${m.slug}`])
    choice(m.kind, `${p}/kind`, ROUND_KINDS)
    choice(m.finalRule, `${p}/finalRule`, ['crown', 'lastStanding', null])
    const stages = array(m.stages, `${p}/stages`)
    if (!stages.length) fail(`${p}/stages`, 'empty stages', 'include at least one stage')
    stages.forEach((stage, j) => {
      choice(stage, `${p}/stages/${j}`, STAGE_IDS)
      if (stages.indexOf(stage) !== j) fail(`${p}/stages/${j}`, 'duplicate stage', 'list each stage only once')
    })
    integer(m.capacity, `${p}/capacity`, 2, SEASON_SEATS)
    ints(m.usual, `${p}/usual`)
    if (m.teams !== null) {
      const teams = object(m.teams, `${p}/teams`)
      choice(teams.count, `${p}/teams/count`, [2])
      integer(teams.maxPerTeam, `${p}/teams/maxPerTeam`, 1, SEASON_SEATS)
      integer(teams.usualPerTeam, `${p}/teams/usualPerTeam`, 1, SEASON_SEATS)
    }
    for (const key of ['timeCapS', 'overtimeS']) {
      const n = m[key]
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0 || (key === 'timeCapS' && n === 0)) {
        fail(`${p}/${key}`, 'invalid time in seconds', `provide a finite ${key === 'timeCapS' ? 'positive' : 'non-negative'} number`)
      }
    }
    const files = object(m.files, `${p}/files`)
    for (const key of ['course', 'zones']) {
      const file = string(files[key], `${p}/files/${key}`)
      if (!file.startsWith('courses/') || file.split('/').some(part => part === '..' || part === '.' || part === '') || /[\\?#\u0000]/.test(file)) {
        fail(`${p}/files/${key}`, 'file must be under courses/', 'use a relative courses/ path without traversal')
      }
    }
    choice(m.status, `${p}/status`, ['planned', 'built', 'cut'])
    if (m.status === 'cut') string(m.reason, `${p}/reason`)
    else choice(m.reason, `${p}/reason`, [null])
  })
  const rules = object(s.rules, '/rules')
  integer(rules.maxTeamRoundsPerShow, '/rules/maxTeamRoundsPerShow')
  choice(rules.finalReservedFirst, '/rules/finalReservedFirst', [true, false])
  const reference = (v: unknown, ptr: string): void => {
    if (!ids.has(string(v, ptr))) fail(ptr, `unknown map id ${String(v)}`, 'reference an id present in maps')
  }
  array(rules.cutMaps, '/rules/cutMaps').forEach((id, i) => reference(id, `/rules/cutMaps/${i}`))
  array(rules.noBackToBack, '/rules/noBackToBack').forEach((v, i) => {
    const ptr = `/rules/noBackToBack/${i}`
    const pair = array(v, ptr)
    if (pair.length !== 2) fail(ptr, 'expected a pair of map ids', 'provide exactly two known map ids')
    pair.forEach((id, j) => reference(id, `${ptr}/${j}`))
  })
  const floor = object(rules.floor, '/rules/floor')
  for (const key of ['final', 'race', 'survivalOrScore', 'team']) integer(floor[key], `/rules/floor/${key}`)
  return s as unknown as SeasonData
}

export function playableMaps(s: SeasonData): SeasonMap[] {
  return s.maps.filter(m => m.status === 'built')
}

export function seasonFloorProblems(s: SeasonData): string[] {
  const counts = { final: 0, race: 0, survivalOrScore: 0, team: 0 }
  for (const m of s.maps) {
    if (m.status === 'cut') continue
    if (m.finalRule !== null) counts.final++
    if (m.kind === 'race') counts.race++
    if (['survival', 'collection', 'hunt', 'logic'].includes(m.kind)) counts.survivalOrScore++
    if (m.kind === 'team') counts.team++
  }
  return (Object.keys(counts) as (keyof typeof counts)[])
    .filter(key => counts[key] < s.rules.floor[key])
    .map(key => `${key}: ${counts[key]} non-cut maps; requires at least ${s.rules.floor[key]}`)
}

export function schedMaps(s: SeasonData, courses: readonly { id: string }[]): SchedMap[] {
  const loaded = new Set(courses.map(c => c.id))
  return playableMaps(s).filter(m => loaded.has(m.course)).map(m => ({
    id: m.id, course: m.course, kind: m.kind, finalRule: m.finalRule, family: m.family,
    stages: m.stages, capacity: m.capacity, teams: m.teams, timeCapS: m.timeCapS, overtimeS: m.overtimeS,
  }))
}
