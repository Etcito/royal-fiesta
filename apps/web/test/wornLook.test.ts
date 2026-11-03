import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync, readdirSync } from 'node:fs'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { fixtureResolver } from '@royal-fiesta/game/assets'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import { startScreen, LOCAL_COSMETICS } from '@royal-fiesta/game/flow/startScreen'
import { netSetup } from '@royal-fiesta/game/net/tuning'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import { SceneView } from '@royal-fiesta/game/render/sceneView'
import type { Vec3T, QuatT } from '@royal-fiesta/game/render/port'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { neutralInput } from '@royal-fiesta/sim/input'
import { createMatchSim } from '@royal-fiesta/sim/match/matchSim'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { HubView } from '../src/play/hubView.ts'
import { playerLook } from '../src/play/playerLook.ts'

const root = new URL('../../../', import.meta.url)
const read = async (path: string) => readFileSync(new URL(path, root), 'utf8')
const resolver = fixtureResolver(read)
const bean = (await resolver.resolve('bean')).asset
class Recorder extends NullRenderPort {
  readonly names = new Map<number, string>()
  readonly draws = new Map<number, { name: string; tint: Vec3T | null; t?: Vec3T; visible: boolean }>()
  override registerAsset(name: string, asset: PrimsAsset) { const h = super.registerAsset(name, asset); this.names.set(h, name); return h }
  override createInstance(asset: number, tint: Vec3T | null) { const i = super.createInstance(asset, tint); this.draws.set(i, { name: this.names.get(asset)!, tint, visible: true }); return i }
  override setTransform(i: number, t: Vec3T, r: QuatT, s: Vec3T) { super.setTransform(i, t, r, s); this.draws.get(i)!.t = [...t] }
  override setVisible(i: number, on: boolean) { super.setVisible(i, on); this.draws.get(i)!.visible = on }
  override destroyInstance(i: number) { super.destroyInstance(i); this.draws.delete(i) }
}

test('start wardrobe mounts all four bins and chosen tint on hub and round local instances', async () => {
  const ids = ['costume.propeller-hat.rose', 'costume.dragon-suit', 'costume.fish-scarf', 'costume.jetpack']
  const model = startScreen(ids, LOCAL_COSMETICS, 0, { colour: 6, worn: { head: ids[0], body: ids[1], bottom: ids[2], special: ids[3] } })
  const costumes = new Map(ids.map(id => [id, { ...bean, id: id.replace('.rose', '') }]))
  const look = playerLook(model, { mounts: new Map(ids.map((id, i) => [id, [0, i + 1, 0] as Vec3T])), costume: id => costumes.get(id) ?? null })!
  assert.equal(look.items.length, 4)
  const port = new Recorder()
  await port.init({ canvas: null, width: 64, height: 64, viewports: [{ x: 0, y: 0, width: 64, height: 64 }] })
  let current = look
  const hub = new HubView(port, 0, () => bean, bean, { obstacles: [] } as unknown as ResolvedCourse, { look: () => current })
  const state = { pos: { x: 4, y: 2, z: 3 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 1, z: 0 }, mode: 0, grounded: true, groundObstacle: -1, knockbacks: 0, teleportTick: 0 }
  hub.update(state, 0, [], 0, 0)
  const check = () => {
    for (const item of look.items) {
      const drawn = [...port.draws.values()].filter(d => d.name === item.asset.id)
      assert.equal(drawn.length, 1)
      assert.deepEqual(drawn[0].tint, item.tint)
      assert.ok(drawn[0].t)
    }
    assert.ok([...port.draws.values()].some(d => d.name === bean.id && d.tint === PALETTE[6]))
  }
  check()
  assert.deepEqual([...port.draws.values()].find(d => d.name === look.items[0].asset.id)!.t, [4, 3, 3])
  hub.setVisible(false)
  assert.ok([...port.draws.values()].every(d => !d.visible))
  hub.setVisible(true)
  current = { ...look, items: [] }
  hub.update(state, 0, [], 1, 0)
  assert.equal([...port.draws.values()].filter(d => d.name.startsWith('costume.')).length, 0)
  hub.dispose()
  assert.equal(port.draws.size, 0)

  const paths = readdirSync(new URL('fixtures/courses/', root)).filter(p => p.endsWith('.course.json'))
  const courses = await matchCourses(await Promise.all(paths.map(async path => ({ path, json: JSON.parse(await read('fixtures/courses/' + path)) }))), resolver, 'sprint')
  const assets = new Map<string, PrimsAsset>()
  for (const c of courses) for (const o of c.obstacles) assets.set(o.asset, (await resolver.resolve(o.asset)).asset)
  const R = await initRapier()
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  const scene = new SceneView({ port, viewport: 0, localPlayer: 0, bean, assets: id => assets.get(id)!, loadingPaint: false, look: () => look })
  try { for (let i = 0; i < 200; i++) { sim.step(Array.from({ length: 8 }, neutralInput)); scene.update(sim, null, 1, 1 / 60) } check() } finally { scene.dispose(); sim.free() }
  assert.equal(port.draws.size, 0)
  port.dispose()
})

test('penguin-bound wardrobe items receive the body matrices and ignore legacy mount offsets', async () => {
  const { WornMounts } = await import('../../../packages/game/src/render/wornLook.ts')
  const rig = { format: 'raa.rig', version: 1, name: 'test', bones: [{ name: 'root', parent: null, rest: { t: [0,0,0], r: [0,0,0,1], s: [1,1,1] } }] }
  const skin = { rig, parts: [{ name: 'prop', skin: { joints: new Uint16Array(4), weights: new Float32Array([1,0,0,0]) } }] }
  class SkinRecorder extends Recorder {
    skinOf() { return skin }
    readonly submitted: Float32Array[] = []
    override setPose(i: number, pose: Float32Array) { super.setPose(i, pose); this.submitted.push(pose.slice()) }
  }
  const port = new SkinRecorder()
  await port.init({ canvas: null, width: 64, height: 64, viewports: [{x:0,y:0,width:64,height:64}] })
  const mounts = new WornMounts(port)
  mounts.sync({colour:0,items:[{asset:bean,mount:[100,200,300],tint:null}]})
  for (const y of [0.3,-0.4]) {
    const pose = new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,y,0,1])
    mounts.setPose(pose); mounts.draw([4,2,3],[0,0,0,1],[1,1,1])
    assert.deepEqual(port.submitted.at(-1),pose)
    assert.deepEqual([...port.draws.values()][0].t,[4,2,3])
  }
  mounts.dispose(); assert.equal(port.draws.size,0); port.dispose()
})
