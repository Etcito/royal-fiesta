// Two browser peers in a relay zone room, each with one viewport per local seat. Play on the
// real page clock with takeover bots, then capture each split view as one composite PNG.
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import type { AdapterInfo, OpEnvelope } from '../nmc/ops.ts'
import { pendingPipelines } from '../render/asyncPipelines.ts'
import { raaStatus } from '../render/raaStatus.ts'
import { mountSplitView } from './splitView.ts'
import type { SplitView } from './splitView.ts'
import { playLobby } from './zoneLobbyPlay.ts'

const WIDTH = 1280
const HEIGHT = 720
const MIN_SECONDS = 1
const MAX_SECONDS = 120
const FRAME_MS = 16
const MAX_DT_S = 0.1
const PIPELINE_WAIT_MS = 10000
// The GPU client gives a job 295 s; every wait below ends inside it (RAA check 30 + join 150 + play
// ~20 with animations loading meanwhile, at most 30 + pipelines 10 + capture 20 = 240 s), so a stall finishes the op with an error
// naming the step instead of a page timeout with no output.
const QUEUE_TIMEOUT_MS = 100000
const SETUP_TIMEOUT_MS = 150000
const READY_TIMEOUT_MS = 30000
const CAPTURE_TIMEOUT_MS = 20000

export interface ZoneSplitCaptureInput {
  relay: string
  players: number
  seatsPerPeer: number
  course: string
  seconds: number
  /** Stop playing at this session tick, before `seconds` ends: a sprint racer parks once it finishes. */
  captureTick?: number
  name: string
  width: typeof WIDTH
  height: typeof HEIGHT
}

interface CaptureOut { name: 'zone-split'; width: number; height: number; mime: 'image/png'; base64: string }
interface ZoneSplitCaptureOutput {
  renderer: 'raa'
  adapter: AdapterInfo
  matched: { peers: number; seats: number; localPeer: number }
  ticks: number
  near: number
  far: number
  viewports: number
  /** Session counters at the end of play; confirmed is the last confirmed tick of each local domain. */
  session: { frames: number; stallFrames: number; desyncs: number; malformed: number; lostPeers: number[]; confirmed: Record<number, number> }
  captures: CaptureOut[]
}

// ---- input validation -------------------------------------------------------------------------------------

function obj(op: string, path: string, v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) refuse('ops', `${op}.${path}`, 'is not an object; pass the JSON input declared in nmc.gpu.json')
  return v as Record<string, unknown>
}

function onlyKeys(op: string, path: string, o: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(o).filter(k => !keys.includes(k))
  if (extra.length > 0) refuse('ops', `${op}.${path}`, `has unknown fields ${extra.join(', ')}; pass only ${keys.join(', ')}`)
}

function int(op: string, path: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) refuse('ops', `${op}.${path}`, `is ${JSON.stringify(v)}; pass an integer in ${min}..${max}`)
  return v
}

function num(op: string, path: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max) refuse('ops', `${op}.${path}`, `is ${JSON.stringify(v)}; pass a number in ${min}..${max}`)
  return v
}

function str(op: string, path: string, v: unknown, pattern: RegExp): string {
  if (typeof v !== 'string' || !pattern.test(v)) refuse('ops', `${op}.${path}`, `is ${JSON.stringify(v)}; pass a string matching ${pattern}`)
  return v
}

// The relay URL is checked and then only handed to mountSplitView: it is never echoed in the output.
function relayUrl(op: string, path: string, v: unknown): string {
  if (typeof v !== 'string') refuse('ops', `${op}.${path}`, `is ${JSON.stringify(v)}; pass a ws:// or wss:// relay URL`)
  let url: URL
  try { url = new URL(v) } catch {
    refuse('ops', `${op}.${path}`, 'is not a URL; pass a ws:// or wss:// relay URL')
  }
  if (url.protocol !== 'ws:' && url.protocol !== 'wss:') {
    refuse('ops', `${op}.${path}`, `is a ${url.protocol} URL; pass a ws:// or wss:// relay URL`)
  }
  return v
}

function validate(raw: unknown, path: string): ZoneSplitCaptureInput {
  const op = 'zoneSplitPair'
  const o = obj(op, path, raw)
  onlyKeys(op, path, o, ['relay', 'players', 'seatsPerPeer', 'course', 'seconds', 'captureTick', 'name', 'width', 'height'])
  if (o.width !== WIDTH || o.height !== HEIGHT) {
    refuse('ops', `${op}.${path}`, `is ${JSON.stringify(o.width)}x${JSON.stringify(o.height)}; zone split captures are ${WIDTH}x${HEIGHT}`)
  }
  return {
    relay: relayUrl(op, `${path}.relay`, o.relay),
    players: int(op, `${path}.players`, o.players, 2, 64),
    seatsPerPeer: int(op, `${path}.seatsPerPeer`, o.seatsPerPeer, 1, 4),
    course: str(op, `${path}.course`, o.course, /^[a-z0-9-]{1,40}$/),
    seconds: num(op, `${path}.seconds`, o.seconds, MIN_SECONDS, MAX_SECONDS),
    ...(o.captureTick === undefined ? {} : { captureTick: int(op, `${path}.captureTick`, o.captureTick, 1, MAX_SECONDS * 60) }),
    name: str(op, `${path}.name`, o.name, /^[a-z0-9-]{1,32}$/),
    width: WIDTH,
    height: HEIGHT,
  }
}

// ---- browser helpers --------------------------------------------------------------------------------------

// Minimal WebGPU shapes: the repo lib list has no @webgpu/types.
interface GpuAdapterInfoLike { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean }
interface GpuAdapterLike { info?: GpuAdapterInfoLike; isFallbackAdapter?: boolean }
interface GpuLike { requestAdapter(opts?: { powerPreference?: string }): Promise<GpuAdapterLike | null> }

// Same detection as the other ops (theirs are private).
async function adapterInfo(): Promise<AdapterInfo> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu
  if (!gpu) refuse('gpu', 'navigator.gpu', 'WebGPU is not exposed by this browser; run the op in the GPU client browser')
  const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' })
  if (adapter === null) refuse('gpu', 'navigator.gpu.requestAdapter', 'no WebGPU adapter; run the op in the GPU client browser')
  const info = adapter.info ?? {}
  const vendor = info.vendor ?? ''
  const architecture = info.architecture ?? ''
  const description = info.description ?? ''
  const fallback = info.isFallbackAdapter === true || adapter.isFallbackAdapter === true
  const software = fallback || /swiftshader/i.test(`${vendor} ${architecture} ${description}`)
  return { vendor, architecture, description, software }
}

async function prelude(): Promise<AdapterInfo> {
  const status = await raaStatus()
  if (!status.available) refuse('render', 'raa', status.reason)
  return adapterInfo()
}

function makeContainer(width: number, height: number): HTMLDivElement {
  const container = document.createElement('div')
  container.style.cssText = `position: relative; width: ${width}px; height: ${height}px;`
  document.body.appendChild(container)
  return container
}

function base64Of(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

function delay(ms: number): Promise<void> {
  return new Promise<void>(resolve => setTimeout(resolve, ms))
}

// ---- phases ----------------------------------------------------------------------------------------------

// window.__nmcGpuProgress is read by the GPU client bridge and named when a job times out.
const phases = new Map<string, string>()
function publishPhase(name: string, phase: string): void {
  phases.set(name, phase)
  ;(window as Window & { __nmcGpuProgress?: string }).__nmcGpuProgress = [...phases].map(([n, p]) => `${n}: ${p}`).join('; ')
}

// Refuses with the step's name when it does not settle in time.
async function bounded<T>(name: string, step: string, ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      // Name the phase it stalled in: the GPU client reports progress only when the whole job times out.
      const at = phases.get(name) ?? 'no phase published'
      try { refuse('zone', `zoneSplitPair.${name}`, `${step} did not finish within ${ms / 1000} s (stalled at: ${at})`) } catch (error) { reject(error) }
    }, ms)
  })
  try { return await Promise.race([work, timeout]) }
  finally { clearTimeout(timer) }
}

function sessionOf(lobby: SplitView): ZoneSplitCaptureOutput['session'] {
  const s = lobby.stats
  return { frames: s.frames, stallFrames: s.stallFrames, desyncs: s.desyncs, malformed: s.malformed,
    lostPeers: s.lostPeers.slice(), confirmed: { ...s.confirmedTick } }
}

// ---- zoneSplitPair ---------------------------------------------------------------------

// One browser peer: join the room, play it on real time, capture one RAA frame.
async function runSplit(input: ZoneSplitCaptureInput, adapter: AdapterInfo): Promise<ZoneSplitCaptureOutput> {
  const container = makeContainer(input.width, input.height)
  const realNow = performance.now.bind(performance)
  let lobby: SplitView | null = null
  const phase = (p: string) => publishPhase(input.name, p)
  phase('dispatched')
  let mounting: Promise<SplitView> | undefined
  try {
    mounting = mountSplitView({
      container,
      width: input.width,
      height: input.height,
      relayUrl: input.relay,
      players: input.players,
      localSeats: input.seatsPerPeer,
      courseId: input.course,
      name: input.name,
      drive: 'bots',
      queueTimeoutMs: QUEUE_TIMEOUT_MS,
      onPhase: phase,
    })
    lobby = await bounded(input.name, 'joining the zone room', SETUP_TIMEOUT_MS, mounting)
    // The match runs against real network peers, so the clock is the page's: setTimeout between
    // frames (requestAnimationFrame rarely fires in the GPU client browser) and the measured dt. It keeps
    // ticking while the near characters' animations load, or the other peers drop this silent one.
    const joined = lobby
    await playLobby(joined, {
      seconds: input.seconds, captureTick: input.captureTick, frameMs: FRAME_MS, maxDtS: MAX_DT_S,
      load: () => bounded(input.name, 'animation loading', READY_TIMEOUT_MS, joined.ready()),
      onPhase: phase,
    }, { now: realNow, wait: delay })
    phase(`rendering (tick ${joined.info.tick})`)
    joined.render()
    const deadline = realNow() + PIPELINE_WAIT_MS
    while (pendingPipelines() > 0) {
      if (realNow() >= deadline) refuse('render', 'raa', `pipeline readiness timed out at zone-split; ${pendingPipelines()} pipelines still pending`)
      await delay(10)
    }
    joined.render()
    phase('capturing')
    const png = await bounded(input.name, 'the RAA capture', CAPTURE_TIMEOUT_MS, joined.capture())
    if (png === null || png.length === 0) refuse('render', 'raa', 'the zone split capture returned no PNG bytes; the RAA port must read the canvas back')
    const info = joined.info
    return {
      renderer: 'raa',
      adapter,
      matched: { peers: info.peers, seats: info.seats, localPeer: info.localPeer },
      ticks: info.tick,
      near: info.near,
      far: info.far,
      viewports: info.viewports,
      session: sessionOf(joined),
      captures: [{ name: 'zone-split', width: input.width, height: input.height, mime: 'image/png', base64: base64Of(png) }],
    }
  } catch (error) {
    phase(`failed: ${error instanceof Error ? error.message : String(error)}`)
    // A join that outlived its bound still owns a socket and a scene: dispose it when it settles.
    if (lobby === null) void mounting?.then(late => late.dispose(), () => {})
    throw error
  } finally {
    try { lobby?.dispose() } finally { container.remove() }
  }
}

function opFailure(op: string, error: unknown): never {
  // mountSplitView already refuses with the text of its cause; keep it verbatim.
  if (isRefusal(error)) throw error
  return refuse('ops', op, error instanceof Error ? error.message : String(error))
}

export interface ZoneSplitPairInput { peers: [ZoneSplitCaptureInput, ZoneSplitCaptureInput] }
interface ZoneSplitPairOutput { runs: ZoneSplitCaptureOutput[] }

// Two browser peers of the same room in one GPU job: the GPU broker runs one job per project at a time,
// so two separate capture jobs never overlap and a room that needs both of them never fills.
async function zoneSplitPair(raw: unknown): Promise<OpEnvelope<ZoneSplitPairOutput>> {
  const op = 'zoneSplitPair'
  const o = obj(op, 'input', raw)
  onlyKeys(op, 'input', o, ['peers'])
  if (!Array.isArray(o.peers) || o.peers.length !== 2) refuse('ops', `${op}.input.peers`, 'pass exactly two split-view peer inputs')
  const peers = o.peers.map((peer, i) => validate(peer, `input.peers[${i}]`))
  if (peers[0].name === peers[1].name) refuse('ops', `${op}.input.peers`, `both peers are named '${peers[0].name}'; give each a distinct name`)
  phases.clear()
  publishPhase('page', 'checking RAA and the GPU adapter')
  const adapter = await bounded('page', 'the RAA check', READY_TIMEOUT_MS, prelude())
  phases.clear()
  // Both join concurrently; a failure of one is reported only after the other has settled and cleaned up.
  const settled = await Promise.allSettled(peers.map(input => runSplit(input, adapter)))
  const failed = settled.findIndex(result => result.status === 'rejected')
  if (failed >= 0) {
    const reason = (settled[failed] as PromiseRejectedResult).reason
    return opFailure(`${op}.${peers[failed].name}`, reason)
  }
  return { json: { runs: settled.map(result => (result as PromiseFulfilledResult<ZoneSplitCaptureOutput>).value) }, files: [] }
}

type SplitOps = {
  zoneSplitPair(input: unknown): Promise<OpEnvelope<ZoneSplitPairOutput>>
}

// Register next to the game page's ops; mounting starts only when the op is called.
export function installSplitOps(): void {
  const gpu = window.nmcGpu
  if (gpu === undefined) refuse('ops', 'installSplitOps', 'window.nmcGpu is missing; install the base GPU ops first')
  const ops = gpu.ops as unknown as SplitOps
  ops.zoneSplitPair = zoneSplitPair
}
