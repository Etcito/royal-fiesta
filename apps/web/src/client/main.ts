// client.html entry: ?mode=inpage|relay|webrtc plays a match; ?mode=ops only installs the GPU client ops.
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { NetTransport } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { openBrowserAudio } from '@royal-fiesta/game/audio/context'
import { cameraBasis } from '@royal-fiesta/game/client/cameraBasis'
import type { Planar } from '@royal-fiesta/game/client/cameraBasis'
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
import type { RenderPort } from '@royal-fiesta/game/render/port'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { refuse } from '@royal-fiesta/sim/refusal'
import { installNmcOps } from '../nmc/ops.ts'
import { createRaaPort } from '../render/raaPort.ts'
import { raaStatus } from '../render/raaStatus.ts'
import { initPerClient, planCanvases } from './canvases.ts'
import type { ClientCell } from './canvases.ts'
import { mountHud } from './hud.ts'
import { parseQuery } from './query.ts'
import type { Query } from './query.ts'
import { browserAssetResolver, browserCourses, preloadAssets } from './sources.ts'
import { ClientSound } from './sound.ts'
// Vite bundles the crowd worklet and returns its URL (dev and build alike).
import fiestaWorkletUrl from '../audio/fiestaWorklet.ts?worker&url'

type Hud = ReturnType<typeof mountHud>

// Same in-page network as the round captures, so the page shows what the captures show.
const INPAGE_NET = { rttMs: 100, jitterMs: 10, loss: 0.02 }
const NAMES = [1, 2, 3, 4, 5, 6, 7, 8].map(n => `Bean ${n}`)
const STICK_DEADZONE = 0.15

// Raw keys and the first pad's left stick only; the world direction comes from controlsToInput (cameraBasis).
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

// Camera forward on XZ from the shared basis (ARCHITECTURE 1.6); +Z until the camera exists.
function facingOf(view: SceneView): Planar {
  const cam = view.camera
  return cam === null ? { x: 0, z: 1 } : cameraBasis(cam.eye, cam.target).forward
}

// note is the standing banner that network status messages fall back to. makePort builds one port per canvas.
async function pickPort(hud: Hud): Promise<{ makePort: () => Promise<RenderPort>; note: string }> {
  if ((await raaStatus()).available) return { makePort: () => createRaaPort(), note: '' }
  const note = 'RAA API v0 not available: null render port'
  hud.banner(note)
  return { makePort: async () => new NullRenderPort(), note }
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

// ports: one RenderPort per client canvas (each in-page client has its own canvas and RAA engine).
// sound: only client 0's match is heard (in-page clients 1..n are silent); networked modes hear their own match.
interface Ctx { note: string; q: Query; R: RapierModule; hud: Hud; ports: RenderPort[]; courses: ResolvedCourse[]; assets: (name: string) => PrimsAsset; sound: ClientSound }

function runInPage(ctx: Ctx, controls: () => RawControls): void {
  const { q } = ctx
  // Client 0 is this page's player; the other in-page clients are always piloted.
  const pilots = Array.from({ length: q.clients }, (_, k) => k > 0 || q.pilot)
  const match = new InPageMatch({
    R: ctx.R, clients: q.clients, seed: q.seed, profile: q.profile, courses: ctx.courses, ports: ctx.ports,
    assets: ctx.assets, bean: ctx.assets('bean'), net: INPAGE_NET, pilots,
  })
  const state = emptyViewState()
  loop(dt => {
    const c = controls()
    match.frame(dt, (client, out) => {
      if (client === 0) controlsToInput(c, facingOf(match.views[0]), out)
    })
    ctx.sound.frame(match.matches[0].sim)
    ctx.hud.update(match.matches[0].sim.phase(state), NAMES, 0)
  })
}

// One networked client: NetMatch + SceneView for the local player, driven by the keyboard/gamepad or a Pilot.
function runNet(ctx: Ctx, net: NetTransport, localPeer: number, humanPeers: number, seed: number, controls: () => RawControls, endFrame: () => void): void {
  const setup = netSetup(seed, humanPeers, ctx.q.profile, ctx.courses)
  const match: NetMatch = createNetMatch(ctx.R, { setup, localPeer, humanPeers }, net, { cpuMs: () => performance.now() })
  const view = new SceneView({ port: ctx.ports[0], viewport: 0, localPlayer: localPeer, assets: ctx.assets, bean: ctx.assets('bean') })
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
    ctx.sound.frame(match.sim)
    ctx.ports[0].render()
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

// One canvas per client, appended to the #views grid in client order.
function mountCanvas(root: HTMLElement, cell: ClientCell): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = cell.canvasWidth
  canvas.height = cell.canvasHeight
  canvas.dataset.client = String(cell.client)
  root.appendChild(canvas)
  return canvas
}

async function main(): Promise<void> {
  installNmcOps()
  const search = window.location.search
  if (new URLSearchParams(search).get('mode') === 'ops') return
  const views = document.querySelector<HTMLElement>('#views')
  const hudRoot = document.querySelector<HTMLElement>('#hud')
  if (views === null || hudRoot === null) throw new Error('client.html needs main#views and div#hud')
  const hud = mountHud(hudRoot)
  // The sound opens on the first gesture (pointer or key); a failure only logs a warning.
  const sound = new ClientSound({
    manifestUrl: new URL('audio/manifest.json', document.baseURI).href,
    open: manifestUrl => openBrowserAudio({
      manifestUrl,
      processorUrl: new URL('audio/haa-processors.js', document.baseURI).href,
      crowdProcessorUrl: fiestaWorkletUrl,
      maxListeners: 1,
    }),
    fetchJson: async url => {
      const res = await fetch(url)
      if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`)
      return res.json()
    },
    warn: message => console.warn(`[sound] ${message}`),
  })
  sound.arm(window)
  sound.expose(window)
  try {
    const q = parseQuery(search)
    const { makePort, note } = await pickPort(hud)
    const R = await initRapier()
    const courses = await browserCourses(q.profile)
    const assets = await preloadAssets(courses, browserAssetResolver())
    // One canvas per in-page client, each with its own port; networked modes draw one canvas.
    const width = Math.max(1, Math.floor(window.innerWidth))
    const height = Math.max(1, Math.floor(window.innerHeight))
    const plan = planCanvases(width, height, q.mode === 'inpage' ? q.clients : 1)
    views.style.gridTemplateColumns = `repeat(${plan.cols}, 1fr)`
    views.style.gridTemplateRows = `repeat(${plan.rows}, 1fr)`
    const mounted = await initPerClient(plan, cell => mountCanvas(views, cell), () => makePort())
    const ctx: Ctx = { note, q, R, hud, ports: mounted.map(m => m.port), courses, assets, sound }
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
