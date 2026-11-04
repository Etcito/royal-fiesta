import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import { createMatchSim } from '@royal-fiesta/sim/match/matchSim'
import { CosmeticJiggle, JIGGLE_DISTANCE, setJiggleQuality, wornPalette } from '../src/anim/jiggle.ts'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import type { CourseEntry } from '../src/courseSet.ts'
import { netSetup } from '../src/net/tuning.ts'
import type { PrimsAsset } from '../src/prims.ts'
import { NullRenderPort } from '../src/render/nullPort.ts'
import type { QuatT, SkinnedAssetT, SkinRigT, Vec3T } from '../src/render/port.ts'
import { SceneView } from '../src/render/sceneView.ts'

// Jiggle bones of worn cosmetics are view only (owner 2026-11-04): the option picks who is stepped, the simulation
// never sees them.

const rest = (t: number[]) => ({ t, r: [0, 0, 0, 1], s: [1, 1, 1] })
// A jester-hat-like armature on the penguin head: a root and one horn (jiggle) with its tip, pointing +X.
const HAT_RIG = {
  format: 'raa.rig', version: 1, name: 'test.hat', parentBone: 'head',
  bones: [
    { name: 'hat', parent: null, rest: rest([0, 0.98, 0]) },
    { name: 'horn', parent: 'hat', rest: rest([0.13, 0, 0]), jiggle: { maxAngle: 35, stiffness: 0.35, damping: 0.25 } },
    { name: 'horn.tip', parent: 'horn', rest: rest([0.55, 0.2, 0]) },
  ],
  bindings: [], smooth: [],
}
const PART = { name: 'p', skin: { joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) } }
const HEAD = 11
const hatSkin = (rig: object = HAT_RIG): SkinnedAssetT => ({ rig: rig as unknown as SkinRigT, parts: [PART], mount: HEAD })

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
// A 12-bone penguin skin: identity everywhere, the head lifted by `lift` (distinct from the other bones).
function penguinSkin(lift = 0.25): Float32Array {
  const m = new Float32Array(12 * 16)
  for (let b = 0; b < 12; b++) m.set(IDENTITY, b * 16)
  m[HEAD * 16 + 13] = lift
  return m
}
const UNIT: Vec3T = [1, 1, 1]
const NO_TURN: QuatT = [0, 0, 0, 1]

// The horn's swing (degrees) between a jiggled palette and the rigid mount fill.
function hornSwing(palette: Float32Array, rigid: Float32Array): number {
  const a = palette.subarray(16, 19), b = rigid.subarray(16, 19)
  const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]))
  return Math.acos(Math.min(1, Math.max(-1, dot))) * 180 / Math.PI
}

interface Frame { palette: Float32Array; stepped: number }
// Runs `frames` frames of a hat worn at a placement that slides along X for the first half, then stops.
async function wobble(jiggle: CosmeticJiggle, frames: number, opts: { mine?: boolean; distance2?: number; dtS?: number; skin?: SkinnedAssetT } = {}): Promise<Frame[]> {
  const skin = opts.skin ?? hatSkin()
  const penguin = penguinSkin()
  const out: Frame[] = []
  const dtS = opts.dtS ?? 1 / 60
  for (let f = 0; f < frames; f++) {
    const x = Math.min(f, frames / 2) * 0.1
    let palette: Float32Array | null = null
    jiggle.add(7, skin, penguin, [x, 0, 0], NO_TURN, UNIT, opts.mine !== false, opts.distance2 ?? 0)
    jiggle.flush(dtS, (instance, m) => { assert.equal(instance, 7); palette = m })
    out.push({ palette: palette!, stepped: jiggle.stepped })
    // The brick loads on the first frame that wants to step; let it land.
    await (jiggle as unknown as { loading: Promise<void> | null }).loading
  }
  return out
}

test('wornPalette: a penguin-rig copy takes the pose as is, a mounted armature its mount bone for every bone', () => {
  const penguin = penguinSkin()
  const copy: SkinnedAssetT = { rig: { bones: [] } as unknown as SkinRigT, parts: [PART] }
  assert.equal(wornPalette(copy, penguin), penguin)
  const fill = wornPalette(hatSkin(), penguin)
  assert.equal(fill.length, 3 * 16)
  for (let b = 0; b < 3; b++) assert.deepEqual([...fill.subarray(b * 16, b * 16 + 16)], [...penguin.subarray(HEAD * 16, HEAD * 16 + 16)])
})

test('jiggle option Off: nothing is stepped and the hat follows its bone rigidly', async () => {
  setJiggleQuality('off')
  try {
    const jiggle = new CosmeticJiggle()
    const rigid = wornPalette(hatSkin(), penguinSkin())
    for (const f of await wobble(jiggle, 60)) {
      assert.equal(f.stepped, 0)
      assert.deepEqual([...f.palette], [...rigid])
    }
    assert.equal((jiggle as unknown as { world: unknown }).world, null, 'Off never even loads the jiggle world')
    jiggle.dispose()
  } finally {
    setJiggleQuality('all')
  }
})

test('jiggle option All: the horn swings while the wearer slides, within maxAngle, and settles after it stops', async () => {
  setJiggleQuality('all')
  const jiggle = new CosmeticJiggle()
  const rigid = wornPalette(hatSkin(), penguinSkin())
  const frames = await wobble(jiggle, 240)
  const swings = frames.map(f => hornSwing(f.palette, rigid))
  const stepped = frames.filter(f => f.stepped === 1).length
  assert.ok(stepped >= 238, `stepped on ${stepped} of 240 frames (the first waits for the brick)`)
  const peak = Math.max(...swings.slice(0, 120))
  assert.ok(peak > 2, `the horn swung ${peak.toFixed(2)} deg while sliding`)
  assert.ok(Math.max(...swings) <= 35 + 1e-3, 'never past maxAngle')
  assert.ok(swings[239] < peak / 10, `settled to ${swings[239].toFixed(3)} deg after stopping (peak ${peak.toFixed(2)})`)
  // The hat root (no jiggle) stays on its bone.
  for (const f of frames) for (let i = 0; i < 16; i++) assert.ok(Math.abs(f.palette[i] - rigid[i]) < 1e-5)
  jiggle.dispose()
})

test('the shipped jester hat: its own armature on the penguin head, both horns swing', async () => {
  const file = JSON.parse(readFileSync(new URL('../../../assets/common/costume.jester-hat.asset.json', import.meta.url), 'utf8'))
  const rig = file.document.nodes.hat_jester_hat.rig
  assert.equal(rig.parentBone, 'head')
  const skin = hatSkin(rig)
  const rigid = wornPalette(skin, penguinSkin())
  const jiggle = new CosmeticJiggle()
  const frames = await wobble(jiggle, 120, { skin })
  const swingOf = (bone: number) => Math.max(...frames.map(f => {
    const a = f.palette.subarray(bone * 16, bone * 16 + 3), b = rigid.subarray(bone * 16, bone * 16 + 3)
    const dot = (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / (Math.hypot(a[0], a[1], a[2]) * Math.hypot(b[0], b[1], b[2]))
    return Math.acos(Math.min(1, dot)) * 180 / Math.PI
  }))
  const names = rig.bones.map((b: { name: string }) => b.name)
  for (const horn of ['horn.l', 'horn.r']) {
    const peak = swingOf(names.indexOf(horn))
    assert.ok(peak > 2 && peak <= 25 + 1e-3, `${horn} swung ${peak.toFixed(2)} deg (maxAngle 25)`)
  }
  assert.ok(swingOf(names.indexOf('hat')) < 1e-3, 'the crown stays on the head')
  jiggle.dispose()
})

test('jiggle culling: Local player only, distance and late frames keep the hat rigid', async () => {
  const rigid = wornPalette(hatSkin(), penguinSkin())
  const check = async (label: string, opts: Parameters<typeof wobble>[2]) => {
    const jiggle = new CosmeticJiggle()
    for (const f of await wobble(jiggle, 30, opts)) {
      assert.equal(f.stepped, 0, label)
      assert.deepEqual([...f.palette], [...rigid], label)
    }
    jiggle.dispose()
  }
  try {
    setJiggleQuality('local')
    await check('local quality, other player', { mine: false })
    setJiggleQuality('all')
    await check('all quality, beyond the distance', { mine: false, distance2: (JIGGLE_DISTANCE + 1) ** 2 })
    await check('late frame', { dtS: 1 / 20 })
    // Within reach, another player's hat does jiggle under All.
    const jiggle = new CosmeticJiggle()
    const frames = await wobble(jiggle, 10, { mine: false, distance2: (JIGGLE_DISTANCE - 1) ** 2 })
    assert.equal(frames[9].stepped, 1)
    jiggle.dispose()
  } finally {
    setJiggleQuality('all')
  }
})

// ---- the simulation never sees the jiggle ---------------------------------------------------------------------

const ROOT = new URL('../../../', import.meta.url)
const read = async (rel: string) => readFileSync(new URL(rel, ROOT), 'utf8')
const resolver = fixtureResolver(read)
const R = await initRapier()
const entries: CourseEntry[] = []
for (const e of readdirSync(new URL('fixtures/courses/', ROOT), { withFileTypes: true })) {
  if (e.isFile() && e.name.endsWith('.course.json')) entries.push({ path: `fixtures/courses/${e.name}`, json: JSON.parse(await read(`fixtures/courses/${e.name}`)) })
}
entries.sort((a, b) => a.path.localeCompare(b.path))
const courses: ResolvedCourse[] = await matchCourses(entries, resolver, 'sprint')
const assets = new Map<string, PrimsAsset>()
for (const c of courses) for (const o of c.obstacles) if (!assets.has(o.asset)) assets.set(o.asset, (await resolver.resolve(o.asset)).asset)
const bean = (await resolver.resolve('bean')).asset
const node = JSON.parse(await read('assets/common/penguin.body.asset.json')).document.nodes.penguin
const skinned = { assetId: 'penguin', graph: await read('assets/common/penguin.animgraph.json'), skin: { rig: node.rig, clips: node.clips, parts: [PART] } }
const hatAsset = { ...bean, id: 'test.hat' } as PrimsAsset

// Every snapshot of a 5-player match where everyone wears the hat, and the hat palettes the view drew.
async function match(quality: 'all' | 'off'): Promise<{ snapshots: Uint8Array[]; palettes: Float32Array[]; stepped: number }> {
  setJiggleQuality(quality)
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  const port = new NullRenderPort()
  await port.init({ canvas: null, width: 64, height: 36, viewports: [{ x: 0, y: 0, width: 64, height: 36 }] })
  const view = new SceneView({
    port, viewport: 0, localPlayer: 0, bean, assets: n => assets.get(n)!, loadingPaint: false, skinned,
    costumes: { hat: { asset: hatAsset, skin: hatSkin() } },
  })
  const palettes: Float32Array[] = []
  const pose = port.setPose.bind(port)
  port.setPose = (instance: number, m: Float32Array) => { pose(instance, m); if (m.length === 3 * 16) palettes.push(m.slice()) }
  const snapshots: Uint8Array[] = []
  let stepped = 0
  const jiggle = (view as unknown as { jiggle: CosmeticJiggle }).jiggle
  try {
    view.update(sim, null, 1, 0)
    await (view as unknown as { animLoading: Promise<void> }).animLoading
    for (let tick = 0; tick < 360; tick++) {
      // Everyone runs forward and turns: the hats swing.
      const inputs = Array.from({ length: sim.setup.playerCount }, (_, p) => ({ ...neutralInput(), moveZ: 1, moveX: tick % 120 < 60 ? (p % 2 ? 1 : -1) : 0 }))
      sim.step(inputs)
      view.update(sim, null, 1, 1 / 60)
      stepped += jiggle.stepped
      await (jiggle as unknown as { loading: Promise<void> | null }).loading
      snapshots.push(sim.world.takeSnapshotBytes().slice())
    }
  } finally {
    view.dispose()
    sim.free()
    setJiggleQuality('all')
  }
  return { snapshots, palettes, stepped }
}

test('the simulation snapshot is byte for byte the same with jiggle bones All and Off', async () => {
  const on = await match('all')
  const off = await match('off')
  assert.ok(on.stepped > 0, 'All stepped the hats')
  assert.equal(off.stepped, 0, 'Off stepped nothing')
  assert.equal(on.snapshots.length, off.snapshots.length)
  for (let i = 0; i < on.snapshots.length; i++) assert.deepEqual(on.snapshots[i], off.snapshots[i], `snapshot ${i} differs`)
  // ...while the view did draw different hats.
  let differs = false
  for (let i = 0; i < Math.min(on.palettes.length, off.palettes.length) && !differs; i++) {
    for (let k = 0; k < on.palettes[i].length; k++) if (Math.abs(on.palettes[i][k] - off.palettes[i][k]) > 1e-4) { differs = true; break }
  }
  assert.ok(differs, 'the jiggle changed what the view drew')
})
