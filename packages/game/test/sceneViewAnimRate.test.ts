import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import { createMatchSim } from '@royal-fiesta/sim/match/matchSim'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import type { CourseEntry } from '../src/courseSet.ts'
import { netSetup } from '../src/net/tuning.ts'
import type { PrimsAsset } from '../src/prims.ts'
import { NullRenderPort } from '../src/render/nullPort.ts'
import { SceneView } from '../src/render/sceneView.ts'

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
// The real rig, clips and graph; one skinned vertex is enough for the null port.
const skinned = {
  assetId: 'penguin', graph: await read('assets/common/penguin.animgraph.json'),
  skin: { rig: node.rig, clips: node.clips, parts: [{ name: 'p', skin: { joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) } }] },
}
const TICK_MS = 1000 / 60

// The skin pose submitted for every character at every tick a frame drew, with the display at `hz`.
async function run(hz: number, seconds: number): Promise<Map<string, Float32Array>> {
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  const port = new NullRenderPort()
  await port.init({ canvas: null, width: 64, height: 36, viewports: [{ x: 0, y: 0, width: 64, height: 36 }] })
  const view = new SceneView({ port, viewport: 0, localPlayer: 0, bean, assets: n => assets.get(n)!, loadingPaint: false, skinned })
  const poses = new Map<string, Float32Array>()
  const beans = () => (view as unknown as { beans: number[] }).beans
  port.setPose = (instance: number, m: Float32Array) => { poses.set(`${sim.tick}:${beans().indexOf(instance)}`, Float32Array.from(m)) }
  const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
  // The graphs load asynchronously: let them load before the clock starts, so every run observes the same ticks.
  view.update(sim, null, 1, 0)
  await (view as unknown as { animLoading: Promise<void> }).animLoading
  let t = 0
  let next = 0
  let acc = 0
  try {
    while (t < seconds * 1000) {
      t += 0.25
      acc += 0.25
      while (acc >= TICK_MS) { acc -= TICK_MS; sim.step(inputs) }
      if (t >= next) {
        next += 1000 / hz
        view.update(sim, null, 1, 1 / hz)
      }
    }
  } finally {
    view.dispose()
    sim.free()
  }
  return poses
}

test('skinned characters: the animation graph steps once per sim tick, the same pose per tick at 60, 75 and 144 Hz', async () => {
  const [a, b, c] = [await run(60, 12), await run(75, 12), await run(144, 12)]
  let compared = 0
  for (const other of [b, c]) {
    for (const [key, pose] of other) {
      const ref = a.get(key)
      if (ref === undefined) continue
      compared++
      for (let i = 0; i < pose.length; i++) assert.ok(Math.abs(pose[i] - ref[i]) < 1e-6, `pose ${key} differs at ${i}`)
    }
  }
  assert.ok(compared > 500, `${compared} poses compared`)
})
