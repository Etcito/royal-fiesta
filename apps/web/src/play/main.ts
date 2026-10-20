// play.html entry: the walkable hub. ?server=ws://... plays online; ?mode=inpage runs N piloted clients over a
// LoopbackRelay; ?mode=ops only installs the GPU client ops.
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { emptyControls } from '@royal-fiesta/game/client/inputMap'
import type { RawControls } from '@royal-fiesta/game/client/inputMap'
import { loadCourse } from '@royal-fiesta/game/course'
import { PlayFlow } from '@royal-fiesta/game/hub/flow'
import type { FlowState } from '@royal-fiesta/game/hub/flow'
import { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import type { NetMatch } from '@royal-fiesta/game/net/netMatch'
import { globalWsFactory } from '@royal-fiesta/game/net/ws'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import type { CameraPose, RenderPort, Viewport } from '@royal-fiesta/game/render/port'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { CharState } from '@royal-fiesta/sim/character/system'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { CharacterView, MatchViewState } from '@royal-fiesta/sim/match/matchSim'
import { refuse } from '@royal-fiesta/sim/refusal'
import plazaJson from '../../../../fixtures/courses/hub-plaza.course.json?raw'
import { mountHud } from '../client/hud.ts'
import { browserAssetResolver, browserCourses, preloadAssets } from '../client/sources.ts'
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
interface Ctx { note: string; R: RapierModule; hud: Hud; port: RenderPort; courses: ResolvedCourse[]; plaza: ResolvedCourse; assets: (name: string) => PrimsAsset }

const STICK_DEADZONE = 0.15
const EMOTE_KEYS = ['Digit1', 'Digit2', 'Digit3', 'Digit4']

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

function trackControls(): { controls: () => RawControls; takeEmote: () => number } {
  const keys = new Set<string>()
  const prevent = new Set(['Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'])
  let emote = 0
  window.addEventListener('keydown', e => {
    keys.add(e.code)
    if (prevent.has(e.code)) e.preventDefault()
    // Keydown edges only: a held key does not repeat the emote.
    const id = EMOTE_KEYS.indexOf(e.code)
    if (id >= 0 && !e.repeat) emote = id + 1
  })
  window.addEventListener('keyup', e => keys.delete(e.code))
  window.addEventListener('blur', () => keys.clear())
  const c = emptyControls()
  const controls = () => {
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
  const takeEmote = () => {
    const id = emote
    emote = 0
    return id
  }
  return { controls, takeEmote }
}

function unit(x: number, z: number): { x: number; z: number } {
  const len = Math.sqrt(x * x + z * z)
  return len > 1e-6 ? { x: x / len, z: z / len } : { x: 0, z: 1 }
}

// Camera facing on XZ (target - eye); +Z until the camera exists.
function facingOf(cam: CameraPose | null): { x: number; z: number } {
  return cam === null ? { x: 0, z: 1 } : unit(cam.target[0] - cam.eye[0], cam.target[2] - cam.eye[2])
}

// PlayFlow rotates controls by the character's facing; re-express the camera-relative move as a stick in that frame
// so the bean moves where the camera looks.
function cameraRelative(c: RawControls, cam: { x: number; z: number }, char: { x: number; z: number }, out: RawControls): RawControls {
  let x = (c.right ? 1 : 0) - (c.left ? 1 : 0)
  let y = (c.forward ? 1 : 0) - (c.back ? 1 : 0)
  if (Math.abs(c.stickX) + Math.abs(c.stickY) > STICK_DEADZONE) {
    x = c.stickX
    y = c.stickY
  }
  const len = Math.sqrt(x * x + y * y)
  if (len > 1) {
    x /= len
    y /= len
  }
  // World move: right = (f.z, -f.x), as in controlsToInput.
  const mx = cam.z * x + cam.x * y
  const mz = -cam.x * x + cam.z * y
  const f = unit(char.x, char.z)
  out.left = out.right = out.forward = out.back = false
  out.stickX = f.z * mx - f.x * mz
  out.stickY = f.x * mx + f.z * mz
  out.jump = c.jump
  out.dive = c.dive
  out.grab = c.grab
  return out
}

// note is the standing banner line that status lines are joined with.
async function pickPort(hud: Hud): Promise<{ port: RenderPort; note: string }> {
  if ((await raaStatus()).available) return { port: await createRaaPort(), note: '' }
  const note = 'RAA API v0 not available: null render port'
  hud.banner(note)
  return { port: new NullRenderPort(), note }
}

// In-page clients share one port as a 2x2 grid, client k at column k%2 and row floor(k/2).
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

// One online client: this page's bean in the hub, then its match, then back.
function runOnline(ctx: Ctx, q: Extract<Query, { mode: 'online' }>, input: ReturnType<typeof trackControls>): void {
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
  const hubView = new HubView(ctx.port, 0, ctx.assets, ctx.assets('bean'), ctx.plaza)
  const local: CharState = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0,
  }
  const matchChar: CharacterView = {
    pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, status: 0, parked: false, teleportTick: 0,
  }
  const view = emptyViewState()
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
    const before = flow.state
    let charFacing = { x: 0, z: 1 }
    let camFacing = { x: 0, z: 1 }
    if (flow.match !== null) {
      charFacing = flow.match.sim.character(seat, matchChar).facing
      camFacing = facingOf(scene?.camera ?? null)
    } else if (before === 'hub' || before === 'queued') {
      charFacing = flow.hub.state(local).facing
      camFacing = facingOf(hubView.camera)
    }
    flow.frame(dt, cameraRelative(input.controls(), camFacing, charFacing, moved), input.takeEmote())
    const match = flow.match
    if (match !== viewed) {
      scene?.dispose()
      scene = null
      viewed = match
      if (match !== null) {
        scene = new SceneView({ port: ctx.port, viewport: 0, localPlayer: seat, assets: ctx.assets, bean: ctx.assets('bean') })
        names = Array.from({ length: 8 }, (_, p) => (p === seat ? q.name : `Bean ${p + 1}`))
        show([])
      }
      hubView.setVisible(match === null)
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
    ctx.port.render()
  })
}

// N piloted clients in one page over a LoopbackRelay, in a 2x2 grid of one shared port.
// Real-time dt with deps.now = performance.now, so the relay's rate limits see the same clock.
function runInPage(ctx: Ctx, clients: number): void {
  const now = () => performance.now()
  const hub = new InPageHubLoop(ctx.R, clients, new LoopbackRelay(), {
    R: ctx.R, courses: ctx.courses, plaza: ctx.plaza, partySize: clients as 2 | 3 | 4, now, pilot: true,
  }, [ctx.port], { assets: ctx.assets, bean: ctx.assets('bean') })
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

async function main(): Promise<void> {
  installPlayOps()
  const search = window.location.search
  if (new URLSearchParams(search).get('mode') === 'ops') return
  const canvas = document.querySelector<HTMLCanvasElement>('#view')
  const hudRoot = document.querySelector<HTMLElement>('#hud')
  if (canvas === null || hudRoot === null) throw new Error('play.html needs canvas#view and div#hud')
  const hud = mountHud(hudRoot)
  try {
    const q = parseQuery(search)
    const { port, note } = await pickPort(hud)
    const R = await initRapier()
    const courses = await browserCourses('sprint')
    const resolver = browserAssetResolver()
    const plaza = await loadCourse(JSON.parse(plazaJson), 'fixtures/courses/hub-plaza.course.json', resolver)
    const assets = await preloadAssets([...courses, plaza], resolver)
    const width = Math.max(1, Math.floor(window.innerWidth))
    const height = Math.max(1, Math.floor(window.innerHeight))
    canvas.width = width
    canvas.height = height
    await port.init({ canvas, width, height, viewports: viewportsOf(width, height, q.mode === 'inpage' ? q.clients : 1) })
    const ctx: Ctx = { note, R, hud, port, courses, plaza, assets }
    if (q.mode === 'inpage') runInPage(ctx, q.clients)
    else runOnline(ctx, q, trackControls())
  } catch (e) {
    hud.banner(messageOf(e))
    console.error(e)
  }
}

void main()
