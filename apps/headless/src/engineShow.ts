// Headless engine-show runner: loads the authored show content and compiled publication, drives a
// local authoritative show to its confirmed final result and prints the decoded outcome.
import { realpathSync } from 'node:fs'
import { readFile, readdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { loadEngine } from '@etcito/game-engine'
import type { EngineInstance } from '@etcito/game-engine/loader'
import { schemaLayout } from '@etcito/game-engine/script'
import type { CourseV1, ResolvedGameAsset } from '@royal-fiesta/game/courseV1'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { createEngineShow } from '@royal-fiesta/game/ege/showRuntime'
import type { EngineShowConfig, EngineShowSnapshot, EngineShowRuntime } from '@royal-fiesta/game/ege/showTypes'
import { showMaps } from '@royal-fiesta/game/net/zoneRounds'
import { parseSeason, playableMaps } from '@royal-fiesta/game/season'
import { levelOf } from '@royal-fiesta/sim/course'
import { NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import type { SchedMap } from '@royal-fiesta/sim/season/scheduler'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { repoRoot } from '../../../tools/bricks.ts'
import { createRfPublicationManager } from '../../../tools/egeScripts.ts'
import type { EngineModuleIdentity } from '../../../tools/egeScripts.ts'
import { loadCourseV1File, nodeGameAssets } from './contentFiles.ts'
import { readRepoText, repoPath } from './files.ts'

const COURSE_SUFFIX = '.course.json'
const DEFAULT_PLAN = [60, 40, 24, 12, 6, 1] as const
const MAX_ROOM_SEAT = 59
const USAGE = 'usage: engine-show [--seed n] [--seats 60] [--humans 0,2] [--plan 60,24,6,1] '
  + '[--test] [--dir courses] [--season courses/season.json] [--max-frames n] [--progress]'

/** What the runner loads or receives before it constructs the authoritative show. */
export interface EngineShowContent {
  readonly courses: readonly CourseV1[]
  readonly assets: ReadonlyMap<string, ResolvedGameAsset>
  readonly zones: ReadonlyMap<string, ZonesFile>
  readonly season: readonly SchedMap[]
}

export interface EngineShowRunOptions {
  seed?: number
  seats?: number
  humans?: readonly boolean[]
  plan?: readonly number[]
  testMode?: boolean
  dir?: string
  seasonPath?: string
  maxFrames?: number
  progress?: boolean
  sample?: (roomSeat: number, snapshot: EngineShowSnapshot) => number
  log?: (line: string) => void
  /** Skips content loading when a validated show configuration is already prepared. */
  config?: EngineShowConfig
}

export interface EngineShowRunResult {
  readonly seed: number
  readonly seats: number
  readonly humans: readonly boolean[]
  readonly testMode: boolean
  readonly identity: EngineModuleIdentity
  readonly snapshot: EngineShowSnapshot
  readonly frames: number
}

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function nonNegativeInteger(value: unknown, path: string, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > max) {
    refuse('engine-show', path, `${String(value)} is not an integer in 0..${max}; pass a whole number`)
  }
  return value
}

/** The default plan for a smaller roster keeps the authored head counts that still fit. */
function planFor(seats: number): number[] {
  return [seats, ...DEFAULT_PLAN.filter(nominal => nominal < seats)]
}

function validateHumans(humans: readonly boolean[]): void {
  if (!Array.isArray(humans) || humans.length < 2 || humans.length > MAX_ROOM_SEAT + 1) {
    refuse('engine-show', 'seats', `${humans?.length ?? 0} seats; a show needs between 2 and ${MAX_ROOM_SEAT + 1} configured room seats`)
  }
  for (let room = 0; room < humans.length; room++) {
    if (typeof humans[room] !== 'boolean') refuse('engine-show', `humans/${room}`, 'must be a boolean; mark each room seat human or bot')
  }
}

function validatePlan(plan: readonly number[] | undefined, seats: number): void {
  if (plan === undefined) return
  if (!Array.isArray(plan) || plan.length === 0) refuse('engine-show', 'plan', 'is empty; pass the nominal head counts')
  for (let i = 0; i < plan.length; i++) {
    if (typeof plan[i] !== 'number' || !Number.isInteger(plan[i]) || plan[i] < 1) {
      refuse('engine-show', `plan/${i}`, `${String(plan[i])} is not a positive integer; pass nominal head counts`)
    }
  }
  if (plan[0] !== seats) refuse('engine-show', 'plan/0', `${plan[0]} differs from the ${seats} configured seats; start the plan at the roster size`)
}

function validateConfig(config: EngineShowConfig): void {
  if (!config || typeof config !== 'object') refuse('engine-show', 'config', 'missing show configuration; load content or pass a prepared config')
  nonNegativeInteger(config.seed, 'seed', 0xffffffff)
  validateHumans(config.humans)
  validatePlan(config.plan, config.humans.length)
  if (config.testMode !== undefined && typeof config.testMode !== 'boolean') {
    refuse('engine-show', 'testMode', 'must be a boolean; pass true for minimum presentation durations')
  }
  if (!Array.isArray(config.courses) || config.courses.length === 0) {
    refuse('engine-show', 'courses', 'is empty; load playable course content before running a show')
  }
  if (!Array.isArray(config.season) || config.season.length === 0) {
    refuse('engine-show', 'season', 'is empty; load the committed season maps before running a show')
  }
  if (!config.identity || config.identity.backend !== 'engine' || !config.identity.moduleKey) {
    refuse('engine-show', 'identity', 'missing an engine publication identity; use the compiled script publication')
  }
}

async function courseFiles(dir: string): Promise<string[]> {
  let entries
  try {
    entries = await readdir(repoPath(dir), { withFileTypes: true })
  } catch (error) {
    refuse('engine-show', dir, `cannot list the course directory: ${(error as Error).message}; pass --dir <courses folder>`)
  }
  const files = entries.filter(entry => entry.isFile() && entry.name.endsWith(COURSE_SUFFIX))
    .map(entry => `${dir}/${entry.name}`)
  files.sort(byCodeUnit)
  if (files.length === 0) refuse('engine-show', dir, `contains no ${COURSE_SUFFIX} files; pass --dir with authored show courses`)
  return files
}

async function optionalText(rel: string): Promise<string | null> {
  try {
    return await readFile(repoPath(rel), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
    refuse('engine-show', rel, `cannot read: ${(error as Error).message}; check the path and permissions`)
  }
}

function zonesReader(dir: string): (rel: string) => Promise<string> {
  return rel => readRepoText(rel.startsWith('courses/') ? `${dir}/${rel.slice('courses/'.length)}` : rel)
}

/** The authored course, asset, zone and season content of one show directory. */
export async function loadEngineShowContent(dir = 'courses', seasonPath?: string): Promise<EngineShowContent> {
  const loaded: CourseV1[] = []
  for (const rel of await courseFiles(dir)) loaded.push(await loadCourseV1File(rel))
  const courses = loaded.filter(course => course.sim !== null)
  if (courses.length === 0) {
    refuse('engine-show', dir, 'has no playable course with simulation data; add a race, survival or show course')
  }
  const resolver = nodeGameAssets()
  const assets = new Map<string, ResolvedGameAsset>()
  for (const course of courses) {
    for (const id of course.assetIds) {
      if (!assets.has(id)) assets.set(id, await resolver.resolve(id))
    }
  }
  const seasonRel = seasonPath ?? `${dir}/season.json`
  const text = await optionalText(seasonRel)
  let season: SchedMap[]
  if (text === null) {
    season = showMaps(courses.map(course => course.sim!))
    if (season.length === 0) refuse('engine-show', dir, 'has no playable show courses; add a course or pass --season')
  } else {
    let json: unknown
    try {
      json = JSON.parse(text)
    } catch (error) {
      refuse('engine-show', seasonRel, `is not valid JSON: ${(error as Error).message}; fix the season file`)
    }
    const data = parseSeason(json, seasonRel)
    const loadedIds = new Set(courses.map(course => course.id))
    for (const map of playableMaps(data)) {
      if (!loadedIds.has(map.course)) {
        refuse('engine-show', seasonRel, `built map '${map.id}' needs '${map.course}'; add that course to ${dir}`)
      }
    }
    season = showMaps(courses.map(course => course.sim!), data)
    if (season.length === 0) refuse('engine-show', seasonRel, 'has no built map whose course is loaded; add the course or fix the season status')
  }
  const zones = new Map<string, ZonesFile>()
  const reader = zonesReader(dir)
  for (const course of courses) zones.set(course.id, await loadZonesFile(course.id, course.sim!, reader))
  return { courses, assets, zones, season }
}

/** The latest runnable compiler publication, its exact bytes and the identity they were published under. */
async function preparePublication(): Promise<{ bytes: Uint8Array<ArrayBuffer>; identity: EngineModuleIdentity }> {
  const manager = createRfPublicationManager({ dir: path.join(repoRoot(), 'out', 'ege') })
  try {
    await manager.request()
    const publication = await manager.read()
    const bytes = manager.wasmFor(publication.revision)
    if (!bytes) {
      refuse('engine-show', 'publication', 'the compiler published no runnable bytes; run npm run ege:build and fix the reported script errors')
    }
    return {
      bytes: new Uint8Array(bytes),
      identity: { backend: 'engine', schemaKey: publication.schemaKey, moduleKey: publication.moduleKey },
    }
  } catch (error) {
    if (isRefusal(error)) throw error
    refuse('engine-show', 'publication', `${(error as Error).message}; run npm run ege:build or fix scripts/ege`)
  }
}

function sampleOf(options: EngineShowRunOptions): (roomSeat: number, snapshot: EngineShowSnapshot) => number {
  if (options.sample !== undefined) return options.sample
  return () => NEUTRAL_CODE
}

/** A generous tick budget from the authored caps and presentation durations; a stall refuses instead of looping. */
function frameLimit(config: EngineShowConfig): number {
  let cap = 0
  for (const course of config.courses) {
    if (course.sim === null) continue
    const level = levelOf(course.sim)
    cap = Math.max(cap, level.timeCapTicks + level.overtimeTicks)
  }
  if (cap === 0) cap = 3600
  const rounds = (config.plan ?? DEFAULT_PLAN).length + 6
  const presentation = config.testMode === true ? 3 : 300 + 90 + 150
  return rounds * (cap + PROFILES.sprint.introTicks + presentation + 600) + 3600
}

function printResult(log: (line: string) => void, result: EngineShowRunResult): void {
  const snapshot = result.snapshot
  log(`[engine-show] seed=${result.seed} seats=${result.seats} testMode=${result.testMode} `
    + `module=${result.identity.moduleKey} tick=${snapshot.tick} rounds=${snapshot.results.length} faults=${snapshot.faults}`)
  const final = snapshot.results.at(-1)
  if (final !== undefined) log(`[engine-show] final ${JSON.stringify(final)}`)
  log(`[engine-show] champion=${snapshot.champion}`)
}

/**
 * Drives a local authoritative show until its confirmed final result. The caller supplies content
 * either as a prepared config or through `loadEngineShowContent`; the runner votes nothing (abstentions
 * resolve deterministically), fails on script faults or a stalled show and returns only after `done`
 * with a confirmed champion.
 */
export async function runEngineShow(options: EngineShowRunOptions = {}): Promise<EngineShowRunResult> {
  const log = options.log ?? ((line: string) => console.log(line))
  let config = options.config
  if (config === undefined) {
    const seats = options.seats ?? 60
    if (!Number.isInteger(seats) || seats < 2 || seats > MAX_ROOM_SEAT + 1) {
      refuse('engine-show', 'seats', `${String(seats)} is not an integer in 2..${MAX_ROOM_SEAT + 1}; pass the configured roster size`)
    }
    const humans = options.humans ?? new Array<boolean>(seats).fill(false)
    validateHumans(humans)
    if (humans.length !== seats) refuse('engine-show', 'humans', `${humans.length} flags for ${seats} seats; give one flag per room seat`)
    if (options.seed !== undefined) nonNegativeInteger(options.seed, 'seed', 0xffffffff)
    const seed = options.seed ?? 7
    const content = await loadEngineShowContent(options.dir ?? 'courses', options.seasonPath)
    const engine = await loadEngine()
    const schemaText = await readRepoText(RF_EGE_SCHEMA)
    engine.setSchema(schemaText)
    const publication = await preparePublication()
    const loadedKey = schemaLayout(engine).key
    if (publication.identity.schemaKey !== loadedKey) {
      refuse('engine-show', 'publication.schemaKey', `published ${publication.identity.schemaKey} but the loaded schema is ${loadedKey}; rebuild ege scripts against the current schema`)
    }
    config = {
      engine, schemaText, scriptBytes: publication.bytes, identity: publication.identity, seed,
      courses: content.courses, assets: content.assets, zones: content.zones, season: content.season,
      humans, plan: options.plan ?? planFor(seats), testMode: options.testMode === true,
    }
  }
  validateConfig(config)
  const sample = sampleOf(options)
  const maxFrames = options.maxFrames ?? frameLimit(config)
  let runtime: EngineShowRuntime
  try {
    runtime = await createEngineShow(config)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (isRefusal(error)) throw error
    refuse('engine-show', 'preparation', `${message}; fix the show content and the compiled scripts, then retry`)
  }
  try {
    for (let frames = 0; frames < maxFrames; frames++) {
      const snapshot = runtime.snapshot()
      if (snapshot.faults > 0) {
        refuse('engine-show', 'scripts', `the show reported ${snapshot.faults} script fault(s) at round ${snapshot.round} screen '${snapshot.screen}'; fix scripts/ege and rebuild`)
      }
      if (snapshot.screen === 'done') {
        if (snapshot.champion === null) {
          refuse('engine-show', 'champion', 'the show reached done without a confirmed champion; inspect the final round result')
        }
        const result: EngineShowRunResult = {
          seed: config.seed, seats: config.humans.length, humans: [...config.humans],
          testMode: config.testMode === true, identity: runtime.identity, snapshot, frames,
        }
        printResult(log, result)
        return result
      }
      runtime.frame(1 / 60, room => sample(room, snapshot))
      if (options.progress === true && (frames + 1) % 60 === 0) {
        console.error(`[engine-show] frame=${frames + 1} tick=${runtime.snapshot().tick} round=${runtime.snapshot().round} screen=${runtime.snapshot().screen}`)
      }
    }
    const snapshot = runtime.snapshot()
    refuse('engine-show', 'completion', `the show stalled at round ${snapshot.round} screen '${snapshot.screen}' after ${maxFrames} frames; raise --max-frames or inspect the content and scripts`)
  } finally {
    runtime.dispose()
  }
}

function humanFlags(seats: number, list: string | undefined): boolean[] {
  const humans = new Array<boolean>(seats).fill(false)
  if (list === undefined || list.length === 0) return humans
  for (const part of list.split(',')) {
    if (!/^\d+$/.test(part)) refuse('engine-show', '--humans', `'${part}' is not a room seat; use comma-separated seat numbers`)
    const room = Number(part)
    if (room > MAX_ROOM_SEAT || room >= seats) refuse('engine-show', '--humans', `room seat ${room} is outside the ${seats} configured seats`)
    if (humans[room]) refuse('engine-show', '--humans', `room seat ${room} is listed twice; keep each human seat once`)
    humans[room] = true
  }
  return humans
}

function numberFlag(value: string, name: string, max = Number.MAX_SAFE_INTEGER): number {
  if (!/^\d+$/.test(value)) refuse('engine-show', `--${name}`, `'${value}' is not a non-negative integer`)
  const parsed = Number(value)
  if (parsed > max) refuse('engine-show', `--${name}`, `${parsed} exceeds ${max}`)
  return parsed
}

/** Parses the product runner's arguments; invalid values refuse before any content is loaded. */
export function parseEngineShowArgs(argv: readonly string[]): EngineShowRunOptions {
  let values
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: {
        seed: { type: 'string' },
        seats: { type: 'string', default: '60' },
        humans: { type: 'string' },
        plan: { type: 'string' },
        test: { type: 'boolean', default: false },
        dir: { type: 'string', default: 'courses' },
        season: { type: 'string' },
        'max-frames': { type: 'string' },
        progress: { type: 'boolean', default: false },
        help: { type: 'boolean', default: false },
      },
    }))
  } catch (error) {
    refuse('engine-show', 'arguments', `${(error as Error).message}; ${USAGE}`)
  }
  if (values.help === true) refuse('engine-show', '--help', USAGE)
  const seats = numberFlag(values.seats, 'seats', MAX_ROOM_SEAT + 1)
  if (seats < 2) refuse('engine-show', '--seats', `${seats} seat(s); a show needs at least 2 configured seats`)
  const maxFrames = values['max-frames'] === undefined ? undefined : numberFlag(values['max-frames'], 'max-frames')
  if (maxFrames === 0) refuse('engine-show', '--max-frames', '0 frames cannot complete a show; pass a positive frame budget')
  const options: EngineShowRunOptions = {
    seed: values.seed === undefined ? undefined : numberFlag(values.seed, 'seed', 0xffffffff),
    seats,
    humans: humanFlags(seats, values.humans),
    testMode: values.test === true,
    dir: values.dir,
    seasonPath: values.season,
    maxFrames,
    progress: values.progress === true,
  }
  if (values.plan !== undefined) {
    options.plan = values.plan.split(',').map(part => {
      const nominal = numberFlag(part, 'plan')
      if (nominal < 1) refuse('engine-show', '--plan', `${nominal} is not a positive integer; pass nominal head counts`)
      return nominal
    })
  }
  return options
}

async function runCli(argv: readonly string[]): Promise<number> {
  try {
    await runEngineShow(parseEngineShowArgs(argv))
    return 0
  } catch (error) {
    if (isRefusal(error)) {
      console.error(error.message)
      return 1
    }
    const seen = new Set<unknown>()
    let cause: unknown = error
    while (cause !== undefined && !seen.has(cause)) {
      seen.add(cause)
      const err = cause instanceof Error ? cause : new Error(String(cause))
      console.error(`[engine-show] error: ${err.message}`)
      if (err.stack) console.error(err.stack)
      cause = err.cause
    }
    return 1
  }
}

function isMain(): boolean {
  const argv = process.argv[1]
  if (argv === undefined) return false
  try {
    return realpathSync(path.resolve(argv)) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

if (isMain()) {
  Error.stackTraceLimit = Infinity
  process.exitCode = await runCli(process.argv.slice(2))
}
