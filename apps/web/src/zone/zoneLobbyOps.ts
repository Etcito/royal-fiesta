// GPU client op of a relay zone room on game.html: this browser joins a real zone room with real
// network peers, plays it on real time with a takeover bot on every local seat, and captures one RAA
// frame. mountZoneLobby owns the client, the match and the scene; this op only validates, steps and
// reads back.
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'
import type { AdapterInfo, OpEnvelope } from '../nmc/ops.ts'
import { pendingPipelines } from '../render/asyncPipelines.ts'
import { raaStatus } from '../render/raaStatus.ts'
import { mountZoneLobby } from './zoneLobby.ts'
import type { ZoneLobby } from './zoneLobby.ts'
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

export interface ZoneLobbyCaptureInput {
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

interface CaptureOut { name: 'zone-lobby'; width: number; height: number; mime: 'image/png'; base64: string }
interface ZoneLobbyCaptureOutput {
  renderer: 'raa'
  adapter: AdapterInfo
  matched: { peers: number; seats: number; localPeer: number }
  ticks: number
  near: number
  far: number
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

// The relay URL is checked and then only handed to mountZoneLobby: it is never echoed in the output.
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

function validate(raw: unknown): ZoneLobbyCaptureInput {
  const op = 'zoneLobbyCapture'
  const o = obj(op, 'input', raw)
  onlyKeys(op, 'input', o, ['relay', 'players', 'seatsPerPeer', 'course', 'seconds', 'captureTick', 'name', 'width', 'height'])
  if (o.width !== WIDTH || o.height !== HEIGHT) {
    refuse('ops', `${op}.input`, `is ${JSON.stringify(o.width)}x${JSON.stringify(o.height)}; zone lobby captures are ${WIDTH}x${HEIGHT}`)
  }
  return {
    relay: relayUrl(op, 'input.relay', o.relay),
    players: int(op, 'input.players', o.players, 2, 64),
    seatsPerPeer: int(op, 'input.seatsPerPeer', o.seatsPerPeer, 1, 4),
    course: str(op, 'input.course', o.course, /^[a-z0-9-]{1,40}$/),
    seconds: num(op, 'input.seconds', o.seconds, MIN_SECONDS, MAX_SECONDS),
    ...(o.captureTick === undefined ? {} : { captureTick: int(op, 'input.captureTick', o.captureTick, 1, MAX_SECONDS * 60) }),
    name: str(op, 'input.name', o.name, /^[a-z0-9-]{1,32}$/),
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

function makeCanvas(width: number, height: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  canvas.style.cssText = `width: ${width}px; height: ${height}px; display: block;`
  document.body.appendChild(canvas)
  return canvas
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
      try { refuse('zone', `zoneLobbyCapture.${name}`, `${step} did not finish within ${ms / 1000} s (stalled at: ${at})`) } catch (error) { reject(error) }
    }, ms)
  })
  try { return await Promise.race([work, timeout]) }
  finally { clearTimeout(timer) }
}

function sessionOf(lobby: ZoneLobby): ZoneLobbyCaptureOutput['session'] {
  const s = lobby.stats
  return { frames: s.frames, stallFrames: s.stallFrames, desyncs: s.desyncs, malformed: s.malformed,
    lostPeers: s.lostPeers.slice(), confirmed: { ...s.confirmedTick } }
}

// ---- zoneLobbyCapture / zoneLobbyPair ---------------------------------------------------------------------

// One browser peer: join the room, play it on real time, capture one RAA frame.
async function runLobby(input: ZoneLobbyCaptureInput, adapter: AdapterInfo): Promise<ZoneLobbyCaptureOutput> {
  const canvas = makeCanvas(input.width, input.height)
  const realNow = performance.now.bind(performance)
  let lobby: ZoneLobby | null = null
  const phase = (p: string) => publishPhase(input.name, p)
  phase('dispatched')
  let mounting: Promise<ZoneLobby> | undefined
  try {
    mounting = mountZoneLobby({
      canvas,
      width: input.width,
      height: input.height,
      relayUrl: input.relay,
      players: input.players,
      localSeats: input.seatsPerPeer,
      courseId: input.course,
      name: input.name,
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
      if (realNow() >= deadline) refuse('render', 'raa', `pipeline readiness timed out at zone-lobby; ${pendingPipelines()} pipelines still pending`)
      await delay(10)
    }
    joined.render()
    phase('capturing')
    const png = await bounded(input.name, 'the RAA capture', CAPTURE_TIMEOUT_MS, joined.capture())
    if (png === null || png.length === 0) refuse('render', 'raa', 'the zone lobby capture returned no PNG bytes; the RAA port must read the canvas back')
    const info = joined.info
    return {
      renderer: 'raa',
      adapter,
      matched: { peers: info.peers, seats: info.seats, localPeer: info.localPeer },
      ticks: info.tick,
      near: info.near,
      far: info.far,
      session: sessionOf(joined),
      captures: [{ name: 'zone-lobby', width: input.width, height: input.height, mime: 'image/png', base64: base64Of(png) }],
    }
  } catch (error) {
    phase(`failed: ${error instanceof Error ? error.message : String(error)}`)
    // A join that outlived its bound still owns a socket and a scene: dispose it when it settles.
    if (lobby === null) void mounting?.then(late => late.dispose(), () => {})
    throw error
  } finally {
    try { lobby?.dispose() } finally { canvas.remove() }
  }
}

function opFailure(op: string, error: unknown): never {
  // mountZoneLobby already refuses with the text of its cause; keep it verbatim.
  if (isRefusal(error)) throw error
  return refuse('ops', op, error instanceof Error ? error.message : String(error))
}

async function zoneLobbyCapture(raw: unknown): Promise<OpEnvelope<ZoneLobbyCaptureOutput>> {
  const input = validate(raw)
  phases.clear()
  publishPhase('page', 'checking RAA and the GPU adapter')
  const adapter = await bounded('page', 'the RAA check', READY_TIMEOUT_MS, prelude())
  phases.clear()
  try { return { json: await runLobby(input, adapter), files: [] } }
  catch (error) { return opFailure('zoneLobbyCapture', error) }
}

export interface ZoneLobbyPairInput { peers: [ZoneLobbyCaptureInput, ZoneLobbyCaptureInput] }
interface ZoneLobbyPairOutput { runs: ZoneLobbyCaptureOutput[] }

// Two browser peers of the same room in one GPU job: the GPU broker runs one job per project at a time,
// so two separate capture jobs never overlap and a room that needs both of them never fills.
async function zoneLobbyPair(raw: unknown): Promise<OpEnvelope<ZoneLobbyPairOutput>> {
  const op = 'zoneLobbyPair'
  const o = obj(op, 'input', raw)
  onlyKeys(op, 'input', o, ['peers'])
  if (!Array.isArray(o.peers) || o.peers.length !== 2) refuse('ops', `${op}.input.peers`, 'pass exactly two zoneLobbyCapture inputs')
  const peers = o.peers.map(validate)
  if (peers[0].name === peers[1].name) refuse('ops', `${op}.input.peers`, `both peers are named '${peers[0].name}'; give each a distinct name`)
  phases.clear()
  publishPhase('page', 'checking RAA and the GPU adapter')
  const adapter = await bounded('page', 'the RAA check', READY_TIMEOUT_MS, prelude())
  phases.clear()
  // Both join concurrently; a failure of one is reported only after the other has settled and cleaned up.
  const settled = await Promise.allSettled(peers.map(input => runLobby(input, adapter)))
  const failed = settled.findIndex(result => result.status === 'rejected')
  if (failed >= 0) {
    const reason = (settled[failed] as PromiseRejectedResult).reason
    return opFailure(`${op}.${peers[failed].name}`, reason)
  }
  return { json: { runs: settled.map(result => (result as PromiseFulfilledResult<ZoneLobbyCaptureOutput>).value) }, files: [] }
}

type ZoneLobbyOps = {
  zoneLobbyCapture(input: unknown): Promise<OpEnvelope<ZoneLobbyCaptureOutput>>
  zoneLobbyPair(input: unknown): Promise<OpEnvelope<ZoneLobbyPairOutput>>
}

// window.nmcGpu.ops.zoneLobbyCapture and zoneLobbyPair, next to the game page's ops. Registering has no side effect.
export function installZoneLobbyOps(): void {
  const gpu = window.nmcGpu
  if (gpu === undefined) refuse('ops', 'installZoneLobbyOps', 'window.nmcGpu is missing; install the base GPU ops first')
  const ops = gpu.ops as unknown as ZoneLobbyOps
  ops.zoneLobbyCapture = zoneLobbyCapture
  ops.zoneLobbyPair = zoneLobbyPair
}
