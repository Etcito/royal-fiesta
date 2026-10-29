import { initRapier } from '@gamesaloon/rollback-rapier'
import { loadCourse } from '@royal-fiesta/game/course'
import type { FlowEvent } from '@royal-fiesta/game/hub/flow'
import { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import type { RenderPort, RenderStats, Viewport } from '@royal-fiesta/game/render/port'
import { refuse } from '@royal-fiesta/sim/refusal'
import plazaJson from '../../../../fixtures/courses/hub-plaza.course.json?raw'
import { initPerClient, planCanvases } from '../client/canvases.ts'
import { browserAssetResolver, browserCourses, preloadAssets } from '../client/sources.ts'
import { installNmcOps } from '../nmc/ops.ts'
import type { AdapterInfo, CaptureOut, OpEnvelope } from '../nmc/ops.ts'
import { createRaaPort } from '../render/raaPort.ts'
import { raaStatus } from '../render/raaStatus.ts'
import { InPageHubLoop } from './inpageHub.ts'

const WIDTH = 1920
const HEIGHT = 1080
const DT = 1 / 60
const MAX_FRAMES = 30000
const MOMENTS = ['hub', 'match', 'podium', 'back-in-hub'] as const
type Moment = typeof MOMENTS[number]
interface HubLoopOutput { captures: CaptureOut[]; adapter: AdapterInfo; renderer: 'raa'; events: FlowEvent[] }

function field(op: string, input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null || Array.isArray(input)) refuse('ops', `${op}.input`, 'is not an object; pass the JSON input declared in nmc.gpu.json')
  if (!Object.hasOwn(input, key)) refuse('ops', `${op}.input.${key}`, 'is missing; pass the input declared in nmc.gpu.json')
  return (input as Record<string, unknown>)[key]
}

function exact(op: string, input: unknown, key: string, want: number): void {
  const v = field(op, input, key)
  if (v !== want) refuse('ops', `${op}.input.${key}`, `is ${JSON.stringify(v)}; this op only supports ${want}`)
}

function validate(input: unknown): Moment[] {
  const op = 'hubLoopCapture'
  exact(op, input, 'clients', 4)
  exact(op, input, 'width', WIDTH)
  exact(op, input, 'height', HEIGHT)
  const at = field(op, input, 'captureAt')
  const keys = ['clients', 'width', 'height', 'captureAt']
  if (Object.keys(input as object).some(k => !keys.includes(k))) {
    refuse('ops', `${op}.input`, 'has unknown fields; pass only clients, width, height and captureAt')
  }
  if (!Array.isArray(at) || at.length === 0) refuse('ops', `${op}.input.captureAt`, 'is not a non-empty array; choose hub, match, podium, back-in-hub in that order')
  let previous = -1
  for (let i = 0; i < at.length; i++) {
    const index = MOMENTS.findIndex(name => name === at[i])
    if (index < 0 || index <= previous) {
      refuse('ops', `${op}.input.captureAt/${i}`, `${JSON.stringify(at[i])} is unknown, repeated or out of order; choose a strictly ordered subset of hub, match, podium, back-in-hub`)
    }
    previous = index
  }
  return at as Moment[]
}

// The M7 helper is private, so keep the same adapter detection here.
interface GpuAdapterInfoLike { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean }
interface GpuAdapterLike { info?: GpuAdapterInfoLike; isFallbackAdapter?: boolean }
interface GpuLike { requestAdapter(opts?: { powerPreference?: string; featureLevel?: string }): Promise<GpuAdapterLike | null> }

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

async function prelude() {
  const status = await raaStatus()
  if (!status.available) refuse('render', 'raa', status.reason)
  return { R: await initRapier(), adapter: await adapterInfo() }
}

// The hub loop draws only at capture moments: the op renders each real port just before reading it back.
const ZERO_STATS: RenderStats = { frameMs: 0, drawCalls: 0, triangles: 0, instances: 0, visible: 0 }
function gated(port: RenderPort): RenderPort {
  return {
    kind: port.kind,
    init: target => port.init(target),
    registerAsset: (name, asset) => port.registerAsset(name, asset),
    createInstance: (asset, tint) => port.createInstance(asset, tint),
    setTransform: (instance, t, r, s) => port.setTransform(instance, t, r, s),
    setVisible: (instance, visible) => port.setVisible(instance, visible),
    destroyInstance: instance => port.destroyInstance(instance),
    setCamera: (viewport, cam) => port.setCamera(viewport, cam),
    setEnvironment: env => port.setEnvironment(env),
    render: () => ZERO_STATS,
    capture: () => port.capture(),
    dispose: () => port.dispose(),
  }
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

// One PNG per client canvas, tiled into the 1920x1080 grid: client k at column k%2, row floor(k/2).
async function composite(pngs: Uint8Array[], tiles: Viewport[]): Promise<string> {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  const ctx = canvas.getContext('2d')
  if (ctx === null) refuse('ops', 'hubLoopCapture', 'no 2D canvas context to tile the client captures; run the op in a browser with canvas 2D')
  for (let k = 0; k < tiles.length; k++) {
    const image = await createImageBitmap(new Blob([pngs[k] as Uint8Array<ArrayBuffer>], { type: 'image/png' }))
    ctx.drawImage(image, tiles[k].x, tiles[k].y, tiles[k].width, tiles[k].height)
    image.close()
  }
  const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/png'))
  if (blob === null) refuse('ops', 'hubLoopCapture', 'canvas.toBlob returned null; the tiled capture could not be encoded')
  return base64Of(new Uint8Array(await blob.arrayBuffer()))
}

async function hubLoopCapture(raw: unknown): Promise<OpEnvelope<HubLoopOutput>> {
  const captureAt = validate(raw)
  const { R, adapter } = await prelude()
  const courses = await browserCourses('sprint')
  const resolver = browserAssetResolver()
  const plaza = await loadCourse(JSON.parse(plazaJson), 'fixtures/courses/hub-plaza.course.json', resolver)
  const assets = await preloadAssets([...courses, plaza], resolver)
  // One canvas and one RAA port per client (RAA draws one full-canvas viewport), as on the client page.
  const plan = planCanvases(WIDTH, HEIGHT, 4)
  const tiles: Viewport[] = plan.cells.map(c => ({ x: c.col * c.canvasWidth, y: c.row * c.canvasHeight, width: c.canvasWidth, height: c.canvasHeight }))
  const canvases: HTMLCanvasElement[] = []
  const ports: RenderPort[] = []
  let loop: InPageHubLoop | null = null
  let frame = 0
  const now = () => frame * DT * 1000
  const originalNow = Object.getOwnPropertyDescriptor(performance, 'now')
  let clockInstalled = false
  try {
    await initPerClient(plan, cell => {
      const canvas = makeCanvas(cell.canvasWidth, cell.canvasHeight)
      canvases.push(canvas)
      return canvas
    }, async () => {
      const port = await createRaaPort()
      ports.push(port)
      if (port.kind !== 'raa') refuse('render', 'raa', 'hubLoopCapture requires an RAA port; never capture with the null port')
      return port
    })
    // LoopbackRelay rate-limits on performance.now, so it must share deps.now's virtual clock.
    Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: now })
    clockInstalled = true
    loop = new InPageHubLoop(R, 4, new LoopbackRelay({ seed: 8 }), {
      R, courses, plaza, partySize: 4, now, pilot: true,
    }, ports.map(gated), { assets, bean: assets('bean') })
    const captures: CaptureOut[] = []
    let hubFrames = 0
    let matchStart: number | null = null
    let podiumStart: number | null = null
    let doneStart: number | null = null
    const reached = new Set<Moment>()
    for (frame = 1; frame <= MAX_FRAMES; frame++) {
      loop.frame(DT)
      const flows = loop.flows
      const failed = flows.find(f => f.state === 'failed')
      if (failed) {
        const event = [...loop.events].reverse().find(e => e.state === 'failed')
        refuse('ops', 'hubLoopCapture', `${event?.detail.message ?? 'hub loop failed'}; inspect the hub flow`)
      }
      const all = flows.length === 4
      hubFrames = all && matchStart === null && flows.every(f => f.state === 'hub' && f.remotes(now()).length === 3) ? hubFrames + 1 : 0
      if (hubFrames >= 120) reached.add('hub')
      if (matchStart === null && all && flows.every(f => f.state === 'match')) matchStart = frame
      if (matchStart !== null && frame - matchStart === 600) reached.add('match')
      if (podiumStart === null && all && flows.every(f => f.state === 'podium')) podiumStart = frame
      if (podiumStart !== null && frame - podiumStart === 60) reached.add('podium')
      if (doneStart === null && loop.done) doneStart = frame
      if (doneStart !== null && frame - doneStart === 120) reached.add('back-in-hub')
      const name = captureAt[captures.length]
      if (reached.has(name)) {
        const pngs: Uint8Array[] = []
        for (let k = 0; k < ports.length; k++) {
          ports[k].render()
          const png = await ports[k].capture()
          if (png === null || png.length === 0) refuse('render', 'raa', `client ${k} capture at ${name} returned no PNG bytes; the RAA port must read the canvas back`)
          pngs.push(png)
        }
        captures.push({ name: `hub-loop-${name}`, width: WIDTH, height: HEIGHT, mime: 'image/png', base64: await composite(pngs, tiles) })
        if (captures.length === captureAt.length) return { json: { captures, adapter, renderer: 'raa', events: loop.events }, files: [] }
      }
      if (frame % 60 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    return refuse('ops', 'hubLoopCapture', `did not reach ${captureAt[captures.length]} within ${MAX_FRAMES} frames; inspect the hub loop transitions`)
  } finally {
    try {
      loop?.dispose()
    } finally {
      try {
        for (const port of ports) port.dispose()
      } finally {
        for (const canvas of canvases) canvas.remove()
        if (clockInstalled) {
          if (originalNow) Object.defineProperty(performance, 'now', originalNow)
          else Reflect.deleteProperty(performance, 'now')
        }
      }
    }
  }
}

// The GPU client exposes the RTX only at WebGPU's compatibility feature level, and RAA's browser backend never
// asks for it, so inject it into every requestAdapter call (the page's own and RAA's) or both get SwiftShader.
function preferCompatibilityAdapter(): void {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu
  if (!gpu || typeof gpu.requestAdapter !== 'function') return
  const orig = gpu.requestAdapter.bind(gpu)
  gpu.requestAdapter = async (opts?: { powerPreference?: string; featureLevel?: string }) => {
    // Core first: the compatibility level yields a device RAA's lit pipeline cannot use. Fall back to it only when the
    // core adapter is missing or a software one (an older GPU client exposed the RTX only at that level).
    const core = await orig({ ...(opts ?? {}) })
    const info = (core as { info?: { isFallbackAdapter?: boolean; device?: string; description?: string; vendor?: string } } | null)?.info
    const software = info?.isFallbackAdapter === true || /swiftshader|llvmpipe|lavapipe/i.test(`${info?.vendor ?? ''} ${info?.device ?? ''} ${info?.description ?? ''}`)
    if (core !== null && !software) return core
    if (opts?.featureLevel !== undefined) return core
    return (await orig({ ...(opts ?? {}), featureLevel: 'compatibility' })) ?? core
  }
}

export function installPlayOps(): void {
  preferCompatibilityAdapter()
  installNmcOps()
  const gpu = window.nmcGpu as NonNullable<Window['nmcGpu']> & { ops: { hubLoopCapture(input: unknown): Promise<OpEnvelope<HubLoopOutput>> } }
  gpu.ops.hubLoopCapture = hubLoopCapture
}
