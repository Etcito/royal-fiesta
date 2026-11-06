import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { CosmeticJiggle, setJiggleQuality, wornPalette } from '@royal-fiesta/game/anim/jiggle'
import { loadAnimBrick } from '@royal-fiesta/game/anim/brick'
import { fixtureResolver } from '@royal-fiesta/game/assets'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import { LOCAL_COSMETICS, startScreen } from '@royal-fiesta/game/flow/startScreen'
import { FarFeed } from '@royal-fiesta/game/net/farFeed'
import { classicNetSetup } from '@royal-fiesta/game/net/tuning'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { DomainSceneSim } from '@royal-fiesta/game/render/domainSceneSim'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import type { QuatT, SkinnedAssetT, Vec3T } from '@royal-fiesta/game/render/port'
import { restPoseSkin, SceneView } from '@royal-fiesta/game/render/sceneView'
import { WornMounts } from '@royal-fiesta/game/render/wornLook'
import { resolveGameRigs } from '@royal-fiesta/game/rigReference'
import { neutralInput } from '@royal-fiesta/sim/input'
import { createMatchSim, type MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { assetSkin } from '../src/content/cosmeticSkin.ts'
import { mountStartScreen } from '../src/screens/startScreen.ts'
import type { UaaHost } from '../src/ui/uaaHost.ts'

const root = new URL('../../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, root), 'utf8')
const body = JSON.parse(read('assets/common/penguin.body.asset.json')).document.nodes.penguin
const file = JSON.parse(read('assets/common/costume.jester-hat.asset.json'))
const resolved = await resolveGameRigs(file.document, async () => ({ nodes: { penguin: body } }))
const part = { name: 'p', skin: { joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) } }
const payload = { groups: [{ group: 'hat', parts: [{ partId: 'p', ...part }] }] }
const hat = assetSkin(payload, resolved, body.rig)!
const skinned = { assetId: 'penguin', skin: { rig: body.rig, clips: body.clips, parts: [part] }, graph: read('assets/common/penguin.animgraph.json') }
const unit: Vec3T = [1, 1, 1], identity: QuatT = [0, 0, 0, 1]
const asset = (id: string): PrimsAsset => ({ format: 'raa.prims', version: 0, id, name: id, nodes: [], materials: {}, anchors: {}, budget: { triangles: 1500, segments: 16 }, collision: { mode: 'override', colliders: [] } })
const hatAsset = asset('costume.jester-hat')

class Recorder extends NullRenderPort {
  readonly skins = new Map<string, SkinnedAssetT>([[hatAsset.id, hat]])
  readonly names = new Map<number, string>()
  readonly instances = new Map<number, string>()
  readonly transforms = new Map<number, { t: Vec3T; r: QuatT; s: Vec3T }>()
  skinOf(id: string) { return this.skins.get(id) }
  override registerAsset(id: string, a: PrimsAsset) {
    const h = super.registerAsset(id, a); this.names.set(h, id); return h
  }
  override createInstance(h: number, tint: Vec3T | null) {
    const i = super.createInstance(h, tint); this.instances.set(i, this.names.get(h)!); return i
  }
  override destroyInstance(i: number) { super.destroyInstance(i); this.instances.delete(i) }
  override setTransform(i: number, t: Vec3T, r: QuatT, s: Vec3T) {
    super.setTransform(i, t, r, s); this.transforms.set(i, { t: [...t], r: [...r], s: [...s] })
  }
}
async function port() {
  const p = new Recorder()
  await p.init({ canvas: null, width: 800, height: 600, viewports: [{ x: 0, y: 0, width: 800, height: 600 }] })
  return p
}
async function loaded(j: CosmeticJiggle) {
  await (j as unknown as { loading: Promise<void> | null }).loading
}
function near(a: ArrayLike<number>, b: ArrayLike<number>, label: string) {
  assert.equal(a.length, b.length, label)
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 3e-5, `${label}[${i}]: ${a[i]} != ${b[i]}`)
}
function follows(palette: Float32Array, penguin: Float32Array, skin = hat) {
  assert.deepEqual(palette.subarray(0, penguin.length), penguin, 'inherited palette is identical to the body')
  const bone = skin.rig.bones.findIndex(b => b.name === 'hat')
  const source = skin.sourceBones![bone]
  near(palette.subarray(bone * 16, bone * 16 + 16), penguin.subarray(source * 16, source * 16 + 16), 'rest attachment')
}

test('live referenced poses drive every attachment; skipped batches restart springs instead of replaying old motion', async () => {
  // Two independently animated attachments catch the old single-mount reconstruction and its output filter.
  const doc = structuredClone(resolved)
  const owner = Object.values(doc.nodes as Record<string, typeof body>).find(n => n.rigRef)!
  const extra = [
    { name: 'wing.spring', parent: 'upper.l', rest: { t: [0.1, 0, 0], r: [0, 0, 0, 1], s: [1, 1, 1] }, jiggle: { maxAngle: 25, stiffness: 0.4, damping: 0.3 } },
    { name: 'wing.tip', parent: 'wing.spring', rest: { t: [0.4, 0.2, 0], r: [0, 0, 0, 1], s: [1, 1, 1] } },
  ]
  owner.rig.bones.push(...extra); owner.rigRef.extraBones.push(...extra)
  const skin = assetSkin(payload, doc, body.rig)!
  const p = await port(); p.skins.set(hatAsset.id, skin)
  const mounts = new WornMounts(p), jiggle = new CosmeticJiggle()
  mounts.sync({ colour: 0, items: [{ asset: hatAsset, mount: [50, 50, 50], tint: null }] })
  const id = [...p.instances.keys()][0]
  const api = await loadAnimBrick()
  const { bindings: _b, smooth: _s, ...rigJson } = owner.rig
  const rig = api.loadRig(JSON.stringify(rigJson))
  const clip = api.loadClip(rig, JSON.stringify({ ...owner.clips[0], name: 'rest', tracks: [], events: [] }))
  const bind = api.sampleClip(clip, 0).model
  const wing = skin.rig.bones.findIndex(b => b.name === 'wing.spring')
  let wingSwung = false
  try {
    for (let f = 0; f < 100; f++) {
      const pose = restPoseSkin(body.rig, f * 2)
      const t: Vec3T = [Math.sin(f * 0.08), f * 0.01, 0]
      const dtS = [1 / 60, 1 / 144, 1 / 360, 0, 1 / 75][f % 5]
      mounts.draw(t, identity, unit)
      mounts.setPose(pose, { dtS, batch: jiggle })
      jiggle.flush(dtS, (i, m) => p.setPose(i, m))
      await loaded(jiggle)
      const palette = p.poseOf(id)!
      follows(palette, pose, skin)
      // A spring rotates about its CURRENT animated head, even while the body animation changes.
      const source = skin.sourceBones![wing], at = wing * 16, src = source * 16
      for (let r = 0; r < 3; r++) {
        const point = (m: Float32Array, o: number) => m[o + r] * bind[at + 12] + m[o + 4 + r] * bind[at + 13] + m[o + 8 + r] * bind[at + 14] + m[o + 12 + r]
        assert.ok(Math.abs(point(palette, at) - point(pose, src)) < 3e-5, 'spring pivot follows the rendered body')
      }
      wingSwung ||= Math.abs(palette[at] - pose[src]) > 1e-3
    }
    assert.ok(wingSwung, 'the second attachment also jiggles')
    const pose = restPoseSkin(body.rig, 200), rigid = wornPalette(skin, pose)
    for (const skip of ['late', 'off', 'culled', 'absent']) {
      for (const x of [0, 0.4, 0.8]) {
        jiggle.add(id, skin, pose, [x, 0, 0], identity, unit, true, 0)
        jiggle.flush(1 / 60, (i, m) => p.setPose(i, m))
      }
      assert.ok(p.poseOf(id)!.some((v, i) => Math.abs(v - rigid[i]) > 1e-3), 'springs are moving before the skipped frame')
      if (skip === 'off') setJiggleQuality('off')
      if (skip !== 'absent') jiggle.add(id, skin, pose, [0.8, 0, 0], identity, unit, false, skip === 'culled' ? 10000 : 0)
      jiggle.flush(skip === 'late' ? 0.05 : 1 / 144, (i, m) => p.setPose(i, m))
      setJiggleQuality('all')
      jiggle.add(id, skin, pose, [0.8, 0, 0], identity, unit, true, 0)
      jiggle.flush(1 / 144, (i, m) => p.setPose(i, m))
      near(p.poseOf(id)!, rigid, `resume after ${skip}`)
    }
  } finally { setJiggleQuality('all'); mounts.destroy(); jiggle.dispose(); clip.free(); rig.free(); p.dispose() }
})

test('local/show SceneView and online DomainSceneSim keep wardrobe and costume palettes on the rendered body between ticks', async () => {
  const resolver = fixtureResolver(async path => read(path))
  const courses = await matchCourses(readdirSync(new URL('fixtures/courses/', root)).filter(n => n.endsWith('.course.json')).sort().map(n => ({ path: n, json: JSON.parse(read(`fixtures/courses/${n}`)) })), resolver, 'sprint')
  const assets = new Map<string, PrimsAsset>()
  for (const c of courses) for (const o of c.obstacles) if (!assets.has(o.asset)) assets.set(o.asset, (await resolver.resolve(o.asset)).asset)
  const sim = createMatchSim(await initRapier(), classicNetSetup(5, 1, 'sprint', courses))
  const online = new DomainSceneSim(courses[0], 1), feed = new FarFeed()
  feed.read = tick => [{ seat: 0, x: tick * 0.02, y: 1, z: tick * 0.04, yaw: tick * 0.01, mode: 0, status: 0 }]
  try {
    for (const source of [sim, sim, online]) {
      const p = await port()
      const view = new SceneView({ port: p, viewport: 0, localPlayer: 0, bean: asset('bean'), assets: id => assets.get(id)!, skinned, loadingPaint: false,
        crowdAspect: source === sim && sim.tick > 0 ? () => 4 / 3 : undefined,
        look: () => ({ colour: 0, items: [{ asset: hatAsset, mount: [50, 50, 50], tint: null }] }), costumes: { hat: { asset: hatAsset, skin: hat } } })
      const j = (view as unknown as { jiggle: CosmeticJiggle }).jiggle
      const update = (alpha: number) => view.update(source as MatchSim, null, alpha, 1 / 144)
      try {
        if (source === online) online.refresh([], 0, feed)
        update(1); await view.animationReady(); await loaded(j)
        for (let tick = 1; tick <= 90; tick++) {
          if (source === online) online.refresh([], tick, feed)
          else sim.step(Array.from({ length: sim.setup.playerCount }, () => ({ ...neutralInput(), moveZ: 1 })))
          for (const alpha of [0.15, 0.6, 0.95]) {
            update(alpha); await loaded(j)
            const bodyId = (view as unknown as { beans: number[] }).beans[0]
            const pose = p.poseOf(bodyId)!, transform = p.transforms.get(bodyId)!
            const hats = [...p.instances].filter(([i, name]) => name === hatAsset.id && p.transforms.get(i)?.t.every((n, k) => n === transform.t[k]))
            assert.equal(hats.length, 2, 'wardrobe and costume both draw at the local penguin')
            for (const [i] of hats) { follows(p.poseOf(i)!, pose); assert.deepEqual(p.transforms.get(i), transform) }
          }
        }
      } finally { view.dispose(); p.dispose() }
    }
  } finally { sim.free() }
})

test('start screen worn jiggle follows each idle frame while its carousel copy stays at rest', async t => {
  let now = 0
  t.mock.method(performance, 'now', () => now)
  const p = await port()
  const noop = () => {}
  const host: UaaHost = { present: noop, setHud: noop, setLoading: noop, input: noop, frame: noop, resize: noop, widgetRect: () => ({ x: 100, y: 100, w: 160, h: 100 }), currentScreen: () => 'start', focused: () => null, destroy: noop }
  const model = startScreen([hatAsset.id], LOCAL_COSMETICS, 0, { colour: 0, worn: { head: hatAsset.id } })
  const view = mountStartScreen(host, model, { cue: noop, viewSize: () => ({ width: 800, height: 600 }) }, { port: p, character: asset('penguin'), skinned, costume: () => hatAsset, mounts: new Map([[hatAsset.id, [50, 50, 50] as Vec3T]]), environment: null })
  const bodyId = [...p.instances].find(([, name]) => name === skinned.assetId)![0]
  const [worn, carousel] = [...p.instances].filter(([, name]) => name === hatAsset.id).map(([i]) => i)
  const still = p.poseOf(carousel)!.slice()
  try {
    // Let the lazy WASM jiggle world finish loading, as it does between browser frames.
    await new Promise(resolve => setImmediate(resolve))
    for (let f = 1; f <= 90; f++) {
      now += f === 30 ? 50 : 1000 / 144
      view.update(model, null)
      follows(p.poseOf(worn)!, p.poseOf(bodyId)!)
      assert.deepEqual(p.transforms.get(worn), p.transforms.get(bodyId))
      assert.deepEqual(p.poseOf(carousel), still)
    }
    assert.notDeepEqual(p.poseOf(bodyId), still.subarray(0, body.rig.bones.length * 16), 'idle animation advanced')
  } finally { view.unmount(); assert.equal(p.render().instances, 0); p.dispose() }
})
