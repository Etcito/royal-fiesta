// play.html entry: the walkable hub. ?server=ws://... plays online; ?mode=inpage runs N piloted clients over a
// LoopbackRelay; ?mode=ops only installs the GPU client ops.
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { basisFromFacing } from '@royal-fiesta/game/client/cameraBasis'
import type { Planar } from '@royal-fiesta/game/client/cameraBasis'
import { controlsToInput, emptyControls } from '@royal-fiesta/game/client/inputMap'
import type { RawControls } from '@royal-fiesta/game/client/inputMap'
import { loadCourse } from '@royal-fiesta/game/course'
import { PlayFlow } from '@royal-fiesta/game/hub/flow'
import type { FlowState } from '@royal-fiesta/game/hub/flow'
import { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import type { NetMatch } from '@royal-fiesta/game/net/netMatch'
import { globalWsFactory } from '@royal-fiesta/game/net/ws'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { refuse } from '@royal-fiesta/sim/refusal'
import plazaJson from '../../../../fixtures/courses/hub-plaza.course.json?raw'
import { initPerClient, planCanvases } from '../client/canvases.ts'
import type { ClientCell } from '../client/canvases.ts'
import { mountHud } from '../client/hud.ts'
import { browserAssetResolver, browserCourses, preloadAssets } from '../client/sources.ts'
import { GameInput } from '../input/input.ts'
import { createRaaPort } from '../render/raaPort.ts'
import { SoundDriver } from './sound.ts'
import { raaStatus } from '../render/raaStatus.ts'
import { HubView } from './hubView.ts'
import { InPageHubLoop } from './inpageHub.ts'
import { installPlayOps } from './ops.ts'

type Hud = ReturnType<typeof mountHud>
type Query =
  | { mode: 'online'; server: string; hub: string | 'new'; name: string; colour: number; party: 2 | 3 | 4 }
  | { mode: 'inpage'; clients: number }
// ports: one RenderPort per client canvas (each in-page client has its own canvas and RAA engine).
interface Ctx { note: string; R: RapierModule; hud: Hud; ports: RenderPort[]; courses: ResolvedCourse[]; plaza: ResolvedCourse; assets: (name: string) => PrimsAsset }

// Look sensitivity setting 1..10; docs/controls.md default.
const LOOK_SENSITIVITY = 5

function intParam(q: URLSearchParams, key: string, def: number, min: number, max: number): number {
  const raw = q.get(key)
  if (raw === null) return def
  const n = Number(raw)
  if (!/^-?\d+$/.test(raw) || n < min || n > max) refuse('query', key, `'${raw}' is not an integer in ${min}..${max}; fix ?${key}=`)
  return n
}

function parseQuery(search: string): Query {
  const q = new URLSearchParams(search)
  const mode = q.get('mode')
  if (mode !== null && mode !== 'inpage') refuse('query', 'mode', `'${mode}' is not inpage or ops; drop ?mode= to play online`)
  if (mode === 'inpage') return { mode: 'inpage', clients: intParam(q, 'clients', 4, 2, 4) }
  const server = q.get('server')
  if (server === null) refuse('query', 'server', 'is required unless mode=inpage; pass ?server=ws://host:port/...')
  if (!/^wss?:\/\/./.test(server)) refuse('query', 'server', `'${server}' is not a ws:// or wss:// URL; pass ?server=ws://host:port/...`)
  const hub = q.get('hub') ?? 'new'
  if (hub !== 'new' && !/^\d{4}$/.test(hub)) refuse('query', 'hub', `'${hub}' is not new or a 4-digit code; pass the code the hub shows`)
  const name = q.get('name') ?? 'Bean'
  if (name.length < 1 || name.length > 24) refuse('query', 'name', `has ${name.length} characters; choose a name of 1..24 characters`)
  const colour = intParam(q, 'colour', Math.floor(Math.random() * 8), 0, 7)
  const party = intParam(q, 'party', 4, 2, 4) as 2 | 3 | 4
  return { mode: 'online', server, hub, name, colour, party }
}

// PlayFlow applies controlsToInput with the character facing, so the camera-relative world move w is
// re-expressed as a stick in that frame: stickX = w · right, stickY = w · forward of basisFromFacing(charFacing).
function inCharacterFrame(w: PlayerInput, charFacing: Planar, out: RawControls): RawControls {
  const b = basisFromFacing(charFacing)
  out.left = out.right = out.forward = out.back = false
  out.stickX = w.moveX * b.right.x + w.moveZ * b.right.z
  out.stickY = w.moveX * b.forward.x + w.moveZ * b.forward.z
  out.jump = w.jump
  out.dive = w.dive
  out.grab = w.grab
  return out
}

// note is the standing banner line that status lines are joined with. makePort builds one port per canvas.
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

function banner(ctx: Ctx, lines: string[]): void {
  ctx.hud.banner([...lines, ctx.note].filter(l => l.length > 0).join(' - '))
}

function queueLine(state: FlowState, party: number): string {
  if (state === 'connecting') return 'Connecting...'
  if (state === 'hub') return 'Walk onto the green pad to queue'
  if (state === 'queued') return `Queued for ${party} players...`
  if (state === 'match' || state === 'podium') return 'Match!'
  if (state === 'returning') return 'Back to the hub...'
  return 'Hub failed'
}

// One online client: this page's bean in the hub, then its match, then back. Moves and look go through
// GameInput; the orbit camera frames the bean and gives controlsToInput its camera facing.
function runOnline(ctx: Ctx, q: Extract<Query, { mode: 'online' }>, input: GameInput): void {
  const port = ctx.ports[0]
  let seat = 0
  let failure = ''
  const flow = new PlayFlow({
    R: ctx.R, relayUrl: q.server, ws: globalWsFactory(), hubCode: q.hub, name: q.name, colour: q.colour,
    courses: ctx.courses, plaza: ctx.plaza, partySize: q.party, now: () => performance.now(), pilot: false,
    log: ev => {
      if (ev.state === 'match' && typeof ev.detail.seat === 'number') seat = ev.detail.seat
      if (ev.state === 'failed') failure = String(ev.detail.message ?? '')
      console.info('[play]', ev.state, ev.detail)
    },
  })
  void flow.start()
  const sound = new SoundDriver()
  const orbit = new OrbitCamera()
  const hubView = new HubView(port, 0, ctx.assets, ctx.assets('bean'), ctx.plaza, { orbit })
  const local: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
  const matchChar: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }
  const view = emptyViewState()
  const world = neutralInput()
  const moved = emptyControls()
  let names: string[] = []
  let scene: SceneView | null = null
  let viewed: NetMatch | null = null
  let shown = ''
  const show = (lines: string[]) => {
    const text = lines.join('\n')
    if (text !== shown) banner(ctx, lines)
    shown = text
  }
  loop(dt => {
    const now = performance.now()
    const look = input.takeLook()
    orbit.mouse(look.dx, look.dy, LOOK_SENSITIVITY, false)
    orbit.stick(look.rx, look.ry, dt, LOOK_SENSITIVITY, false)
    let emote = 0
    for (const ev of input.takeEvents()) if (ev.k === 'emote') emote = ev.id
    const before = flow.state
    let charFacing: Planar = { x: 0, z: 1 }
    if (flow.match !== null) charFacing = flow.match.sim.character(seat, matchChar).facing
    else if (before === 'hub' || before === 'queued') charFacing = flow.hub.state(local).facing
    controlsToInput(input.controls(), orbit.ground(), world)
    flow.frame(dt, inCharacterFrame(world, charFacing, moved), emote)
    const match = flow.match
    if (match !== viewed) {
      scene?.dispose()
      scene = null
      viewed = match
      // Each match, and the hub after it, starts looking along +Z.
      orbit.reset(0)
      // Hide the hub before the match view's first update (its dressing leaves before the course's enters).
      hubView.setVisible(match === null)
      if (match !== null) {
        scene = new SceneView({
          port, viewport: 0, localPlayer: seat, assets: ctx.assets, bean: ctx.assets('bean'), camera: focus => orbit.pose(focus),
        })
        names = Array.from({ length: 8 }, (_, p) => (p === seat ? q.name : `Bean ${p + 1}`))
        show([])
      }
    }
    sound.frame(match?.sim ?? null)
    const state = flow.state
    if (match !== null && scene !== null) {
      scene.update(match.sim, match.session.smoother, 1, dt)
      ctx.hud.update(match.sim.phase(view), names, seat)
    } else {
      const remotes = state === 'connecting' || state === 'failed' ? [] : flow.remotes(now)
      if (state === 'hub' || state === 'queued') {
        hubView.update(flow.hub.state(local), q.colour, remotes, flow.hub.tick, dt, flow.hub.emote(now))
      }
      const lines: string[] = []
      if (flow.hubCode !== null) lines.push(`Hub ${flow.hubCode} - ${1 + remotes.length}/4 online`)
      lines.push(queueLine(state, q.party))
      if (state === 'failed' && failure.length > 0) lines.push(failure)
      show(lines)
    }
    port.render()
  })
}

// N piloted clients in one page over a LoopbackRelay, one canvas and port per client in a 2x2 grid.
// Real-time dt with deps.now = performance.now, so the relay's rate limits see the same clock.
function runInPage(ctx: Ctx, clients: number): void {
  const now = () => performance.now()
  const hub = new InPageHubLoop(ctx.R, clients, new LoopbackRelay(), {
    R: ctx.R, courses: ctx.courses, plaza: ctx.plaza, partySize: clients as 2 | 3 | 4, now, pilot: true,
  }, ctx.ports, { assets: ctx.assets, bean: ctx.assets('bean') })
  let shown = ''
  loop(dt => {
    hub.frame(dt)
    const code = hub.flows[0].hubCode ?? '....'
    const states = hub.flows.map((f, k) => `Bean ${k + 1} ${f.state}`).join(', ')
    const lines = [`Hub ${code} - ${hub.flows.length}/${clients} clients`, states]
    if (hub.done) lines.push('loop done')
    const failed = [...hub.events].reverse().find(e => e.state === 'failed')
    if (failed) lines.push(String(failed.detail.message ?? 'failed'))
    const text = lines.join('\n')
    if (text !== shown) banner(ctx, lines)
    shown = text
  })
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
  installPlayOps()
  const search = window.location.search
  if (new URLSearchParams(search).get('mode') === 'ops') return
  const views = document.querySelector<HTMLElement>('#views')
  const hudRoot = document.querySelector<HTMLElement>('#hud')
  if (views === null || hudRoot === null) throw new Error('play.html needs main#views and div#hud')
  const hud = mountHud(hudRoot)
  try {
    const q = parseQuery(search)
    const { makePort, note } = await pickPort(hud)
    const R = await initRapier()
    const courses = await browserCourses('sprint')
    const resolver = browserAssetResolver()
    const plaza = await loadCourse(JSON.parse(plazaJson), 'fixtures/courses/hub-plaza.course.json', resolver)
    const assets = await preloadAssets([...courses, plaza], resolver)
    const width = Math.max(1, Math.floor(window.innerWidth))
    const height = Math.max(1, Math.floor(window.innerHeight))
    const plan = planCanvases(width, height, q.mode === 'inpage' ? q.clients : 1)
    views.style.gridTemplateColumns = `repeat(${plan.cols}, 1fr)`
    views.style.gridTemplateRows = `repeat(${plan.rows}, 1fr)`
    const mounted = await initPerClient(plan, cell => mountCanvas(views, cell), () => makePort())
    const ctx: Ctx = { note, R, hud, ports: mounted.map(m => m.port), courses, plaza, assets }
    if (q.mode === 'inpage') runInPage(ctx, q.clients)
    else {
      // Clicking the canvas locks the pointer for the mouse look.
      const canvas = mounted[0].canvas as HTMLCanvasElement
      runOnline(ctx, q, new GameInput(window, canvas, () => canvas))
    }
  } catch (e) {
    hud.banner(messageOf(e))
    console.error(e)
  }
}

void main()
