import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { registerHooks } from 'node:module'
import test from 'node:test'
import { SnapWriter } from '@gamesaloon/rollback'
import { FarReader } from '@gamesaloon/rollback/zones'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import type { ZoneMatch } from '@royal-fiesta/game/net/zoneMatch'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { encodeFar } from '@royal-fiesta/sim/zones/farState'
import { CharMode } from '@royal-fiesta/sim/character/constants'

// Only Vite's asset lookup is replaced. Exercise the production round wiring, feed, adapter,
// SceneView, animation driver and validating render port without a GPU.
const hooks = registerHooks({ resolve(specifier, context, next) {
  if (context.parentURL?.endsWith('/zone/zoneNetScene.ts') && specifier === '../client/sources.ts') {
    return { url: 'data:text/javascript,export const browserAssetResolver = () => {}; export const preloadAssets = async () => {}', shortCircuit: true }
  }
  return next(specifier, context)
} })
const { prepareZoneNetScene } = await import('../src/zone/zoneNetScene.ts')
hooks.deregister()
const read = (path: string) => JSON.parse(readFileSync(new URL(`../../../${path}`, import.meta.url), 'utf8'))
const penguin = read('assets/common/penguin.body.asset.json').document.nodes.penguin
const skinned = {
  assetId: 'penguin.body', graph: readFileSync(new URL('../../../assets/common/penguin.animgraph.json', import.meta.url), 'utf8'),
  skin: { rig: penguin.rig, clips: penguin.clips, parts: [{ name: 'body', skin: { joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) } }] },
}
const asset = (id: string) => ({ id, anchors: {} }) as PrimsAsset
const entity = (seat: number, x = seat) => ({ seat, pos: { x, y: 2, z: 0 }, facing: { x: 0, z: 1 }, mode: CharMode.ground, status: 0 })

class RecordingPort extends NullRenderPort {
  poses = new Map<number, Float32Array>()
  names = new Map<number, string>()
  instances = new Map<number, { asset: string; visible: boolean; posed: boolean; x: number }>()
  override registerAsset(name: string, a: PrimsAsset) { const h = super.registerAsset(name, a); this.names.set(h, name); return h }
  override registerSkinned(...args: Parameters<NullRenderPort['registerSkinned']>) { const h = super.registerSkinned(...args); this.names.set(h, args[0]); return h }
  override createInstance(...args: Parameters<NullRenderPort['createInstance']>) { const h = super.createInstance(...args); this.instances.set(h, { asset: this.names.get(args[0])!, visible: true, posed: false, x: 0 }); return h }
  override setVisible(i: number, visible: boolean) { super.setVisible(i, visible); this.instances.get(i)!.visible = visible }
  override setPose(...args: Parameters<NullRenderPort['setPose']>) { super.setPose(...args); this.instances.get(args[0])!.posed = true; this.poses.set(args[0], Float32Array.from(args[1])) }
  override setTransform(...args: Parameters<NullRenderPort['setTransform']>) { super.setTransform(...args); this.instances.get(args[0])!.x = args[1][0] }
}

test('three show round scenes draw every near/remote seat with the animated penguin', async t => {
  for (let round = 0; round < 3; round++) {
    await t.test(`round ${round + 1}`, async t => {
      const port = new RecordingPort()
      const course = { id: `round-${round}`, obstacles: [] } as unknown as ResolvedCourse
      const prepared = await prepareZoneNetScene({
        canvas: { width: 640, height: 360 } as HTMLCanvasElement, course,
        assets: asset, bean: asset('zone.far-bean'), character: asset('old-character'), skinned,
        wardrobe: seat => ({ head: { asset: asset(`hat-${seat}`) } }),
        createPort: async target => { await port.init({ ...target, canvas: null }); return port },
      })
      const scene = prepared.attach(4, round % 2)
      let local = round % 2
      let tick = 0
      const domain = {
        get seats() { return [local] }, tick: 0,
        state: (seat: number) => ({ ...entity(seat), vel: { x: 0, y: 0, z: 0 }, teleportTick: -1 }),
        status: () => 0, mechanisms: { spec: () => null },
      }
      const update = (seats: number[]) => {
        const writer = new SnapWriter()
        encodeFar(writer, seats.map(seat => entity(seat)))
        const reader = new FarReader().bind(writer.bytes())
        scene.feed.far(1, tick, 6, reader.u16(), reader)
        scene.update({ domains: [domain], stats: { tick } } as unknown as ZoneMatch, 1, 1 / 60)
      }
      try {
        update([0, 1, 2, 3])
        await scene.ready()
        tick++
        update([0, 1, 2, 3])
        const shown = () => [...port.instances.values()].filter(i => i.visible && !i.asset.startsWith('hat-'))
        const hats = () => [...port.instances.values()].filter(i => i.visible && i.asset.startsWith('hat-'))
        t.diagnostic(`round ${round + 1}, local seat ${local}: ${shown().map(i => `seat ${i.x}=${i.asset}`).join(', ')}`)
        assert.equal(shown().length, 4)
        assert.deepEqual(hats().map(i => i.asset).sort(), ['hat-0', 'hat-1', 'hat-2', 'hat-3'])
        assert.ok(shown().every(i => i.asset === 'penguin.body' && i.posed), 'all visible players must use a posed skin')
        const before = port.poses.get(2)!
        for (let step = 0; step < 24; step++) { tick++; update([0, 1, 2, 3]) }
        assert.notDeepEqual(port.poses.get(2), before, 'the remote character graph must animate across ticks')
        // Ownership changes must neither duplicate nor replace a character with the rigid LOD.
        local = 1 - local
        tick += 6
        update([0, 1, 2, 3])
        assert.equal(shown().length, 4)
        assert.deepEqual(hats().map(i => i.asset).sort(), ['hat-0', 'hat-1', 'hat-2', 'hat-3'])
        assert.ok(shown().every(i => i.asset === 'penguin.body' && i.posed))
        // Expired remote packets hide the characters rather than leaving stale instances on screen.
        tick += 30
        update([])
        assert.equal(shown().length, 1)
        assert.deepEqual(hats().map(i => i.asset), [`hat-${local}`])
      } finally { scene.dispose() }
    })
  }
})
