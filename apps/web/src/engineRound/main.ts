/// <reference types="vite/client" />
import { loadEngine } from '@etcito/game-engine'
import type { EngineInstance } from '@etcito/game-engine/loader'
import { RenderBridge } from '@etcito/game-engine/render'
import wasmUrl from '@etcito/game-engine/wasm/ege.wasm?url'
import { RF_EGE_SCRIPTS_URL } from '@royal-fiesta/game/ege/files'
import type { EmittedScene } from '@royal-fiesta/game/ege/sceneEmitter'
import { emitEngineScene } from '@royal-fiesta/game/ege/sceneEmitter'
import type { EngineRound } from '@royal-fiesta/game/ege/round'
import { createEngineRound } from '@royal-fiesta/game/ege/round'
import { EngineSceneSim, focusCamera } from '@royal-fiesta/game/ege/sceneSim'
import type { CourseV1 } from '@royal-fiesta/game/courseV1'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { RenderTarget } from '@royal-fiesta/game/render/port'
import { encodeInput } from '@royal-fiesta/sim/input'
import type { MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { refuse } from '@royal-fiesta/sim/refusal'
import schemaText from '../../../../ege.schema.json?raw'
import { browserGameAssets, loadV1Courses } from '../content/v1Data.ts'
import type { ResizablePort } from '../sdf/sdfPort.ts'
import { zoneContent } from '../zone/zoneContent.ts'
import { drawRoundHud, hudLines } from './hud.ts'
import { createReadyGate } from './ready.ts'
import { createRoundRun, parseRunArgs } from './run.ts'
import type { RoundFacts, RoundRunArgs } from './run.ts'

const WIDTH = 1920
const HEIGHT = 1080
const AREA = 'engine-round'

export interface EngineRoundPage {
  engine: EngineInstance
  round: EngineRound
  scene: EmittedScene
  course: CourseV1
  sim: EngineSceneSim
  view: SceneView
  port: ResizablePort
  bridge: RenderBridge
  drawFrame(dtS: number): void
  composite(facts: RoundFacts): Promise<Uint8Array>
  dispose(): void
}

async function fetchScripts(): Promise<ArrayBuffer> {
  const response = await fetch(RF_EGE_SCRIPTS_URL)
  if (!response.ok) refuse(AREA, RF_EGE_SCRIPTS_URL, `answered ${response.status}; build the page with the scripts plugin`)
  return response.arrayBuffer()
}

/**
 * Handoff: Engine round page op, inventory row and ops registration calls `loadEngineRoundPage` (same file, no export
 * needed) with its parsed RoundRunArgs and the #view and #shot canvases. Today it loads the v1 course, its game assets,
 * the zone content, the engine, the schema and the scripts, emits the scene, creates the round (seat 0 human, seven
 * bots), builds the SDF port, EngineSceneSim, SceneView and RenderBridge, and returns the EngineRoundPage handle:
 * one round per handle, disposed in the order bridge, view, port, round. It takes the port's raa engine from
 * `ResizablePort.raaEngine` (apps/web/src/sdf/sdfPort.ts:44, doc comment at :39-43) and calls the HUD helpers of
 * apps/web/src/engineRound/hud.ts:11 `hudLines` and `drawRoundHud`. It registers no op and reads no inventory.
 */
export async function loadEngineRoundPage(args: RoundRunArgs, canvas: HTMLCanvasElement, shot: HTMLCanvasElement): Promise<EngineRoundPage> {
  const [{ byId }, content, engine, scripts] = await Promise.all([
    loadV1Courses(() => {}, undefined, args.course),
    zoneContent(args.profile, args.course),
    loadEngine({ wasmUrl }),
    fetchScripts(),
  ])
  const course = byId.get(args.course)
  if (course === undefined) refuse(AREA, `args.course`, `course '${args.course}' is not in the content pack; pass a shipped course id`)
  const resolver = browserGameAssets()
  const assets = new Map(await Promise.all(course.assetIds.map(async id => [id, await resolver.resolve(id)] as const)))
  engine.setSchema(schemaText)
  const setup = { profile: args.profile, seed: args.seed }
  const scene = emitEngineScene(engine, { course, assets, setup })
  const round = await createEngineRound(engine, schemaText, scripts, scene, course, { ...setup, humans: [true, false, false, false, false, false, false, false] })
  let focus: string | null = null
  if (args.focus !== null) {
    const kind = args.focus.slice('kind:'.length)
    focus = course.sim?.features?.find(feature => feature.kind === kind)?.id ?? null
    if (focus === null) {
      round.dispose()
      refuse(AREA, 'args.focus', `'${args.focus}' names no feature of course '${course.id}'; use a feature kind the course holds`)
    }
  }
  const target: RenderTarget = { canvas, width: WIDTH, height: HEIGHT, viewports: [{ x: 0, y: 0, width: WIDTH, height: HEIGHT }] }
  let port: ResizablePort
  try {
    port = await content.createPort(target)
  } catch (error) {
    round.dispose()
    throw error
  }
  const sim = new EngineSceneSim(course, scene)
  sim.refresh(round)
  const rootEntity = focus === null ? -1 : scene.index(`feature/${focus}`)
  const view = new SceneView({
    port, viewport: 0, localPlayer: 0, assets: content.assets, bean: content.bean,
    character: content.character, skinned: content.skinned, dressing: content.dressing,
    camera: focus === null ? undefined : () => {
      const pose = round.poses([rootEntity])
      return focusCamera({ x: pose[0], y: pose[1], z: pose[2] })
    },
  })
  const bridge = new RenderBridge(port.raaEngine())
  let disposed = false
  return {
    engine, round, scene, course, sim, view, port, bridge,
    drawFrame(dtS) {
      sim.refresh(round)
      view.update(sim as unknown as MatchSim, null, 1, dtS)
      bridge.sync(engine.view(round.world, 1))
      port.render()
    },
    async composite(facts) {
      const png = await port.capture()
      if (png === null) refuse(AREA, 'port.capture', 'returned no image; draw a frame before compositing')
      const bitmap = await createImageBitmap(new Blob([png as BlobPart]))
      const ctx = shot.getContext('2d')
      if (ctx === null) refuse(AREA, '#shot', 'has no 2d context; use a canvas that holds none yet')
      ctx.drawImage(bitmap, 0, 0)
      bitmap.close()
      drawRoundHud(ctx, hudLines(facts, course.name), WIDTH, HEIGHT)
      const blob = await new Promise<Blob | null>(resolve => shot.toBlob(resolve, 'image/png'))
      if (blob === null) refuse(AREA, '#shot', 'toBlob gave no PNG')
      return new Uint8Array(await blob.arrayBuffer())
    },
    dispose() {
      if (disposed) return
      disposed = true
      bridge.dispose()
      view.dispose()
      port.dispose()
      round.dispose()
    },
  }
}

const KEYS: Record<string, string> = {
  ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right',
  Space: 'jump', ShiftLeft: 'dive', ShiftRight: 'dive', KeyE: 'grab',
}

// Keyboard to an S1 code: world-space, +Z forward, +X right.
function keyboardCode(held: ReadonlySet<string>): number {
  return encodeInput({
    moveX: (held.has('right') ? 1 : 0) - (held.has('left') ? 1 : 0),
    moveZ: (held.has('up') ? 1 : 0) - (held.has('down') ? 1 : 0),
    jump: held.has('jump'), dive: held.has('dive'), grab: held.has('grab'),
  })
}

function startLive(page: EngineRoundPage, args: RoundRunArgs, stage: HTMLElement): void {
  const held = new Set<string>()
  window.addEventListener('keydown', event => {
    const key = KEYS[event.code]
    if (key === undefined) return
    held.add(key)
    event.preventDefault()
  })
  window.addEventListener('keyup', event => {
    const key = KEYS[event.code]
    if (key !== undefined) held.delete(key)
  })
  const overlay = document.createElement('canvas')
  overlay.id = 'hud'
  overlay.width = WIDTH
  overlay.height = HEIGHT
  stage.appendChild(overlay)
  const ctx = overlay.getContext('2d')!
  const run = createRoundRun(page.round, args, page.course)
  const stepS = 1 / 60
  let accumulator = 0
  let last = performance.now()
  const frame = (now: number) => {
    const dtS = Math.min((now - last) / 1000, 0.25)
    last = now
    accumulator += dtS
    while (accumulator >= stepS) {
      page.round.step(() => keyboardCode(held))
      accumulator -= stepS
    }
    page.drawFrame(dtS)
    ctx.clearRect(0, 0, WIDTH, HEIGHT)
    drawRoundHud(ctx, hudLines(run.facts(), page.course.name), WIDTH, HEIGHT)
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

function queryArgs(params: URLSearchParams): { live: boolean; args: RoundRunArgs } {
  const live = params.get('live') === '1'
  params.delete('live')
  const input: Record<string, unknown> = Object.fromEntries(params)
  for (const key of ['seed', 'frames']) if (typeof input[key] === 'string') input[key] = Number(input[key])
  return { live, args: parseRunArgs(input) }
}

// The page boots from its query only when it holds a course; the op of the GPU client calls loadEngineRoundPage itself.
function boot(): void {
  const params = new URLSearchParams(location.search)
  if (!params.has('course')) return
  const status = document.querySelector<HTMLElement>('#status')!
  const stage = document.querySelector<HTMLElement>('#stage')!
  let page: EngineRoundPage | null = null
  const { ready } = createReadyGate(async () => {
    const { live, args } = queryArgs(params)
    page = await loadEngineRoundPage(args, document.querySelector<HTMLCanvasElement>('#view')!, document.querySelector<HTMLCanvasElement>('#shot')!)
    if (live) return startLive(page, args, stage)
    const run = createRoundRun(page.round, args, page.course)
    while (run.step());
    page.drawFrame(1 / 60)
  }, (state, message) => {
    status.textContent = message === undefined ? state : `${state}: ${message}`
  })
  ready.catch(() => {})
}

boot()
