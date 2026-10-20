import { initRapier } from '@gamesaloon/rollback-rapier'
import { loadCourse } from '@royal-fiesta/game/course'
import type { FlowEvent } from '@royal-fiesta/game/hub/flow'
import { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import type { Viewport } from '@royal-fiesta/game/render/port'
import { refuse } from '@royal-fiesta/sim/refusal'
import plazaJson from '../../../../fixtures/courses/hub-plaza.course.json?raw'
import { browserAssetResolver, browserCourses, preloadAssets } from '../client/sources.ts'
import { installNmcOps } from '../nmc/ops.ts'
import type { AdapterInfo, CaptureOut } from '../nmc/ops.ts'
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
interface GpuLike { requestAdapter(): Promise<GpuAdapterLike | null> }

async function adapterInfo(): Promise<AdapterInfo> {
  const gpu = (navigator as Navigator & { gpu?: GpuLike }).gpu
  if (!gpu) refuse('gpu', 'navigator.gpu', 'WebGPU is not exposed by this browser; run the op in the GPU client browser')
  const adapter = await gpu.requestAdapter()
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

function makeCanvas(): HTMLCanvasElement {
  const canvas = document.createElement('canvas')
  canvas.width = WIDTH
  canvas.height = HEIGHT
  canvas.style.cssText = `width: ${WIDTH}px; height: ${HEIGHT}px; display: block;`
  document.body.appendChild(canvas)
  return canvas
}

function base64Of(bytes: Uint8Array): string {
  let s = ''
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  return btoa(s)
}

async function hubLoopCapture(raw: unknown): Promise<HubLoopOutput> {
  const captureAt = validate(raw)
  const { R, adapter } = await prelude()
  const courses = await browserCourses('sprint')
  const resolver = browserAssetResolver()
  const plaza = await loadCourse(JSON.parse(plazaJson), 'fixtures/courses/hub-plaza.course.json', resolver)
  const assets = await preloadAssets([...courses, plaza], resolver)
  const port = await createRaaPort()
  if (port.kind !== 'raa') refuse('render', 'raa', 'hubLoopCapture requires an RAA port; never capture with the null port')
  const canvas = makeCanvas()
  const viewports: Viewport[] = []
  for (let k = 0; k < 4; k++) viewports.push({ x: (k % 2) * 960, y: Math.floor(k / 2) * 540, width: 960, height: 540 })
  let loop: InPageHubLoop | null = null
  let frame = 0
  const now = () => frame * DT * 1000
  const originalNow = Object.getOwnPropertyDescriptor(performance, 'now')
  let clockInstalled = false
  try {
    await port.init({ canvas, width: WIDTH, height: HEIGHT, viewports })
    // LoopbackRelay rate-limits on performance.now, so it must share deps.now's virtual clock.
    Object.defineProperty(performance, 'now', { configurable: true, writable: true, value: now })
    clockInstalled = true
    loop = new InPageHubLoop(R, 4, new LoopbackRelay({ seed: 8 }), {
      R, courses, plaza, partySize: 4, now, pilot: true,
    }, [port], { assets, bean: assets('bean') })
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
        const png = await port.capture()
        if (png === null || png.length === 0) refuse('render', 'raa', `capture at ${name} returned no PNG bytes; the RAA port must read the canvas back`)
        captures.push({ name: `hub-loop-${name}`, width: WIDTH, height: HEIGHT, mime: 'image/png', base64: base64Of(png) })
        if (captures.length === captureAt.length) return { captures, adapter, renderer: 'raa', events: loop.events }
      }
      if (frame % 60 === 0) await new Promise<void>(resolve => setTimeout(resolve, 0))
    }
    return refuse('ops', 'hubLoopCapture', `did not reach ${captureAt[captures.length]} within ${MAX_FRAMES} frames; inspect the hub loop transitions`)
  } finally {
    try {
      loop?.dispose()
    } finally {
      try { port.dispose() } finally {
        canvas.remove()
        if (clockInstalled) {
          if (originalNow) Object.defineProperty(performance, 'now', originalNow)
          else Reflect.deleteProperty(performance, 'now')
        }
      }
    }
  }
}

export function installPlayOps(): void {
  installNmcOps()
  const gpu = window.nmcGpu as NonNullable<Window['nmcGpu']> & { ops: { hubLoopCapture(input: unknown): Promise<HubLoopOutput> } }
  gpu.ops.hubLoopCapture = hubLoopCapture
}
