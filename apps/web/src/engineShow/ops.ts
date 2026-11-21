import type { CaptureResult } from '../../../../tools/engineCaptureJob.ts'
import type { EngineShowPage, EnginePageState } from './page.ts'
import { BTN, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { checkPhase } from '../game/checkProgress.ts'
import type { EngineShowPresentation } from '@royal-fiesta/game/ege/showTypes'

/** Ticks between two page bot checks: bot movement is compared between consecutive checks. */
export const BOT_CHECK_TICKS = 30

/** True on the post-tick observations where the page runs a bot check. */
export function isBotCheckTick(tick: number): boolean {
  return tick % BOT_CHECK_TICKS === 0
}

/** Reads every live seat's engine position (room seat -> x,y,z) from the worlds' far streams. */
export function showSeatPoses(presentation: EngineShowPresentation, seats: number): Map<number, readonly [number, number, number]> {
  const poses = new Map<number, readonly [number, number, number]>()
  for (const world of presentation.worlds) {
    let bytes: Uint8Array
    try { bytes = world.farSnapshot() } catch { continue }
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    const count = view.getUint16(0, true)
    for (let i = 0; i < count; i++) {
      const at = 2 + i * 60
      const zone = view.getUint32(at, true)
      if (zone < 1 || zone > seats) continue
      poses.set(zone - 1, [view.getFloat64(at + 4, true), view.getFloat64(at + 12, true), view.getFloat64(at + 20, true)])
    }
  }
  return poses
}

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
  /** Nominal head counts for EngineShowConfig.plan; absent keeps the scenario's own plan. */
  plan?: readonly number[]
}

/**
 * The show plan the confirmed-podium scenario remounts with when its row names none: three real rounds
 * (sixty seats, a cut to twelve, the final) instead of the default six, so the whole show fits one GPU job.
 * No other scenario changes the plan.
 */
export const PODIUM_PLAN: readonly number[] = [60, 12, 1]

/**
 * Validates the show arguments; only scenario, testMode, seed, humans and an optional plan are accepted. The known set
 * defaults to the shipped scenario ids so a Node selection check can validate the inventory without a
 * browser page having registered its runners.
 */
export function parseShowArgs(value: unknown, known: ReadonlySet<string> = new Set(SHOW_SCENARIO_IDS)): ShowArgs {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('[engine-show] args must be an object')
  const args = value as Record<string, unknown>
  for (const key of Object.keys(args)) {
    if (!['scenario', 'testMode', 'seed', 'humans', 'plan'].includes(key)) throw new Error(`[engine-show] args/${key} is unknown`)
  }
  if (typeof args.scenario !== 'string' || !known.has(args.scenario)) throw new Error('[engine-show] args/scenario is unknown')
  if (args.testMode !== true) throw new Error('[engine-show] args/testMode must be true')
  if (!Number.isSafeInteger(args.seed) || (args.seed as number) < 0) throw new Error('[engine-show] args/seed must be a non-negative integer')
  if (!Number.isInteger(args.humans) || (args.humans as number) < 1 || (args.humans as number) > 8) {
    throw new Error('[engine-show] args/humans must be between 1 and 8')
  }
  const parsed: ShowArgs = { scenario: args.scenario, testMode: true, seed: args.seed as number, humans: args.humans as number }
  if (args.plan === undefined) return parsed
  const plan = args.plan
  if (!Array.isArray(plan) || plan.length < 2 || plan.some(count => !Number.isInteger(count) || count < 1)
    || plan.some((count, i) => i > 0 && count >= plan[i - 1]) || plan[plan.length - 1] !== 1) {
    throw new Error('[engine-show] args/plan must list strictly decreasing positive head counts ending at 1')
  }
  return { ...parsed, plan: [...plan] as number[] }
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

  private botPoses: ReadonlyMap<number, readonly [number, number, number]> = new Map()

  /** Compares bot positions with the previous call of this method only, never with per-tick local samples. */
  observeBots(poses: ReadonlyMap<number, readonly [number, number, number]>): void {
    for (const [seat, pos] of poses) {
      const prior = this.botPoses.get(seat)
      if (prior !== undefined && Math.hypot(pos[0] - prior[0], pos[2] - prior[2]) > 0.1) this.botMoved(seat)
    }
    this.botPoses = poses
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

/** Every page failure seen since the watch started: console.error text, uncaught errors, rejections and failed loads. */
export interface ShowErrorWatch {
  errors(): string[]
  stop(): void
}

interface ErrorSources {
  console?: { error: (...values: unknown[]) => void }
  window?: {
    addEventListener: (type: string, listener: (event: never) => void, capture?: boolean) => void
    removeEventListener: (type: string, listener: (event: never) => void, capture?: boolean) => void
  }
}

const ERROR_LIMIT = 200

function errorText(value: unknown): string {
  if (value instanceof Error) return value.message
  if (typeof value === 'string') return value
  try { return JSON.stringify(value) ?? String(value) } catch { return String(value) }
}

/**
 * Records the page's failures instead of stopping at the first one: each console.error line, uncaught error,
 * unhandled rejection and failed resource load is kept once, in order, and reaches the facts as `gpuErrors`.
 */
export function watchShowErrors(sources: ErrorSources = {
  console: typeof console === 'undefined' ? undefined : console,
  window: typeof window === 'undefined' ? undefined : window as unknown as ErrorSources['window'],
}): ShowErrorWatch {
  const seen: string[] = []
  const note = (message: string): void => {
    if (seen.length < ERROR_LIMIT && !seen.includes(message)) seen.push(message)
  }
  const target = sources.console
  const original = target?.error
  const patched = (...values: unknown[]): void => {
    note(`console.error: ${values.map(errorText).join(' ')}`)
    original?.apply(target, values)
  }
  if (target !== undefined) target.error = patched
  const onError = (event: { message?: unknown; error?: unknown; target?: unknown }): void => {
    const source = event.target as { src?: unknown; href?: unknown; tagName?: unknown } | null | undefined
    const failedLoad = source !== null && typeof source === 'object' && typeof source.tagName === 'string'
    if (failedLoad) note(`failed load: ${String(source.tagName).toLowerCase()} ${String(source.src ?? source.href ?? '')}`)
    else note(`error: ${typeof event.message === 'string' && event.message !== '' ? event.message : errorText(event.error)}`)
  }
  const onRejection = (event: { reason?: unknown }): void => { note(`unhandled rejection: ${errorText(event.reason)}`) }
  sources.window?.addEventListener('error', onError as (event: never) => void, true)
  sources.window?.addEventListener('unhandledrejection', onRejection as (event: never) => void)
  return {
    errors: () => [...seen],
    stop(): void {
      if (target !== undefined && target.error === patched && original !== undefined) target.error = original
      sources.window?.removeEventListener('error', onError as (event: never) => void, true)
      sources.window?.removeEventListener('unhandledrejection', onRejection as (event: never) => void)
    },
  }
}

/** The page clock time (ms since navigation) after which a scenario fails itself with its position named. */
export const SHOW_PAGE_BUDGET_MS = 270_000
const SHOW_SLICE_MS = 100
const TIMER_YIELD_MS = 2000

/** Paces a scenario's fixed simulation ticks so the page keeps answering between them. */
export interface ShowPacer {
  /** Call after every simulated tick; `where` names the authoritative position for progress and failures. */
  tick(where: () => string): Promise<void>
}

function nextTask(): Promise<void> {
  if (typeof MessageChannel === 'undefined') return new Promise(resolve => { setTimeout(resolve, 0) })
  return new Promise(resolve => {
    const channel = new MessageChannel()
    channel.port1.onmessage = () => { channel.port1.close(); resolve() }
    channel.port2.postMessage(0)
  })
}

/**
 * The simulation keeps its fixed tick and order; only wall time is sliced. After each slice the pacer publishes
 * the scenario's position as the page progress, yields one task (a timer task every two seconds, since
 * requestAnimationFrame is suspended in the capture frame) and refuses once the page clock passes the budget,
 * naming the scenario, the position and the measured tick rate instead of a silent job timeout.
 */
export function createShowPacer(scenario: string, options: {
  sliceMs?: number
  budgetMs?: number
  now?: () => number
  yieldTask?: (timer: boolean) => Promise<void>
  phase?: (text: string) => void
} = {}): ShowPacer {
  const now = options.now ?? (() => performance.now())
  const sliceMs = options.sliceMs ?? SHOW_SLICE_MS
  const budgetMs = options.budgetMs ?? SHOW_PAGE_BUDGET_MS
  const phase = options.phase ?? checkPhase
  const yieldTask = options.yieldTask ?? (timer => timer ? new Promise<void>(resolve => { setTimeout(resolve, 0) }) : nextTask())
  const started = now()
  let sliceStart = started
  let timerAt = started
  let ticks = 0
  return {
    async tick(where) {
      ticks++
      const at = now()
      if (at - sliceStart < sliceMs) return
      const rate = Math.round(ticks * 1000 / Math.max(1, at - started))
      const position = `${where()}; ${ticks} ticks stepped at ${rate} ticks/s`
      phase(`engine-show: ${scenario}: ${position}`)
      if (at > budgetMs) {
        throw new Error(`[engine-show] ${scenario} passed its ${Math.round(budgetMs / 1000)} s page budget at ${position}; `
          + 'the scenario needs fewer simulated ticks or a faster tick to finish inside one GPU job')
      }
      const timer = at - timerAt >= TIMER_YIELD_MS
      if (timer) timerAt = at
      await yieldTask(timer)
      sliceStart = now()
    },
  }
}

let pageWatch: ShowErrorWatch | null = null

/**
 * Installs the engineShow operation immediately; the call awaits the mounted, prepared page. The failure watch
 * starts here, before any loading, so startup diagnostics reach every capture's `gpuErrors`.
 */
export function registerEngineShowOps(page: Promise<EngineShowPage>): void {
  pageWatch ??= watchShowErrors()
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
  const watch = pageWatch ?? watchShowErrors()
  try {
    checkPhase(`engine-show: ${args.scenario}`)
    const result = await run(mounted, { ...args })
    const facts = result.facts !== null && typeof result.facts === 'object' ? result.facts as Record<string, unknown> : {}
    return { json: { facts: { ...facts, gpuErrors: watch.errors() }, capture: result.capture }, files: [] }
  } catch (error) {
    // A failed scenario still reports everything the page logged, so one pass names every cause.
    const seen = watch.errors()
    if (seen.length === 0) throw error
    throw new Error(`${error instanceof Error ? error.message : String(error)} | page errors: ${seen.join(' | ')}`, { cause: error })
  } finally {
    if (watch !== pageWatch) watch.stop()
  }
}

/** The current page state for a scenario's settle checks (a stable signal, not a timing sleep). */
export function readyState(page: EngineShowPage): EnginePageState {
  return page.state()
}
