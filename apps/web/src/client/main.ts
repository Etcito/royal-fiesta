// client.html entry: ?mode=inpage|relay|webrtc plays a match; ?mode=ops only installs the GPU client ops.
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { NetTransport } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { InPageMatch } from '@royal-fiesta/game/client/inpageMatch'
import { controlsToInput, emptyControls } from '@royal-fiesta/game/client/inputMap'
import type { RawControls } from '@royal-fiesta/game/client/inputMap'
import { createNetMatch } from '@royal-fiesta/game/net/netMatch'
import type { NetMatch } from '@royal-fiesta/game/net/netMatch'
import { Pilot } from '@royal-fiesta/game/net/pilot'
import { RelayClient } from '@royal-fiesta/game/net/relayClient'
import { RelayTransport } from '@royal-fiesta/game/net/relayTransport'
import { browserRtcBackend } from '@royal-fiesta/game/net/rtcBackend'
import { RoomsClient } from '@royal-fiesta/game/net/roomsClient'
import { fiestaLocalPlayer } from '@royal-fiesta/game/net/roomsProtocol'
import { netSetup } from '@royal-fiesta/game/net/tuning'
import { WebRtcTransport } from '@royal-fiesta/game/net/webrtcTransport'
import { globalWsFactory } from '@royal-fiesta/game/net/ws'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import type { RenderPort, Viewport } from '@royal-fiesta/game/render/port'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { refuse } from '@royal-fiesta/sim/refusal'
import { installNmcOps } from '../nmc/ops.ts'
import { createRaaPort } from '../render/raaPort.ts'
import { raaStatus } from '../render/raaStatus.ts'
import { mountHud } from './hud.ts'
import { browserAssetResolver, browserCourses, preloadAssets } from './sources.ts'

type Mode = 'inpage' | 'relay' | 'webrtc'
interface Query { mode: Mode; clients: number; seed: number; profile: ProfileName; server: string | null; pilot: boolean; room: string | null }
type Hud = ReturnType<typeof mountHud>

// Same in-page network as the round captures, so the page shows what the captures show.
const INPAGE_NET = { rttMs: 100, jitterMs: 10, loss: 0.02 }
const NAMES = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `Bean ${n}`)
const STICK_DEADZONE = 0.15

function intParam(q: URLSearchParams, key: string, def: number, min: number, max: number): number {
  const raw = q.get(key)
  if (raw === null) return def
  const n = Number(raw)
  if (!/^-?\d+$/.test(raw) || n < min || n > max) refuse('query', key, `'${raw}' is not an integer in ${min}..${max}; fix ?${key}=`)
  return n
}

function parseQuery(search: string): Query {
  const q = new URLSearchParams(search)
  const mode = q.get('mode') ?? 'inpage'
  if (mode !== 'inpage' && mode !== 'relay' && mode !== 'webrtc') refuse('query', 'mode', `'${mode}' is not inpage, relay, webrtc or ops; fix ?mode=`)
  const clients = intParam(q, 'clients', 4, 1, 4)
  const seed = intParam(q, 'seed', 1, 0, 0xffffffff)
  const profile = q.get('profile') ?? 'sprint'
  if (profile !== 'sprint' && profile !== 'standard') refuse('query', 'profile', `'${profile}' is not sprint or standard; fix ?profile=`)
  const pilotRaw = q.get('pilot') ?? '0'
  if (pilotRaw !== '0' && pilotRaw !== '1') refuse('query', 'pilot', `'${pilotRaw}' is not 0 or 1; fix ?pilot=`)
  const server = q.get('server')
  if (mode !== 'inpage') {
    if (server === null) refuse('query', 'server', `is required for mode=${mode}; pass ?server=ws://host:port/...`)
    if (!/^wss?:\/\/./.test(server)) refuse('query', 'server', `'${server}' is not a ws:// or wss:// URL; pass ?server=ws://host:port/...`)
  }
  const room = q.get('room')
  if (room !== null && !/^[A-Za-z0-9-]{1,32}$/.test(room)) refuse('query', 'room', `'${room}' is not a room code; pass the code the room owner shows`)
  return { mode, clients, seed, profile, server: mode === 'inpage' ? null : server, pilot: pilotRaw === '1', room }
}

function trackControls(): () => RawControls {
  const keys = new Set<string>()
  const prevent = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
  window.addEventListener('keydown', e => {
    keys.add(e.code)
    if (prevent.has(e.code)) e.preventDefault()
  })
  window.addEventListener('keyup', e => keys.delete(e.code))
  window.addEventListener('blur', () => keys.clear())
  const c = emptyControls()
  return () => {
    c.forward = keys.has('KeyW') || keys.has('ArrowUp')
    c.back = keys.has('KeyS') || keys.has('ArrowDown')
    c.left = keys.has('KeyA') || keys.has('ArrowLeft')
    c.right = keys.has('KeyD') || keys.has('ArrowRight')
    c.jump = keys.has('Space')
    c.dive = keys.has('ShiftLeft') || keys.has('ShiftRight')
    c.grab = keys.has('KeyE')
    c.stickX = 0
    c.stickY = 0
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : []
    for (const pad of pads) {
      if (!pad) continue
      const x = pad.axes[0] ?? 0
      const y = pad.axes[1] ?? 0
      // Gamepad up is -axis1; RawControls up is +stickY.
      if (Math.abs(x) > STICK_DEADZONE || Math.abs(y) > STICK_DEADZONE) {
        c.stickX = x
        c.stickY = -y
      }
      const b = (i: number) => pad.buttons[i]?.pressed === true
      c.jump ||= b(0)
      c.dive ||= b(1)
      c.grab ||= b(2)
      break
    }
    return c
  }
}

// Camera facing on XZ (target - eye); +Z until the camera exists.
function facingOf(view: SceneView): { x: number; z: number } {
  const cam = view.camera
  if (cam === null) return { x: 0, z: 1 }
  const x = cam.target[0] - cam.eye[0]
  const z = cam.target[2] - cam.eye[2]
  const len = Math.sqrt(x * x + z * z)
  return len > 1e-6 ? { x: x / len, z: z / len } : { x: 0, z: 1 }
}

// note is the standing banner that network status messages fall back to.
async function pickPort(hud: Hud): Promise<{ port: RenderPort; note: string }> {
  if ((await raaStatus()).available) return { port: await createRaaPort(), note: '' }
  const note = 'RAA API v0 not available: null render port'
  hud.banner(note)
  return { port: new NullRenderPort(), note }
}

// Several in-page clients share one port as a 2x2 grid, client k at column k%2 and row floor(k/2).
function viewportsOf(width: number, height: number, count: number): Viewport[] {
  if (count === 1) return [{ x: 0, y: 0, width, height }]
  const w = Math.floor(width / 2)
  const h = Math.floor(height / 2)
  const out: Viewport[] = []
  for (let k = 0; k < count; k++) out.push({ x: (k % 2) * w, y: Math.floor(k / 2) * h, width: w, height: h })
  return out
}

function loop(frame: (dtS: number) => void): void {
  let last = performance.now()
  const tick = (now: number) => {
    const dt = Math.min(0.1, Math.max(0, now - last) / 1000)
    last = now
    frame(dt)
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

interface Ctx { note: string; q: Query; R: RapierModule; hud: Hud; port: RenderPort; canvas: HTMLCanvasElement; courses: ResolvedCourse[]; assets: (name: string) => PrimsAsset }

async function initPort(ctx: Ctx, viewports: number): Promise<void> {
  const width = Math.max(1, Math.floor(window.innerWidth))
  const height = Math.max(1, Math.floor(window.innerHeight))
  ctx.canvas.width = width
  ctx.canvas.height = height
  await ctx.port.init({ canvas: ctx.canvas, width, height, viewports: viewportsOf(width, height, viewports) })
}

function runInPage(ctx: Ctx, controls: () => RawControls): void {
  const { q } = ctx
  // Client 0 is this page's player; the other in-page clients are always piloted.
  const pilots = Array.from({ length: q.clients }, (_, k) => k > 0 || q.pilot)
  const match = new InPageMatch({
    R: ctx.R, clients: q.clients, seed: q.seed, profile: q.profile, courses: ctx.courses, ports: [ctx.port],
    assets: ctx.assets, bean: ctx.assets('bean'), net: INPAGE_NET, pilots,
  })
  const state = emptyViewState()
  loop(dt => {
    const c = controls()
    match.frame(dt, (client, out) => {
      if (client === 0) controlsToInput(c, facingOf(match.views[0]), out)
    })
    ctx.hud.update(match.matches[0].sim.phase(state), NAMES, 0)
  })
}

// One networked client: NetMatch + SceneView for the local player, driven by the keyboard/gamepad or a Pilot.
function runNet(ctx: Ctx, net: NetTransport, localPeer: number, humanPeers: number, seed: number, controls: () => RawControls, endFrame: () => void): void {
  const setup = netSetup(seed, humanPeers, ctx.q.profile, ctx.courses)
  const match: NetMatch = createNetMatch(ctx.R, { setup, localPeer, humanPeers }, net, { cpuMs: () => performance.now() })
  const view = new SceneView({ port: ctx.port, viewport: 0, localPlayer: localPeer, assets: ctx.assets, bean: ctx.assets('bean') })
  const pilot = ctx.q.pilot ? new Pilot(localPeer, seed) : null
  const state = emptyViewState()
  loop(dt => {
    const c = controls()
    const alpha = match.frame(dt, out => {
      const i: PlayerInput = out[0]
      if (pilot !== null) {
        pilot.sample(match.sim, i)
        return
      }
      controlsToInput(c, facingOf(view), i)
    })
    endFrame()
    view.update(match.sim, match.session.smoother, alpha, dt)
    ctx.port.render()
    ctx.hud.update(match.sim.phase(state), NAMES, localPeer)
  })
}

async function runRelay(ctx: Ctx, server: string, controls: () => RawControls): Promise<void> {
  const client = new RelayClient(server, globalWsFactory())
  await client.connect()
  ctx.hud.banner(`Queueing for ${ctx.q.clients} players...`)
  const colour = Math.floor(Math.random() * NAMES.length)
  const matched = await client.queue(ctx.q.clients, { g: 'royal-fiesta', v: 1, name: `Bean ${colour + 1}`, c: colour })
  ctx.hud.banner(ctx.note)
  const now = () => performance.now()
  const transport = new RelayTransport(client, matched.youAre, matched.players, now)
  runNet(ctx, transport, matched.youAre, matched.players, matched.seed, controls, () => transport.endFrame())
}

async function runWebRtc(ctx: Ctx, server: string, controls: () => RawControls): Promise<void> {
  const rooms = new RoomsClient(server, globalWsFactory())
  await rooms.hello('Bean')
  const owner = ctx.q.room === null
  const room = owner
    ? await rooms.create(fiestaLocalPlayer('Bean', 0), true)
    : await rooms.join(ctx.q.room as string, fiestaLocalPlayer('Bean', 0))
  const want = Math.max(2, ctx.q.clients)
  const show = (members: number) => ctx.hud.banner(`Room ${room.code}: ${members} / ${want} players${owner ? ` - share ?mode=webrtc&room=${room.code}` : ''}`)
  show(room.members.length)
  let starting = false
  const maybeStart = (members: number) => {
    show(members)
    // The owner starts once the room holds ?clients players.
    if (owner && !starting && members >= want) {
      starting = true
      rooms.start().catch(e => ctx.hud.banner(messageOf(e)))
    }
  }
  rooms.onRoom(r => maybeStart(r.members.length))
  maybeStart(room.members.length)
  const started = await rooms.waitStarted(10 * 60 * 1000)
  const ids = started.members.map(m => m.peer).sort((a, b) => a - b)
  // createNetMatch uses evenPeers, so rooms peer ids must be exactly the ranks 0..n-1.
  if (ids.some((id, k) => id !== k)) refuse('webrtc', 'started.members', `peer ids ${ids.join(',')} are not 0..${ids.length - 1}; create a fresh room`)
  ctx.hud.banner('Connecting peers...')
  const transport = await WebRtcTransport.connect(rooms, started, browserRtcBackend(), () => performance.now())
  ctx.hud.banner(ctx.note)
  runNet(ctx, transport, transport.selfPeer, ids.length, started.seed, controls, () => {})
}

function emptyViewState(): MatchViewState {
  return {
    tick: 0, phase: 0, phaseTicksLeft: 0, roundIndex: -1, roundKind: null, final: false, courseIndex: -1,
    roundTicksLeft: 0, alive: 0, target: 0, qualifiedCount: 0, winner: -1, podium: [],
  }
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

async function main(): Promise<void> {
  installNmcOps()
  const search = window.location.search
  if (new URLSearchParams(search).get('mode') === 'ops') return
  const canvas = document.querySelector<HTMLCanvasElement>('#view')
  const hudRoot = document.querySelector<HTMLElement>('#hud')
  if (canvas === null || hudRoot === null) throw new Error('client.html needs canvas#view and div#hud')
  const hud = mountHud(hudRoot)
  try {
    const q = parseQuery(search)
    const { port, note } = await pickPort(hud)
    const R = await initRapier()
    const courses = await browserCourses(q.profile)
    const assets = await preloadAssets(courses, browserAssetResolver())
    const ctx: Ctx = { note, q, R, hud, port, canvas, courses, assets }
    await initPort(ctx, q.mode === 'inpage' ? q.clients : 1)
    const controls = trackControls()
    if (q.mode === 'inpage') runInPage(ctx, controls)
    else if (q.mode === 'relay') await runRelay(ctx, q.server as string, controls)
    else await runWebRtc(ctx, q.server as string, controls)
  } catch (e) {
    hud.banner(messageOf(e))
    console.error(e)
  }
}

void main()
