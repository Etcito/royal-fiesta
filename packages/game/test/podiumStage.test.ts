import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import type { PodiumLayout } from '@royal-fiesta/game/content'
import { parsePrims } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import type { CameraPose, QuatT, Vec3T } from '@royal-fiesta/game/render/port'
import { PALETTE } from '@royal-fiesta/game/render/palette'
import { PODIUM_V0_LAYOUT, PodiumStage } from '@royal-fiesta/game/render/podiumStage'

const ROOT = new URL('../../../', import.meta.url)
const load = (name: string) => {
  const path = `fixtures/assets/${name}.prims.json`
  return parsePrims(JSON.parse(readFileSync(new URL(path, ROOT), 'utf8')) as unknown, path)
}
const bean = load('bean')
const block = load('wall-block')
// Matches the stage's bean capsule half height: the bean origin stands this far above its spot.
const BEAN_HALF = 0.85

// Records each live instance (asset, tint, last position) and the last camera per viewport.
class SpyPort extends NullRenderPort {
  readonly inst = new Map<number, { asset: number; tint: Vec3T | null; t: Vec3T | null }>()
  readonly cams = new Map<number, CameraPose>()
  override createInstance(asset: number, tint: Vec3T | null): number {
    const h = super.createInstance(asset, tint)
    this.inst.set(h, { asset, tint, t: null })
    return h
  }
  override setTransform(instance: number, t: Vec3T, r: QuatT, s: Vec3T): void {
    super.setTransform(instance, t, r, s)
    this.inst.get(instance)!.t = [t[0], t[1], t[2]]
  }
  override destroyInstance(instance: number): void {
    super.destroyInstance(instance)
    this.inst.delete(instance)
  }
  override setCamera(viewport: number, cam: CameraPose): void {
    super.setCamera(viewport, cam)
    this.cams.set(viewport, cam)
  }
}

async function stage(layout?: PodiumLayout): Promise<{ port: SpyPort; stage: PodiumStage }> {
  const port = new SpyPort()
  await port.init({ canvas: null, width: 1920, height: 1080, viewports: [{ x: 0, y: 0, width: 1920, height: 1080 }] })
  return { port, stage: new PodiumStage({ port, viewport: 0, bean, block, layout }) }
}

// Where the bean of each player stands (its feet), found by its tint.
function feetOf(port: SpyPort, players: readonly number[]): Vec3T[] {
  const beanAsset = port.registerAsset('bean', bean)
  return players.map(p => {
    const found = [...port.inst.values()].find(i => i.asset === beanAsset && i.tint === PALETTE[p])
    assert.ok(found?.t, `bean of player ${p} is placed`)
    return [found.t[0], found.t[1] - BEAN_HALF, found.t[2]] as Vec3T
  })
}

function near(a: readonly number[], b: readonly number[], msg: string): void {
  for (let i = 0; i < a.length; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-9, `${msg}: ${a} vs ${b}`)
}

test('PODIUM_V0_LAYOUT holds the V0 constants: no course, 3 spots, top spot first', () => {
  assert.equal(PODIUM_V0_LAYOUT.courseId, null)
  assert.equal(PODIUM_V0_LAYOUT.spots.length, 3)
  const ys = PODIUM_V0_LAYOUT.spots.map(s => s.t[1])
  assert.equal(Math.max(...ys), ys[0])
})

test('everything is hidden until show', async () => {
  const { port } = await stage()
  const s = port.render()
  assert.equal(s.instances, 6)
  assert.equal(s.visible, 0)
})

test('show([5,2,7]) shows three blocks and three beans', async () => {
  const { port, stage: st } = await stage()
  st.show([5, 2, 7])
  st.update(1 / 60)
  const s = port.render()
  assert.equal(s.visible, 6)
  assert.equal(s.instances, 6)
})

test('3 finishers stand on the layout spots in podium order, the winner highest', async () => {
  const { port, stage: st } = await stage()
  st.show([5, 2, 7])
  const feet = feetOf(port, [5, 2, 7])
  for (let i = 0; i < 3; i++) near(feet[i], PODIUM_V0_LAYOUT.spots[i].t, `place ${i + 1}`)
  const top = Math.max(...PODIUM_V0_LAYOUT.spots.map(s => s.t[1]))
  assert.equal(feet[0][1], top)
})

test('the camera pose equals the layout camera', async () => {
  const { port, stage: st } = await stage()
  st.show([0, 1, 2])
  st.update(1 / 60)
  assert.deepEqual(port.cams.get(0), PODIUM_V0_LAYOUT.camera)
  assert.deepEqual(st.camera, PODIUM_V0_LAYOUT.camera)
})

test('a custom layout moves both the finishers and the camera', async () => {
  const layout: PodiumLayout = {
    courseId: 'podium',
    spots: [{ t: [10, 3, 20], yawDeg: 180 }, { t: [12, 2, 20], yawDeg: 180 }, { t: [8, 1.5, 20], yawDeg: 180 }],
    camera: { eye: [10, 5, 12], target: [10, 2, 20], fovYDeg: 50, near: 0.2, far: 300 },
  }
  const { port, stage: st } = await stage(layout)
  st.show([3, 4, 6])
  st.update(1 / 60)
  const feet = feetOf(port, [3, 4, 6])
  // The winner bobs on its spot (0..0.15 m), the others stand still.
  for (let i = 0; i < 3; i++) {
    const want = layout.spots[i].t
    near([feet[i][0], feet[i][2]], [want[0], want[2]], `place ${i + 1}`)
    assert.ok(feet[i][1] >= want[1] && feet[i][1] <= want[1] + 0.15, `place ${i + 1} height ${feet[i][1]}`)
  }
  assert.deepEqual(port.cams.get(0), layout.camera)
})

test('a layout without exactly 3 spots refuses', async () => {
  const layout: PodiumLayout = { ...PODIUM_V0_LAYOUT, spots: PODIUM_V0_LAYOUT.spots.slice(0, 2) }
  await assert.rejects(stage(layout), /\[render\] PodiumStage layout#\/spots: 2 spots/)
})

test('labels put 1st above 2nd and 3rd and between them, inside the frame', async () => {
  const { stage: st } = await stage()
  st.show([5, 2, 7])
  for (let i = 0; i < 30; i++) st.update(1 / 60)
  const ls = st.labels(1920, 1080)
  assert.deepEqual(ls.map(l => l.player), [5, 2, 7])
  assert.deepEqual(ls.map(l => l.place), [1, 2, 3])
  for (const l of ls) {
    assert.ok(l.x > 0 && l.x < 1920 && l.y > 0 && l.y < 1080, `label ${l.place} at ${l.x},${l.y}`)
  }
  const [a, b, c] = ls
  assert.ok(a.y < b.y && a.y < c.y)
  assert.ok(b.x < a.x && a.x < c.x, '2nd on the left, 3rd on the right')
})

test('show([1]) leaves only one bean visible', async () => {
  const { port, stage: st } = await stage()
  st.show([5, 2, 7])
  st.show([1])
  const s = port.render()
  assert.equal(s.visible, 4)
  assert.equal(s.instances, 6)
  assert.equal(st.labels(1920, 1080).length, 1)
})

test('show refuses an empty or oversized podium', async () => {
  const { stage: st } = await stage()
  assert.throws(() => st.show([]), /\[render\] PodiumStage\.show/)
  assert.throws(() => st.show([0, 1, 2, 3]), /1 to 3/)
  assert.throws(() => st.show([8]), /outside/)
})

test('hide hides every instance and dispose destroys them', async () => {
  const { port, stage: st } = await stage()
  st.show([0, 1, 2])
  st.hide()
  assert.equal(port.render().visible, 0)
  st.dispose()
  assert.equal(port.render().instances, 0)
})
