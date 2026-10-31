import { readFileSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseSeason, SEASON_FORMAT, SEASON_VERSION } from '../packages/game/src/season.ts'
import type { SeasonData, SeasonMap } from '../packages/game/src/season.ts'
import type { RoundKind } from '../packages/sim/src/season/kinds.ts'
import { STAGE_IDS } from '../packages/sim/src/season/kinds.ts'

const source = 'docs/level-plans/README.md'
const kebab = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
function required<T>(value: T | null | undefined, description: string): T {
  if (value == null) throw new Error(`${source}: missing ${description}; fix: restore the README field`)
  return value
}
function table(readme: string, heading: string): string[][] {
  const section = required(readme.split(`## ${heading}\n`)[1], heading).split(/^## /m)[0]
  const rows = section.split('\n').filter(line => line.startsWith('|')).map(line => line.split('|').slice(1, -1).map(cell => cell.trim()))
  if (rows.length < 3) throw new Error(`${source}: missing table in ${heading}`)
  return rows.slice(2)
}

/** Build the S12 planning data from the roster and authoritative default-show pools. */
export function generateSeason(readme: string): SeasonData {
  const pools = table(readme, 'A match is a five-round show')
  const stages = STAGE_IDS.map(stage => {
    const row = required(pools.find(row => row[0].split(' /')[0].toLowerCase() === stage.toLowerCase()), `${stage} pool`)
    return { stage, usual: Number(required(row[1].match(/^\d+/), `${stage} entry count`)[0]), ids: Array.from(row[2].matchAll(/\b(?:C1|C2|[A-Q])\b/g), match => match[0]) }
  })
  const maps: SeasonMap[] = table(readme, 'Season roster').map(row => {
    const [label, type, , length, , , , players] = row
    const id = required(label.match(/^([A-Z][12]?)\s*\//), 'roster id')[1]
    const name = required(label.match(/\[([^\]]+)\]\([^)]+\)/), `${id} name`)[1]
    const slug = kebab(name)
    const course = `s1-${id.toLowerCase()}-${slug}`
    const typeName = type.split('/')[0].trim()
    const kind = ({ Team: 'team', Race: 'race', Survival: 'survival', Collection: 'collection', Hunt: 'hunt', Logic: 'logic', FINAL: 'final', 'FINAL-only': 'final' } as Record<string, RoundKind>)[typeName]
    required(kind, `${id} supported Type`)
    const family = kebab(required(type.split('/')[1], `${id} family`).split(';')[0])
    const cap = length.match(/\bcap\s+(\d+)/)
    const seconds = [...length.matchAll(/(\d+)\s+s\b/g)].map(match => Number(match[1]))
    const timeCapS = cap ? Number(cap[1]) : Math.max(...seconds)
    const eligible = stages.filter(stage => stage.ids.includes(id))
    const team = kind === 'team' ? required(players.match(/2\s*×\s*(\d+)\s+max;\s*usual\s+2\s*×\s*(\d+)/), `${id} teams`) : null
    const link = (title: string): string => `docs/level-plans/${required(label.match(new RegExp(`\\[${title}\\]\\(([^)]+)\\)`)), `${id} ${title} link`)[1]}`
    return {
      id, slug, name, course, kind,
      finalRule: kind === 'survival' && /\bFINAL\b/.test(type) ? 'lastStanding' : id === 'Q' ? 'crown' : null,
      family, stages: eligible.map(entry => entry.stage), capacity: 60, usual: eligible.map(entry => entry.usual),
      teams: team ? { count: 2, maxPerTeam: Number(team[1]), usualPerTeam: Number(team[2]) } : null,
      timeCapS, overtimeS: kind === 'team' ? 20 : kind === 'survival' || id === 'Q' ? 30 : 0,
      plan: link('SVG'), assets: link('needs'),
      files: { course: `courses/${course}.course.json`, zones: `courses/${course}.zones.json` }, status: 'planned', reason: null,
    }
  })
  const cut = required(readme.match(/short ([A-Z][12]?) or ([A-Z][12]?) cut/), 'short cut maps')
  return parseSeason({
    format: SEASON_FORMAT, version: SEASON_VERSION, id: 's1-sugarcloud-showdown',
    name: required(readme.match(/^# .*Season 1: (.+)$/m), 'season name')[1], world: 'candy',
    plans: { default: [60, 40, 24, 12, 6, 1], long: [60, 48, 36, 24, 12, 6, 1] },
    rules: { maxTeamRoundsPerShow: 1, finalReservedFirst: true, noBackToBack: [['H', 'I'], ['D', 'G']], cutMaps: cut.slice(1, 3), floor: { final: 2, race: 4, survivalOrScore: 3, team: 1 } },
    maps,
  }, source)
}

/** First differing JSON pointer, excluding only the per-map build metadata. */
export function seasonDifference(committed: SeasonData, generated: SeasonData): string | null {
  const comparable = (season: SeasonData) => ({ ...season, maps: season.maps.map(({ status, reason, files, ...map }) => map) })
  function difference(a: unknown, b: unknown, pointer: string): string | null {
    if (a === b) return null
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object' || Array.isArray(a) !== Array.isArray(b)) return pointer
    const left = a as Record<string, unknown>, right = b as Record<string, unknown>
    for (const key of new Set([...Object.keys(left), ...Object.keys(right)])) {
      const path = `${pointer}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`
      if (!(key in left) || !(key in right)) return path
      const result = difference(left[key], right[key], path)
      if (result !== null) return result
    }
    return null
  }
  return difference(comparable(committed), comparable(generated), '')
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2)
    if (args.length !== 1 || !['--write', '--check'].includes(args[0])) throw new Error('Usage: node --experimental-strip-types tools/seasonGen.ts [--write | --check]')
    const root = fileURLToPath(new URL('../', import.meta.url))
    const generated = generateSeason(readFileSync(resolve(root, source), 'utf8'))
    const target = resolve(root, 'courses/season.json')
    if (args[0] === '--write') writeFileSync(target, `${JSON.stringify(generated, null, 2)}\n`)
    else {
      const committed = parseSeason(JSON.parse(readFileSync(target, 'utf8')), 'courses/season.json')
      const pointer = seasonDifference(committed, generated)
      if (pointer !== null) throw new Error(`courses/season.json#${pointer}: differs from ${source}; fix: regenerate with --write`)
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exitCode = 1
  }
}
