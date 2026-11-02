import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { GameInput } from '../src/input/input.ts'
import { OrbitCamera } from '@royal-fiesta/game/render/orbitCamera'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import { observeRoundLoad } from '@royal-fiesta/game/render/roundLoad'
import type { ZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { PrimsAsset } from '@royal-fiesta/game/prims'

// Keep the production loading gate and trace. Replace only the GPU SceneView and FAR drawing.
const loading = import.meta.resolve('@royal-fiesta/game/render/roundLoad')
const state = { mounted: 0, animated: 0, rendered: 0, camera: null as unknown }
Object.assign(globalThis, { __zoneReadyTest: state })
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/zone/zoneNetScene.ts')) {
    const code = specifier === '../client/sources.ts' ? 'export const browserAssetResolver = () => {}; export const preloadAssets = async () => {}' : specifier === '@royal-fiesta/game/render/sceneView' ? `
      import { roundReady, courseFrame } from ${JSON.stringify(loading)};
      export class SceneView {
        constructor(opts) { this.port = opts.port; this.camera = opts.camera; this.loaded = false; this.loadedCourse = null }
        update(sim) {
          globalThis.__zoneReadyTest.camera = this.camera({x: 0, y: 0, z: 0}, 1/60);
          if (this.loaded || !roundReady(this.port, sim.course().id)) return;
          courseFrame(sim, this.port, sim.course().id, () => { this.loaded = true; this.loadedCourse = sim.course(); globalThis.__zoneReadyTest.mounted++ });
        }
        async animationReady() { if (this.loaded) globalThis.__zoneReadyTest.animated++ }
        dispose() {}
      }` : specifier === '@royal-fiesta/game/render/farRender' ? `
      export class FarRenderer { update() {} dispose() {} }` : null
    if (code) return { url: `data:text/javascript,${encodeURIComponent(code)}`, shortCircuit: true }
  }
  return next(specifier, context)
} })
const { prepareZoneNetScene } = await import('../src/zone/zoneNetScene.ts')
hook.deregister()

test('each round waits for loading paint, mounts animation, and renders before worldReady', async t => {
  const paints: FrameRequestCallback[] = []
  const original = Object.getOwnPropertyDescriptor(globalThis, 'requestAnimationFrame')
  Object.defineProperty(globalThis, 'requestAnimationFrame', { configurable: true, value: (f: FrameRequestCallback) => { paints.push(f); return 1 } })
  const labels: (string | null)[] = []
  const stop = observeRoundLoad(label => labels.push(label), {})
  try {
    for (let round = 0; round < 3; round++) {
      const beforeRenders = state.rendered
      const port = new NullRenderPort()
      const render = port.render.bind(port)
      port.render = () => { state.rendered++; return render() }
      const prepared = await prepareZoneNetScene({
        canvas: { width: 640, height: 360 } as HTMLCanvasElement,
        course: { id: `round-${round}` } as ResolvedCourse,
        assets: () => ({ id: 'bean' } as PrimsAsset), createPort: async () => port,
      })
      const scene = prepared.attach(2, 0)
      const match = { domains: [], stats: { tick: 0 } } as unknown as ZoneMatch
      scene.update(match, 1, 0)
      let ready = false
      const pending = scene.ready().then(() => { ready = true })
      await Promise.resolve()
      assert.equal(ready, false, 'animationReady alone must not release an unmounted scene')
      assert.equal(state.mounted, round)
      paints.shift()!(0)
      if (round === 1) {
        // A normal page frame can mount/render while ready() is awaiting the paint.
        scene.update(match, 1, 0)
        scene.render()
      }
      await pending
      assert.equal(state.mounted, round + 1)
      assert.equal(state.animated, round + 1)
      assert.equal(state.rendered, beforeRenders + (round === 1 ? 2 : 1))
      assert.equal(labels.at(-1), null, 'the first render finishes the loading overlay')
      scene.dispose()
    }
  } finally {
    stop()
    if (original) Object.defineProperty(globalThis, 'requestAnimationFrame', original)
    else Reflect.deleteProperty(globalThis, 'requestAnimationFrame')
  }
})

// Real GameInput -> OrbitCamera -> the ZoneNetScene camera callback used by show rounds.
test('round camera renders mouse and right-stick look from the input owner', async () => {
  const win = new EventTarget() as EventTarget & { document: EventTarget & { pointerLockElement: unknown }; performance: Performance }
  const doc = new EventTarget() as typeof win.document
  const canvas = { width: 640, height: 360, requestPointerLock() { doc.pointerLockElement = canvas } }
  win.document = doc
  win.performance = performance
  const input = new GameInput(win as unknown as Window, new EventTarget() as HTMLElement, () => canvas as unknown as Element)
  const orbit = new OrbitCamera()
  const prepared = await prepareZoneNetScene({
    canvas: canvas as unknown as HTMLCanvasElement, orbit,
    course: { id: 'look-round' } as ResolvedCourse,
    assets: () => ({ id: 'bean' } as PrimsAsset), createPort: async () => new NullRenderPort(),
  })
  const scene = prepared.attach(2, 0)
  const match = { domains: [], stats: { tick: 0 } } as unknown as ZoneMatch
  const frame = () => {
    const look = input.takeLook()
    orbit.mouse(look.dx, look.dy, 5, false)
    orbit.stick(look.rx, look.ry, 1/60, 5, false)
    scene.update(match, 1, 1/60)
    assert.deepEqual(state.camera, orbit.pose({ x: 0, y: 0, z: 0 }), 'render must use the camera controlled by input')
  }
  const original = Object.getOwnPropertyDescriptor(navigator, 'getGamepads')
  try {
    const down = new Event('mousedown')
    Object.defineProperty(down, 'target', { value: canvas })
    win.dispatchEvent(down)
    assert.equal(input.look.locked, true)
    frame()
    const before = orbit.yaw
    const move = new Event('mousemove')
    Object.assign(move, { movementX: 120, movementY: -30 })
    win.dispatchEvent(move)
    frame()
    assert.notEqual(orbit.yaw, before)
    assert.ok(orbit.pitch < Math.atan2(2.8, 7))
    const mouseYaw = orbit.yaw
    Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => [{ axes: [0, 0, 0.8, -0.5] }] })
    frame()
    assert.notEqual(orbit.yaw, mouseYaw)
  } finally {
    if (original) Object.defineProperty(navigator, 'getGamepads', original)
    else Reflect.deleteProperty(navigator, 'getGamepads')
    input.dispose(); scene.dispose()
  }
})
