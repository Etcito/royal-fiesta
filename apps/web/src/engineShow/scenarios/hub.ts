import type { CaptureResult } from '../../../../../tools/engineCaptureJob.ts'
import type { HubRuntime } from '@royal-fiesta/game/ege/hub'
import type { RemoteView } from '@royal-fiesta/game/hub/remotes'
import { EMOTES, encodeState } from '@royal-fiesta/game/hub/protocol'
import type { CharState } from '@royal-fiesta/sim/character/system'
import { encodeInput, neutralInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import type { Vec3 } from '@royal-fiesta/sim/vec'
import { createShowPacer, PODIUM_PLAN, registerScenario } from '../ops.ts'
import type { ShowPacer } from '../ops.ts'
import type { EngineShowPage, EngineShowHostApi } from '../page.ts'
import { engineShowHost } from '../page.ts'

/** The hub facts of 'hub-inventory-rows': the exact HubFacts shape both hub scenarios return under `hub`. */
export interface HubFacts {
  ready: boolean
  faults: number
  localMoved: boolean
  localEmote: number
  remoteEmote: number
  lobbyBots: number
  botsMoved: number
  returned: number
  spawnRestored: boolean
  movedAfterReturn: boolean
  emoteAfterReturn: number
}

/** Hub scenarios drive the page only through engineShowHost(page) (page.ts:972, its Handoff comment). */
const WALK_TICKS = 90
const RETURN_WALK_TICKS = 60
const RETURN_HUB_WALK_TICKS = 30
const HUB_READY_TICKS = 600
const RETURN_SIGNAL_TICKS = 10
const SHOW_TICK_LIMIT = 250000
const FORWARD_TICKS = 60
const REMOTE_SEAT = 20
const BOT_MOVED_M = 0.3
const LOCAL_MOVED_M = 1.0
const FORWARD_CODE = encodeInput({ ...neutralInput(), moveZ: 1 })

/** The state of one hub arrival: the human start recorded at hub-ready and the bot positions before the walk. */
interface Arrival {
  readonly hub: HubRuntime
  readonly start: Vec3
  readonly bots: Map<number, Vec3>
}

function charState(): CharState {
  return {
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    facing: { x: 0, z: 0 },
    mode: 0,
    grounded: false,
    groundObstacle: -1,
    knockbacks: 0,
    teleportTick: 0,
  }
}

function humanPos(hub: HubRuntime): Vec3 {
  const state = hub.state(charState())
  return { x: state.pos.x, y: state.pos.y, z: state.pos.z }
}

function horizontal(a: Vec3, b: Vec3): number {
  return Math.hypot(a.x - b.x, a.z - b.z)
}

function botPositions(hub: HubRuntime): Map<number, Vec3> {
  const positions = new Map<number, Vec3>()
  for (const view of hub.botViews()) positions.set(view.seat, { x: view.pos.x, y: view.pos.y, z: view.pos.z })
  return positions
}

/** Bots that moved more than BOT_MOVED_M between the recorded positions and the hub's current ones. */
function botsMoved(before: Map<number, Vec3>, hub: HubRuntime): number {
  const now = botPositions(hub)
  let moved = 0
  for (const [seat, from] of before) {
    const to = now.get(seat)
    if (to !== undefined && horizontal(from, to) > BOT_MOVED_M) moved++
  }
  return moved
}

function hubOf(host: EngineShowHostApi): HubRuntime {
  const hub = host.hub()
  if (hub === null) throw new Error('[engine-show] the engine hub is not mounted; await page.ready before a scenario')
  return hub
}

async function stepOnce(host: EngineShowHostApi, pacer: ShowPacer, decide: () => number): Promise<void> {
  host.step(1, decide)
  await pacer.tick(() => host.where())
}

/** Bounded wait for one stable signal; a missing transition names the signal and the authoritative position. */
async function stepUntil(host: EngineShowHostApi, pacer: ShowPacer, signal: string, limit: number, draw: boolean): Promise<void> {
  for (let i = 0; i < limit && !host.signals().includes(signal); i++) {
    await stepOnce(host, pacer, () => NEUTRAL_CODE)
    if (draw) host.draw()
  }
  if (!host.signals().includes(signal)) throw new Error(`[engine-show] ${signal} never reached: ${host.where()}`)
}

/** Pauses the loop and draws the hub until its first presented frame, then records the start and the bots. */
async function arrive(host: EngineShowHostApi, pacer: ShowPacer): Promise<Arrival> {
  host.pauseLoop()
  await stepUntil(host, pacer, 'hub-ready', HUB_READY_TICKS, true)
  const hub = hubOf(host)
  return { hub, start: humanPos(hub), bots: botPositions(hub) }
}

/** Walks the local human forward, then shows a wave and one visiting penguin's dance from the presence feed. */
async function walkAndEmote(host: EngineShowHostApi, pacer: ShowPacer, arrival: Arrival, walkTicks: number): Promise<Pick<HubFacts, 'localMoved' | 'localEmote' | 'remoteEmote'>> {
  const { hub } = arrival
  for (let i = 0; i < walkTicks; i++) await stepOnce(host, pacer, () => FORWARD_CODE)
  const localMoved = horizontal(arrival.start, humanPos(hub)) > LOCAL_MOVED_M
  hub.setEmote(EMOTES.indexOf('wave'), performance.now())
  const localEmote = hub.emote(performance.now())
  const now = performance.now()
  host.pushPresence({ seat: REMOTE_SEAT, payload: { k: 'hi', v: 1, name: 'Visitor', c: 3 }, recvMs: now - 1000 })
  const human = humanPos(hub)
  const acts = [600, 400, 200, 0]
  for (let i = 0; i < acts.length; i++) {
    const pos = { x: human.x + 2, y: human.y, z: human.z + 2 }
    const payload = encodeState(pos, { x: 0, z: -1 }, 0, EMOTES.indexOf('dance'), false, false, i + 1)
    host.pushPresence({ seat: REMOTE_SEAT, payload, recvMs: now - acts[i] })
  }
  const remote = host.presence(performance.now()).find(view => view.seat === REMOTE_SEAT)
  return { localMoved, localEmote, remoteEmote: remote?.emote ?? 0 }
}

/** Draws the final frame, drains the effects, settles the GPU and returns the facts with the PNG. */
async function captureHub(scenario: string, host: EngineShowHostApi, hub: HubFacts): Promise<CaptureResult> {
  host.draw()
  host.collector.effects(host.pump())
  await host.settle()
  const png = await host.capture()
  return {
    facts: { ...host.collector.facts(), hub },
    capture: { name: `${scenario}.png`, width: 1920, height: 1080, mime: 'image/png', base64: base64Of(png) },
  }
}

function base64Of(bytes: Uint8Array): string {
  let value = ''
  for (let i = 0; i < bytes.length; i += 0x8000) value += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(value)
}

/** The hub the facts describe: the loaded hub's readiness, faults and lobby population. */
function hubReadout(host: EngineShowHostApi, hub: HubRuntime, moved: number): Pick<HubFacts, 'ready' | 'faults' | 'lobbyBots' | 'botsMoved'> {
  return { ready: host.signals().includes('hub-ready'), faults: hub.faults, lobbyBots: hub.botCount, botsMoved: moved }
}

async function runWalking(page: EngineShowPage, args: Readonly<Record<string, unknown>>): Promise<CaptureResult> {
  const host = engineShowHost(page)
  const scenario = String(args.scenario)
  const pacer = createShowPacer(scenario)
  const arrival = await arrive(host, pacer)
  const walk = await walkAndEmote(host, pacer, arrival, WALK_TICKS)
  const hub: HubFacts = {
    ...hubReadout(host, arrival.hub, botsMoved(arrival.bots, arrival.hub)),
    ...walk,
    returned: 0,
    spawnRestored: false,
    movedAfterReturn: false,
    emoteAfterReturn: 0,
  }
  return captureHub(scenario, host, hub)
}

/** Steps the show through its vote and playing screens, with real forward input, until the podium is done. */
async function playShow(host: EngineShowHostApi, pacer: ShowPacer): Promise<void> {
  let exercised = false
  for (let i = 0; i < SHOW_TICK_LIMIT && host.screen() !== 'done'; i++) {
    if (!exercised && host.screen() === 'playing') {
      for (let t = 0; t < FORWARD_TICKS; t++) await stepOnce(host, pacer, () => FORWARD_CODE)
      host.fastForward(true)
      exercised = true
      continue
    }
    await stepOnce(host, pacer, () => voteOrNeutral(host))
  }
  if (host.screen() !== 'done') throw new Error(`[engine-show] done never reached: ${host.where()}`)
}

function voteOrNeutral(host: EngineShowHostApi): number {
  if (host.screen() === 'vote') host.vote(0)
  return NEUTRAL_CODE
}

async function runReturned(page: EngineShowPage, args: Readonly<Record<string, unknown>>): Promise<CaptureResult> {
  const host = engineShowHost(page)
  const scenario = String(args.scenario)
  const pacer = createShowPacer(scenario)
  const arrival = await arrive(host, pacer)
  const walk = await walkAndEmote(host, pacer, arrival, RETURN_HUB_WALK_TICKS)
  const plan = Array.isArray(args.plan) ? args.plan as readonly number[] : PODIUM_PLAN
  await host.remount(plan)
  await playShow(host, pacer)
  host.fastForward(false)
  if (host.snapshot().champion === null) throw new Error(`[engine-show] the show ended at ${host.where()} without a champion`)
  await stepUntil(host, pacer, 'hub-returned', RETURN_SIGNAL_TICKS, false)
  const hub = hubOf(host)
  const spawnRestored = horizontal(humanPos(hub), arrival.start) < LOCAL_MOVED_M
  const beforeWalk = humanPos(hub)
  for (let i = 0; i < RETURN_WALK_TICKS; i++) await stepOnce(host, pacer, () => FORWARD_CODE)
  const movedAfterReturn = horizontal(beforeWalk, humanPos(hub)) > LOCAL_MOVED_M
  hub.setEmote(EMOTES.indexOf('cheer'), performance.now())
  const emoteAfterReturn = hub.emote(performance.now())
  const facts: HubFacts = {
    ...hubReadout(host, hub, botsMoved(arrival.bots, hub)),
    ...walk,
    returned: host.signals().filter(signal => signal === 'hub-returned').length,
    spawnRestored,
    movedAfterReturn,
    emoteAfterReturn,
  }
  return captureHub(scenario, host, facts)
}

registerScenario('engine-hub-walking-and-emotes', runWalking)
registerScenario('engine-show-returned-to-hub', runReturned)
