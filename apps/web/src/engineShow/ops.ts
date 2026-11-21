import type { CaptureResult } from '../../../../tools/engineCaptureJob.ts'
import type { EngineShowPage, EnginePageState } from './page.ts'
import { BTN, NEUTRAL_CODE } from '@royal-fiesta/sim/input'

/** One managed scenario: it receives the ready page and its typed inventory arguments. */
export type EngineShowScenario = (page: EngineShowPage, args: Readonly<Record<string, unknown>>) => Promise<CaptureResult>

/** The three offline scenarios this milestone ships; later scenario modules register their own ids. */
export const SHOW_SCENARIO_IDS = ['simple-engine-character', 'sixty-seat-engine-round', 'engine-show-winner-podium'] as const

const scenarios = new Map<string, EngineShowScenario>()

/** Registers a scenario once; a duplicate id or a malformed registration refuses before any capture runs. */
export function registerScenario(id: string, run: EngineShowScenario): void {
  if (typeof id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(id)) {
    throw new Error('[engine-show] scenario id must be a lowercase hyphenated identifier')
  }
  if (typeof run !== 'function') throw new Error('[engine-show] scenario runner must be a function')
  if (scenarios.has(id)) throw new Error(`[engine-show] duplicate scenario '${id}'`)
  scenarios.set(id, run)
}

/** The registered scenario ids, in registration order. */
export function scenarioIds(): readonly string[] {
  return [...scenarios.keys()]
}

/** The typed show arguments of one inventory row. */
export interface ShowArgs {
  scenario: string
  testMode: true
  seed: number
  humans: number
}

/**
 * Validates the show arguments; only scenario, testMode, seed and humans are accepted. The known set
 * defaults to the shipped scenario ids so a Node selection check can validate the inventory without a
 * browser page having registered its runners.
 */
export function parseShowArgs(value: unknown, known: ReadonlySet<string> = new Set(SHOW_SCENARIO_IDS)): ShowArgs {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('[engine-show] args must be an object')
  const args = value as Record<string, unknown>
  for (const key of Object.keys(args)) {
    if (!['scenario', 'testMode', 'seed', 'humans'].includes(key)) throw new Error(`[engine-show] args/${key} is unknown`)
  }
  if (typeof args.scenario !== 'string' || !known.has(args.scenario)) throw new Error('[engine-show] args/scenario is unknown')
  if (args.testMode !== true) throw new Error('[engine-show] args/testMode must be true')
  if (!Number.isSafeInteger(args.seed) || (args.seed as number) < 0) throw new Error('[engine-show] args/seed must be a non-negative integer')
  if (!Number.isInteger(args.humans) || (args.humans as number) < 1 || (args.humans as number) > 8) {
    throw new Error('[engine-show] args/humans must be between 1 and 8')
  }
  return { scenario: args.scenario, testMode: true, seed: args.seed as number, humans: args.humans as number }
}

/** One real local sample: the S1 code stored by the simulation and the local character's response. */
export interface LocalSample {
  readonly code: number
  readonly stored: number | null
  readonly before: readonly [number, number, number] | null
  readonly after: readonly [number, number, number] | null
  readonly mode: number
}

/** The exact G7-OFFLINE-FACTS shape returned by every offline scenario. */
export interface EngineShowFacts {
  backend: 'engine'
  seats: number
  humans: number
  bots: number
  faults: number
  gpuErrors: readonly string[]
  local: {
    sampledTicks: number
    neutralObserved: boolean
    positiveDirectionObserved: boolean
    negativeDirectionObserved: boolean
    jumpObserved: boolean
    diveObserved: boolean
    grabObserved: boolean
    positionChanged: boolean
  }
  botsMoved: number
  membership: { checks: number; nearSeats: number; farSeats: number; duplicateSeatIds: readonly number[] }
  progress: {
    completedRounds: number
    visitedCourseIds: readonly string[]
    distinctCourses: number
    confirmedWinner: number | null
    podiumConfirmed: boolean
  }
  effects: { droppedRecords: number; repeatedSoundDeliveries: number; repeatedGrantDeliveries: number }
}

/** The authoritative inputs a progress observation needs; no decision is recomputed here. */
export interface ProgressInput {
  readonly snapshot: {
    readonly round: number
    readonly results: readonly { readonly index: number; readonly course: string; readonly endTick: number; readonly champion: number }[]
    readonly champion: number | null
    readonly screen: string
  }
  readonly course: string | null
  readonly tick: number
}

const MOVED = 1e-3
const POSITIVE = 1e-3
const NEGATIVE = -1e-3

/**
 * Counts the G7-OFFLINE-FACTS observations from the real page. Every boolean is set only from an
 * observed S1 value or character/pose response; a zero count or a missing observation stays failing.
 */
export class ShowFactsCollector {
  private readonly config: { seats: number; humans: number; bots: number }
  private sampledTicks = 0
  private neutral = false
  private positive = false
  private negative = false
  private jump = false
  private dive = false
  private grab = false
  private changed = false
  private readonly bots = new Set<number>()
  private checks = 0
  private near = 0
  private far = 0
  private readonly duplicates = new Set<number>()
  private completed = 0
  private readonly courses: string[] = []
  private readonly courseOfRound = new Map<number, string>()
  private winner: number | null = null
  private podium = false
  private effectsSeen = false
  private dropped = 0
  private repeatedSound = 0
  private repeatedGrant = 0
  private faults = 0
  private readonly errors: string[] = []

  constructor(config: { seats: number; humans: number; bots: number }) {
    this.config = { ...config }
  }

  /** Records one actual sample of the mapped human and the response the authoritative state shows. */
  sample(input: LocalSample): void {
    this.sampledTicks++
    const stored = input.stored ?? input.code
    const dx = delta(input.before, input.after, 0)
    const dz = delta(input.before, input.after, 2)
    const moved = Math.hypot(dx, dz)
    if (stored === NEUTRAL_CODE && moved <= MOVED) this.neutral = true
    if (stored !== NEUTRAL_CODE) {
      const moveX = decodeAxis(stored & 0xff)
      const moveZ = decodeAxis((stored >>> 8) & 0xff)
      const positive = moveX > 0 || moveZ > 0
      const negative = moveX < 0 || moveZ < 0
      if (positive && (dx > POSITIVE || dz > POSITIVE)) this.positive = true
      if (negative && (dx < NEGATIVE || dz < NEGATIVE)) this.negative = true
      if ((positive || negative) && moved > MOVED) this.changed = true
    }
    if ((stored & BTN.JUMP) !== 0) this.jump = true
    if ((stored & BTN.DIVE) !== 0) this.dive = true
    if ((stored & BTN.GRAB) !== 0) this.grab = true
  }

  /** Adds one distinct bot room seat whose authoritative position changed while its controller acted. */
  botMoved(roomSeat: number): void {
    if (roomSeat >= this.config.humans) this.bots.add(roomSeat)
  }

  /** Counts one completed near/far submission audit and accumulates any seat drawn by both paths. */
  audit(near: Iterable<number>, far: Iterable<number>): void {
    const nearSet = new Set(near)
    const farSet = new Set(far)
    this.checks++
    this.near = nearSet.size
    this.far = farSet.size
    for (const seat of farSet) if (nearSet.has(seat)) this.duplicates.add(seat)
  }

  /** Copies authoritative confirmed progress; a course that disagrees with its confirmed result refuses. */
  progress(input: ProgressInput): void {
    const shown = input.course
    if (shown !== null && !this.courseOfRound.has(input.snapshot.round)) {
      this.courseOfRound.set(input.snapshot.round, shown)
      if (!this.courses.includes(shown)) this.courses.push(shown)
    }
    for (const result of input.snapshot.results) {
      const seen = this.courseOfRound.get(result.index)
      if (seen !== undefined && seen !== result.course) {
        throw new Error(`[engine-show] round ${result.index} played '${seen}' but confirmed '${result.course}'`)
      }
      this.courseOfRound.set(result.index, result.course)
      if (!this.courses.includes(result.course)) this.courses.push(result.course)
    }
    this.completed = input.snapshot.results.length
    this.winner = input.snapshot.champion
    if (input.snapshot.screen === 'podium' || input.snapshot.screen === 'done') {
      const champion = input.snapshot.champion
      const result = [...input.snapshot.results].reverse().find(item => item.champion === champion)
      this.podium = champion !== null && champion >= 0 && result !== undefined && input.tick > result.endTick
    }
  }

  /** Copies EngineShowEffects.deliveryStats(); the diagnostics stay counts, never booleans or lists. */
  effects(stats: { droppedRecords: number; repeatedSoundDeliveries: number; repeatedGrantDeliveries: number }): void {
    this.effectsSeen = true
    this.dropped = stats.droppedRecords
    this.repeatedSound = stats.repeatedSoundDeliveries
    this.repeatedGrant = stats.repeatedGrantDeliveries
  }

  scriptFaults(count: number): void {
    this.faults = count
  }

  gpuError(message: string): void {
    this.errors.push(message)
  }

  /** The number of distinct bot seats observed moving so far. */
  botCount(): number {
    return this.bots.size
  }

  /** True once the named local observation was actually seen. */
  observed(flag: 'neutral' | 'positive' | 'negative' | 'jump' | 'dive' | 'grab' | 'changed'): boolean {
    if (flag === 'neutral') return this.neutral
    if (flag === 'positive') return this.positive
    if (flag === 'negative') return this.negative
    if (flag === 'jump') return this.jump
    if (flag === 'dive') return this.dive
    if (flag === 'grab') return this.grab
    return this.changed
  }

  /** The current facts; reading throws when the effect diagnostics were never observed. */
  facts(): EngineShowFacts {
    if (!this.effectsSeen) throw new Error('[engine-show] effect delivery diagnostics were not observed; pump the effects')
    return {
      backend: 'engine',
      seats: this.config.seats,
      humans: this.config.humans,
      bots: this.config.bots,
      faults: this.faults,
      gpuErrors: [...this.errors],
      local: {
        sampledTicks: this.sampledTicks,
        neutralObserved: this.neutral,
        positiveDirectionObserved: this.positive,
        negativeDirectionObserved: this.negative,
        jumpObserved: this.jump,
        diveObserved: this.dive,
        grabObserved: this.grab,
        positionChanged: this.changed,
      },
      botsMoved: this.bots.size,
      membership: {
        checks: this.checks,
        nearSeats: this.near,
        farSeats: this.far,
        duplicateSeatIds: [...this.duplicates].sort((a, b) => a - b),
      },
      progress: {
        completedRounds: this.completed,
        visitedCourseIds: [...this.courses],
        distinctCourses: this.courses.length,
        confirmedWinner: this.winner,
        podiumConfirmed: this.podium,
      },
      effects: {
        droppedRecords: this.dropped,
        repeatedSoundDeliveries: this.repeatedSound,
        repeatedGrantDeliveries: this.repeatedGrant,
      },
    }
  }
}

function delta(before: readonly [number, number, number] | null, after: readonly [number, number, number] | null, axis: number): number {
  if (before === null || after === null) return 0
  return after[axis] - before[axis]
}

function decodeAxis(byte: number): number {
  return (Math.min(byte, 254) - 127) / 127
}

/** Common requirements copied verbatim into every offline inventory row. */
export const SHOW_COMMON_REQUIRE: readonly string[] = [
  'backend eq "engine"',
  'seats eq 60',
  'humans eq 1',
  'bots eq 59',
  'faults eq 0',
  'gpuErrors empty',
  'local.sampledTicks gt 0',
  'effects.droppedRecords eq 0',
  'effects.repeatedSoundDeliveries eq 0',
  'effects.repeatedGrantDeliveries eq 0',
]

/** The simple character's additional functional requirements. */
export const SIMPLE_REQUIRE: readonly string[] = [
  ...SHOW_COMMON_REQUIRE,
  'local.neutralObserved eq true',
  'local.positiveDirectionObserved eq true',
  'local.negativeDirectionObserved eq true',
  'local.jumpObserved eq true',
  'local.diveObserved eq true',
  'local.grabObserved eq true',
  'local.positionChanged eq true',
  'membership.checks gt 0',
  'membership.duplicateSeatIds empty',
]

/** The sixty-seat round's additional requirements. */
export const ROUND_REQUIRE: readonly string[] = [
  ...SHOW_COMMON_REQUIRE,
  'local.positionChanged eq true',
  'botsMoved gt 0',
  'membership.checks gt 0',
  'membership.nearSeats gt 0',
  'membership.farSeats gt 0',
  'membership.duplicateSeatIds empty',
  'progress.distinctCourses ge 1',
]

/** The confirmed winner podium's additional requirements. */
export const PODIUM_REQUIRE: readonly string[] = [
  ...SHOW_COMMON_REQUIRE,
  'local.positionChanged eq true',
  'botsMoved gt 0',
  'membership.checks gt 0',
  'membership.duplicateSeatIds empty',
  'progress.completedRounds ge 2',
  'progress.distinctCourses ge 2',
  'progress.confirmedWinner ge 0',
  'progress.podiumConfirmed eq true',
]

/** The exact require list of each shipped scenario id. */
export const SHOW_SCENARIO_REQUIRE: Readonly<Record<string, readonly string[]>> = {
  'simple-engine-character': SIMPLE_REQUIRE,
  'sixty-seat-engine-round': ROUND_REQUIRE,
  'engine-show-winner-podium': PODIUM_REQUIRE,
}

/** Installs the engineShow operation immediately; the call awaits the mounted, prepared page. */
export function registerEngineShowOps(page: Promise<EngineShowPage>): void {
  const target = window as unknown as { nmcGpu: { ops: Record<string, (input: unknown) => Promise<unknown>> } }
  target.nmcGpu = { ops: { engineShow: input => runShowOperation(page, input) } }
}

/** Runs one registered scenario after the page promise and its readiness boundary settle. */
export async function runShowOperation(page: Promise<EngineShowPage>, input: unknown): Promise<{ json: CaptureResult; files: [] }> {
  const args = parseShowArgs(input, new Set(scenarios.keys()))
  const run = scenarios.get(args.scenario)
  if (run === undefined) throw new Error(`[engine-show] scenario '${args.scenario}' is not registered`)
  const mounted = await page
  await mounted.ready
  const errors: string[] = []
  const onError = (event: ErrorEvent): void => { errors.push(event.message || String(event.error)) }
  const onRejection = (event: PromiseRejectionEvent): void => { errors.push(String(event.reason)) }
  if (typeof window !== 'undefined') {
    window.addEventListener('error', onError)
    window.addEventListener('unhandledrejection', onRejection as EventListener)
  }
  try {
    const result = await run(mounted, { ...args })
    const facts = result.facts !== null && typeof result.facts === 'object' ? result.facts as Record<string, unknown> : {}
    return { json: { facts: { ...facts, gpuErrors: errors }, capture: result.capture }, files: [] }
  } finally {
    if (typeof window !== 'undefined') {
      window.removeEventListener('error', onError)
      window.removeEventListener('unhandledrejection', onRejection as EventListener)
    }
  }
}

/** The current page state for a scenario's settle checks (a stable signal, not a timing sleep). */
export function readyState(page: EngineShowPage): EnginePageState {
  return page.state()
}
