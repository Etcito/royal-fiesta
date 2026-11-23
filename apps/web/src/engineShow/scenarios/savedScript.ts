import type { CaptureResult } from '../../../../../tools/engineCaptureJob.ts'
import type { PublicationEvent, ScriptPublication } from '../../../../../tools/egeScripts.ts'
import { localSwapState } from '@royal-fiesta/game/ege/localSwap'
import type { EngineShowRuntime, EngineWorldRef } from '@royal-fiesta/game/ege/showTypes'
import { createEngineShow } from '@royal-fiesta/game/ege/showRuntime'
import { BTN, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { attachSavedScriptReload, publicationOfEvent } from '../../engineShowDev/reload.ts'
import type { SavedScriptSource, ScriptReloadStatus } from '../../engineShowDev/reload.ts'
import { drawScriptStatus, SCRIPT_APPLIED_SIGNAL, scriptStatusLines } from '../../engineShowDev/status.ts'
import type { ScriptStatusCanvas } from '../../engineShowDev/status.ts'
import { createShowPacer, registerScenario, showSeatPoses } from '../ops.ts'
import type { ShowPacer } from '../ops.ts'
import { engineShowHost } from '../page.ts'
import type { EngineShowHostApi, EngineShowPage } from '../page.ts'

const SCENARIO = 'engine-saved-script-applied'
const EVENTS_URL = 'ege/swap/events.json'
const EVENTS_FORMAT = 'royal-fiesta.saved-script-events'
const EVENTS_MISSING = '[engine-show] ege/swap/events.json is missing; run node --experimental-strip-types tools/savedScriptSave.ts --page apps/web/dist before rendering'
const WIDTH = 1920
const HEIGHT = 1080
const SEATS = 60
const LOCAL_SEAT = 0
const HUB_READY_TICKS = 600
const PLAYING_TICKS = 20000
const SETTLE_TICKS = 30
const JUMP_AIR_TICKS = 89
const PRE_FINAL_JUMP_TICKS = 60
const STATUS_WAIT_MS = 30000
const RISE_FLOOR_M = 0.2
const RISE_RATIO = 1.5
const JUMP_CODE = NEUTRAL_CODE | BTN.JUMP

/** The staged events document written by tools/savedScriptSave.ts (contract G7-SWAP-STAGED-EVENTS). */
interface StagedEvents {
  format: string
  version: number
  game: string
  script: string
  baseline: { moduleKey: string; schemaKey: number }
  events: PublicationEvent[]
}

/** One jump observation: the height gained above the standing pose and the air ticks that reached the peak. */
interface JumpRise {
  rise: number
  peakAfter: number
}

/** The G7-SWAP-FACTS `swap` object: every value observed from the running show, never defaulted. */
interface SwapFacts {
  rejectedKept: boolean
  rejectedDiagnostics: number
  applied: boolean
  generation: number
  appliedRevision: number
  moduleChanged: boolean
  tickPreserved: boolean
  roundPreserved: boolean
  riseBeforeM: number
  riseAfterM: number
  behaviorChanged: boolean
  signals: number
  faults: number
}

async function stepOnce(host: EngineShowHostApi, pacer: ShowPacer, decide: () => number): Promise<void> {
  host.step(1, decide)
  await pacer.tick(() => host.where())
}

async function stepNeutral(host: EngineShowHostApi, pacer: ShowPacer, ticks: number): Promise<void> {
  for (let i = 0; i < ticks; i++) await stepOnce(host, pacer, () => NEUTRAL_CODE)
}

/** Steps and draws until the hub's first presented frame; a missing signal names the authoritative position. */
async function waitForHub(host: EngineShowHostApi, pacer: ShowPacer): Promise<void> {
  for (let i = 0; i < HUB_READY_TICKS && !host.signals().includes('hub-ready'); i++) {
    await stepOnce(host, pacer, () => NEUTRAL_CODE)
    host.draw()
  }
  if (!host.signals().includes('hub-ready')) throw new Error(`[engine-show] hub-ready never reached: ${host.where()}`)
}

/** Steps while voting for candidate 0 on the vote screen until the first round plays. */
async function waitForPlaying(host: EngineShowHostApi, pacer: ShowPacer): Promise<void> {
  const decide = (): number => {
    if (host.screen() === 'vote') host.vote(0)
    return NEUTRAL_CODE
  }
  for (let i = 0; i < PLAYING_TICKS && host.screen() !== 'playing'; i++) await stepOnce(host, pacer, decide)
  if (host.screen() !== 'playing') throw new Error(`[engine-show] playing never reached: ${host.where()}`)
}

/** Reads the local room seat's current height from the runtime's far poses. */
function seatY(runtime: EngineShowRuntime): number {
  const pose = showSeatPoses(runtime.presentation(), SEATS).get(LOCAL_SEAT)
  if (pose === undefined) throw new Error(`[engine-show] room seat ${LOCAL_SEAT} has no live pose to measure the jump`)
  return pose[1]
}

/** Jumps once and steps the whole arc, returning the peak rise above the standing pose and its air-tick offset. */
async function measureJump(host: EngineShowHostApi, pacer: ShowPacer, runtime: EngineShowRuntime): Promise<JumpRise> {
  const start = seatY(runtime)
  await stepOnce(host, pacer, () => JUMP_CODE)
  let peak = seatY(runtime)
  let peakAfter = 0
  for (let i = 0; i < JUMP_AIR_TICKS; i++) {
    await stepOnce(host, pacer, () => NEUTRAL_CODE)
    const y = seatY(runtime)
    if (y > peak) {
      peak = y
      peakAfter = i + 1
    }
  }
  return { rise: peak - start, peakAfter }
}

function sameTimelines(before: readonly EngineWorldRef[], current: readonly EngineWorldRef[]): boolean {
  return before.length === current.length && before.every((ref, index) => ref.timeline.module === current[index].timeline.module)
}

/** Reads and validates the two modeler-staged publications; a missing or foreign stage refuses before any remount. */
async function fetchStaged(): Promise<readonly [PublicationEvent, PublicationEvent]> {
  const response = await fetch(new URL(EVENTS_URL, document.baseURI), { cache: 'no-cache' })
  if (!response.ok) throw new Error(EVENTS_MISSING)
  const value: unknown = await response.json()
  if (value === null || typeof value !== 'object') throw new Error(`[engine-show] ${EVENTS_URL} is not an object`)
  const staged = value as StagedEvents
  if (staged.format !== EVENTS_FORMAT) throw new Error(`[engine-show] ${EVENTS_URL} has format '${String(staged.format)}', not '${EVENTS_FORMAT}'`)
  if (staged.version !== 1) throw new Error(`[engine-show] ${EVENTS_URL} has version ${String(staged.version)}, not 1`)
  const events = staged.events
  if (!Array.isArray(events) || events.length < 2) throw new Error(`[engine-show] ${EVENTS_URL} does not hold two events`)
  const [rejected, accepted] = events
  if (rejected.status !== 'failure') throw new Error(`[engine-show] ${EVENTS_URL} events[0] is '${rejected.status}', not 'failure'`)
  if (accepted.status !== 'success') throw new Error(`[engine-show] ${EVENTS_URL} events[1] is '${accepted.status}', not 'success'`)
  return [rejected, accepted]
}

function lastOf(statuses: readonly ScriptReloadStatus[]): ScriptReloadStatus {
  const last = statuses.at(-1)
  if (last === undefined) throw new Error('[engine-show] the saved-script reload emitted no status')
  return last
}

/** Polls the recorded statuses only (no simulation steps) until one matches, within the page-time budget. */
async function waitForStatus(
  statuses: readonly ScriptReloadStatus[],
  match: (status: ScriptReloadStatus) => boolean,
  what: string,
): Promise<ScriptReloadStatus> {
  const deadline = performance.now() + STATUS_WAIT_MS
  while (performance.now() <= deadline) {
    const last = lastOf(statuses)
    if (match(last)) return last
    await new Promise<void>(resolve => { setTimeout(resolve, 0) })
  }
  const last = lastOf(statuses)
  throw new Error(`[engine-show] ${what} was never reached: status '${last.state}'${last.error === null ? '' : ` (${last.error})`}`)
}

/** Attaches the staged events to the running show; subscribe stores the listener so the scenario can publish. */
function staticSource(store: (listener: (publication: ScriptPublication) => void) => void): SavedScriptSource {
  return {
    subscribe(listener) {
      store(listener)
      return () => { store(() => {}) }
    },
    async fetchBytes(url) {
      const href = new URL(url, document.baseURI)
      const response = await fetch(href, { cache: 'no-cache' })
      if (!response.ok) throw new Error(`[engine-show] ${href} answered ${response.status} ${response.statusText}`)
      return response.arrayBuffer()
    },
  }
}

/** Paints the status panel onto the captured frame with the same 1920x1080 canvas the page capture uses. */
async function composeStatus(png: Uint8Array, status: ScriptReloadStatus, faults: number): Promise<Uint8Array> {
  const bitmap = await createImageBitmap(new Blob([png as BlobPart]))
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const context = canvas.getContext('2d')
  if (context === null) throw new Error('[engine-show] a 2d canvas is needed to compose the script status')
  context.drawImage(bitmap, 0, 0, WIDTH, HEIGHT)
  bitmap.close()
  drawScriptStatus(context as unknown as ScriptStatusCanvas, scriptStatusLines(status, faults), WIDTH)
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) throw new Error('[engine-show] toBlob returned no PNG for the saved-script capture')
  return new Uint8Array(await blob.arrayBuffer())
}

function base64Of(bytes: Uint8Array): string {
  let value = ''
  for (let i = 0; i < bytes.length; i += 0x8000) value += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(value)
}

async function runSavedScript(page: EngineShowPage, args: Readonly<Record<string, unknown>>): Promise<CaptureResult> {
  const host = engineShowHost(page)
  const pacer = createShowPacer(SCENARIO)
  host.pauseLoop()
  await waitForHub(host, pacer)
  const [rejectedEvent, acceptedEvent] = await fetchStaged()
  const plan = Array.isArray(args.plan) ? args.plan as readonly number[] : undefined
  const started: { runtime: EngineShowRuntime | null } = { runtime: null }
  await host.remountWith(async config => {
    const created = await createEngineShow(config)
    started.runtime = created
    return created
  }, plan === undefined ? undefined : { plan })
  if (started.runtime === null) throw new Error('[engine-show] the saved-script show was not prepared')
  const runtime = started.runtime
  await waitForPlaying(host, pacer)

  await stepNeutral(host, pacer, SETTLE_TICKS)
  const beforeJump = await measureJump(host, pacer, runtime)

  const statuses: ScriptReloadStatus[] = []
  const signals: string[] = []
  let applies = 0
  let publish: ((publication: ScriptPublication) => void) | null = null
  const source = staticSource(listener => { publish = listener })
  const dispose = attachSavedScriptReload(page, runtime, source, {
    onStatus(status) {
      statuses.push(status)
      if (status.applies > applies) signals.push(SCRIPT_APPLIED_SIGNAL)
      applies = status.applies
    },
  })
  try {
    const before = host.snapshot()
    const generationBefore = localSwapState(runtime).generation
    const timelinesBefore = runtime.worlds()

    emit(publish, rejectedEvent)
    await waitForStatus(statuses, status => status.state === 'rejected', 'the rejected publication')
    const rejectedKept = localSwapState(runtime).generation === generationBefore
      && sameTimelines(timelinesBefore, runtime.worlds())
      && host.snapshot().tick === before.tick
      && host.snapshot().round === before.round
    const rejectedDiagnostics = lastOf(statuses).diagnostics.length

    emit(publish, acceptedEvent)
    const appliedStatus = await waitForStatus(statuses, status => status.state === 'applied' || status.state === 'rejected', 'the saved publication')
    if (appliedStatus.state === 'rejected') throw new Error(`[engine-show] the saved script was rejected: ${appliedStatus.error ?? 'no error text'}`)
    const after = host.snapshot()
    const state = localSwapState(runtime)
    const tickPreserved = after.tick === before.tick
    const roundPreserved = after.round === before.round
    const moduleChanged = state.moduleKey !== runtime.identity.moduleKey

    await stepNeutral(host, pacer, SETTLE_TICKS)
    const afterJump = await measureJump(host, pacer, runtime)

    await stepNeutral(host, pacer, PRE_FINAL_JUMP_TICKS)
    await stepOnce(host, pacer, () => JUMP_CODE)
    for (let i = 0; i < afterJump.peakAfter; i++) await stepOnce(host, pacer, () => NEUTRAL_CODE)

    host.draw()
    const faults = runtime.snapshot().faults + localSwapState(runtime).faults
    host.collector.scriptFaults(faults)
    host.collector.effects(host.pump())
    await host.settle()
    const shot = await composeStatus(await host.capture(), appliedStatus, faults)
    const swap: SwapFacts = {
      rejectedKept,
      rejectedDiagnostics,
      applied: appliedStatus.state === 'applied',
      generation: localSwapState(runtime).generation,
      appliedRevision: localSwapState(runtime).revision,
      moduleChanged,
      tickPreserved,
      roundPreserved,
      riseBeforeM: beforeJump.rise,
      riseAfterM: afterJump.rise,
      behaviorChanged: beforeJump.rise > RISE_FLOOR_M && afterJump.rise > RISE_RATIO * beforeJump.rise,
      signals: signals.length,
      faults,
    }
    return {
      facts: { ...host.collector.facts(), swap },
      capture: { name: `${SCENARIO}.png`, width: WIDTH, height: HEIGHT, mime: 'image/png', base64: base64Of(shot) },
    }
  } finally {
    dispose()
  }
}

/** Publishes one staged event through the listener the static source stored at attachment. */
function emit(publish: ((publication: ScriptPublication) => void) | null, event: PublicationEvent): void {
  if (publish === null) throw new Error('[engine-show] the saved-script reload did not subscribe to its source')
  publish(publicationOfEvent(event))
}

registerScenario(SCENARIO, runSavedScript)
