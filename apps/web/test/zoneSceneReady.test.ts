import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import { observeRoundLoad } from '@royal-fiesta/game/render/roundLoad'
import type { ZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { PrimsAsset } from '@royal-fiesta/game/prims'

// Keep the production loading gate and trace. Replace only the GPU SceneView and FAR drawing.
const loading = new URL('../../../packages/game/src/render/roundLoad.ts', import.meta.url).href
const state = { mounted: 0, animated: 0, rendered: 0 }
Object.assign(globalThis, { __zoneReadyTest: state })
const hook = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/zone/zoneNetScene.ts')) {
    const code = specifier === '../client/sources.ts' ? 'export const browserAssetResolver = () => {}; export const preloadAssets = async () => {}' : specifier === '@royal-fiesta/game/render/sceneView' ? `
      import { roundReady, courseFrame } from ${JSON.stringify(loading)};
      export class SceneView {
        constructor(opts) { this.port = opts.port; this.loaded = false; this.loadedCourse = null }
        update(sim) {
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
