import type { CaptureResult } from '../../../../../tools/engineCaptureJob.ts'
import { createEngineOnlineShow } from '@royal-fiesta/game/ege/online'
import { engineOnlineStats, onlineMeasurements } from '@royal-fiesta/game/ege/onlineState'
import type { EngineShowRuntime } from '@royal-fiesta/game/ege/showTypes'
import { onlineRoster } from '@royal-fiesta/game/net/onlineMatch'
import { ZoneLoopback } from '@royal-fiesta/game/net/zoneLoopback'
import { encodeInput, neutralInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { createShowPacer, registerScenario } from '../ops.ts'
import type { ShowPacer } from '../ops.ts'
import type { EngineShowConfigOverrides, EngineShowHostApi, EngineShowPage } from '../page.ts'
import { engineShowHost } from '../page.ts'

/** Two online clients in this tab: client A is presented (peer 0, seat 0), client B is headless (peer 1, seat 1). */
const FRAME_S = 1 / 60
const FRAME_MS = 1000 / 60
const SEED = 7
const RTT_MS = 20
const LATE_START_FRAMES = 30
const ROUND_SHOT_TICKS = 30
const BACKGROUND_FRAMES = 120
const STEP_LIMIT = 20000
const PODIUM_TICK_LIMIT = 250000
const WIDTH = 1920
const HEIGHT = 1080
const FORWARD_CODE = encodeInput({ ...neutralInput(), moveX: 1, moveZ: 1 })

/** The two clients' shared network: a zero-loss loopback, the roster and the measurements of every peer. */
interface Pair {
  readonly loop: ZoneLoopback
  readonly roster: ReturnType<typeof onlineRoster>
  readonly measurements: ReturnType<typeof onlineMeasurements>
  readonly humans: readonly boolean[]
  a: EngineShowRuntime | null
  b: EngineShowRuntime | null
}

function newPair(humans: number, flags: readonly boolean[]): Pair {
  const roster = onlineRoster(humans)
  return {
    loop: new ZoneLoopback(humans, { seed: SEED, rttMs: RTT_MS, jitterMs: 0, loss: 0 }),
    roster,
    measurements: onlineMeasurements(roster),
    humans: flags,
    a: null,
    b: null,
  }
}

function networkOf(localPeer: number, pair: Pair) {
  return { localPeer, roster: pair.roster, transport: pair.loop.transport(localPeer), measurements: pair.measurements }
}

function overridesOf(args: Readonly<Record<string, unknown>>): EngineShowConfigOverrides {
  const overrides: EngineShowConfigOverrides = { humans: args.humans as number }
  if (Array.isArray(args.plan)) overrides.plan = args.plan as number[]
  return overrides
}

/** Remounts the presented client A through the page's one-shot starter; the starter prepares it as peer 0. */
async function presentA(host: EngineShowHostApi, pair: Pair, overrides: EngineShowConfigOverrides): Promise<void> {
  await host.remountWith(async config => {
    pair.a = await createEngineOnlineShow(config, networkOf(0, pair))
    return pair.a
  }, overrides)
}

function startB(host: EngineShowHostApi, pair: Pair, overrides: EngineShowConfigOverrides): Promise<void> {
  return createEngineOnlineShow(host.showConfig(overrides), networkOf(1, pair)).then(runtime => { pair.b = runtime })
}

/** Client B votes its own seat once per vote screen with candidate 0, like the presented client. */
function voteHeadless(runtime: EngineShowRuntime): void {
  if (runtime.snapshot().screen === 'vote') runtime.vote(1, 0)
}

/**
 * One fixed tick of both clients: the shared network advances, the headless client B is framed with neutral input,
 * then the presented client A steps with `decide` (null leaves A unframed, as a background tab would be).
 */
async function tick(host: EngineShowHostApi, pair: Pair, pacer: ShowPacer, decide: (() => number) | null): Promise<void> {
  pair.loop.advance(FRAME_MS)
  if (pair.b !== null) {
    voteHeadless(pair.b)
    pair.b.frame(FRAME_S, () => NEUTRAL_CODE)
  }
  if (decide !== null) host.step(1, () => presentedInput(host, decide))
  await pacer.tick(() => host.where())
}

function presentedInput(host: EngineShowHostApi, code: () => number): number {
  if (host.screen() === 'vote') host.vote(0)
  return code()
}

/** Ticks until `done` holds; a missing transition fails with the authoritative position, never a pass on zero. */
async function until(host: EngineShowHostApi, pair: Pair, pacer: ShowPacer, done: () => boolean, what: string,
  decide: () => number, limit = STEP_LIMIT): Promise<void> {
  for (let i = 0; i < limit; i++) {
    if (done()) return
    await tick(host, pair, pacer, decide)
  }
  throw new Error(`[engine-show] ${what} never reached: ${host.where()}`)
}

function aligned(host: EngineShowHostApi, pair: Pair): boolean {
  if (pair.b === null) return false
  const a = host.snapshot()
  const b = pair.b.snapshot()
  return a.screen === 'playing' && b.screen === 'playing' && a.round === b.round
}

function desyncsOf(runtime: EngineShowRuntime | null): number {
  const stats = runtime === null ? null : engineOnlineStats(runtime)
  if (stats === null) throw new Error('[engine-show] an online client has no desync stats; create it with createEngineOnlineShow')
  return stats.desyncs
}

/** The online facts of both clients; B's snapshot faults are the peer faults and every desync is summed. */
function onlineFacts(pair: Pair, host: EngineShowHostApi, lateStartFrames: number, backgroundFrames: number) {
  if (pair.b === null) throw new Error(`[engine-show] client B was never created: ${host.where()}`)
  const humans = pair.humans.filter(human => human).length
  return {
    clients: [pair.a, pair.b].filter(runtime => runtime !== null).length,
    humans,
    bots: pair.humans.length - humans,
    sameRound: host.snapshot().round === pair.b.snapshot().round,
    lateStartFrames,
    backgroundFrames,
    desyncs: desyncsOf(pair.a) + desyncsOf(pair.b),
    peerFaults: pair.b.snapshot().faults,
  }
}

function disposeBoth(pair: Pair): void {
  pair.a?.dispose()
  pair.b?.dispose()
}

function base64Of(bytes: Uint8Array): string {
  let value = ''
  for (let i = 0; i < bytes.length; i += 0x8000) value += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(value)
}

/** Draws, drains the effects, settles the GPU and reads the PNG of the attached show. */
async function shootFrame(host: EngineShowHostApi): Promise<Uint8Array> {
  host.draw()
  host.collector.effects(host.pump())
  await host.settle()
  return host.capture()
}

function resultOf(scenario: string, host: EngineShowHostApi, png: Uint8Array, online: ReturnType<typeof onlineFacts>): CaptureResult {
  return {
    facts: { ...host.collector.facts(), online },
    capture: { name: `${scenario}.png`, width: WIDTH, height: HEIGHT, mime: 'image/png', base64: base64Of(png) },
  }
}

/**
 * The round shot while client B joins late: A frames LATE_START_FRAMES ticks alone, then B is created. The image is
 * shot ROUND_SHOT_TICKS ticks into the first playing round, once both clients report the same round and screen.
 */
async function runLateClientRound(page: EngineShowPage, args: Readonly<Record<string, unknown>>): Promise<CaptureResult> {
  const scenario = String(args.scenario)
  const host = engineShowHost(page)
  const pacer = createShowPacer(scenario)
  const overrides = overridesOf(args)
  const pair = newPair(args.humans as number, host.showConfig(overrides).humans)
  try {
    host.pauseLoop()
    await presentA(host, pair, overrides)
    for (let i = 0; i < LATE_START_FRAMES; i++) await tick(host, pair, pacer, presentedCode(host))
    await startB(host, pair, overrides)
    await until(host, pair, pacer, () => aligned(host, pair), 'both clients playing the same round', presentedCode(host))
    for (let i = 0; i < ROUND_SHOT_TICKS; i++) await tick(host, pair, pacer, presentedCode(host))
    if (!aligned(host, pair)) throw new Error(`[engine-show] the clients left the shared round before the shot: ${host.where()}`)
    const png = await shootFrame(host)
    host.collector.effects(host.pump())
    return resultOf(scenario, host, png, onlineFacts(pair, host, LATE_START_FRAMES, 0))
  } finally {
    disposeBoth(pair)
  }
}

/** Forward while the round plays, neutral otherwise: the presented client's real input. */
function presentedCode(host: EngineShowHostApi): () => number {
  return () => (host.screen() === 'playing' || host.screen() === 'overtime' ? FORWARD_CODE : NEUTRAL_CODE)
}

/**
 * The background client: A is not framed for BACKGROUND_FRAMES ticks while B keeps running, then A resumes and the
 * show is fast-forwarded to the confirmed podium, which is shot while the show is still attached.
 */
async function runBackgroundClientPodium(page: EngineShowPage, args: Readonly<Record<string, unknown>>): Promise<CaptureResult> {
  const scenario = String(args.scenario)
  const host = engineShowHost(page)
  const pacer = createShowPacer(scenario)
  const overrides = overridesOf(args)
  const pair = newPair(args.humans as number, host.showConfig(overrides).humans)
  try {
    host.pauseLoop()
    await presentA(host, pair, overrides)
    await startB(host, pair, overrides)
    await until(host, pair, pacer, () => aligned(host, pair), 'both clients playing', presentedCode(host))
    let backgroundFrames = 0
    for (let i = 0; i < BACKGROUND_FRAMES; i++) {
      await tick(host, pair, pacer, null)
      backgroundFrames++
    }
    host.fastForward(true)
    await until(host, pair, pacer, () => host.screen() === 'done', 'the confirmed podium', () => NEUTRAL_CODE, PODIUM_TICK_LIMIT)
    host.fastForward(false)
    const champion = host.snapshot().champion
    if (champion === null) throw new Error(`[engine-show] the show reached done without a confirmed champion: ${host.where()}`)
    const png = await shootFrame(host)
    return resultOf(scenario, host, png, onlineFacts(pair, host, 0, backgroundFrames))
  } finally {
    disposeBoth(pair)
  }
}

registerScenario('engine-online-late-client-round', runLateClientRound)
registerScenario('engine-online-background-client-podium', runBackgroundClientPodium)
