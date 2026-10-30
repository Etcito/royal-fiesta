import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { NetSim } from '@gamesaloon/rollback'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import type { CourseEntry } from '../src/courseSet.ts'
import { createNetMatch } from '../src/net/netMatch.ts'
import type { NetMatch } from '../src/net/netMatch.ts'
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
const skinned = {
  assetId: 'penguin', graph: await read('assets/common/penguin.animgraph.json'),
  skin: { rig: node.rig, clips: node.clips, parts: [{ name: 'p', skin: { joints: new Uint16Array(4), weights: new Float32Array([1, 0, 0, 0]) } }] },
}

const CV = { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 }, mode: 0, status: 0, parked: false, teleportTick: 0 }
let maxSpeed = 0
interface Win { match: NetMatch; view: SceneView; hz: number; next: number; submits: number; poses: Map<number, Float32Array> }

// Two peers of one online round on a simulated network, each window drawing at its own display rate.
async function run(hzs: number[], seconds: number): Promise<Win[]> {
  const netsim = new NetSim(hzs.length, { seed: 1, rttMs: 20, jitterMs: 0, loss: 0 })
  const setup = netSetup(7, hzs.length, 'sprint', courses)
  const wins: Win[] = []
  for (let p = 0; p < hzs.length; p++) {
    const match = createNetMatch(R, { setup, localPeer: p, humanPeers: hzs.length }, netsim.transport(p))
    const port = new NullRenderPort()
    await port.init({ canvas: null, width: 64, height: 36, viewports: [{ x: 0, y: 0, width: 64, height: 36 }] })
    const view = new SceneView({ port, viewport: 0, localPlayer: p, bean, assets: n => assets.get(n)!, loadingPaint: false, skinned })
    const w: Win = { match, view, hz: hzs[p], next: 0, submits: 0, poses: new Map() }
    port.setPose = (inst: number, m: Float32Array) => { w.submits++; if ((view as unknown as { beans: number[] }).beans.indexOf(inst) === 0) w.poses.set(match.sim.tick, Float32Array.from(m)); const c = match.sim.character(0, CV); maxSpeed = Math.max(maxSpeed, Math.hypot(c.vel.x, c.vel.z)) }
    view.update(match.sim, null, 1, 0)
    await (view as unknown as { animLoading: Promise<void> }).animLoading
    wins.push(w)
  }
  let t = 0
  try {
    while (t < seconds * 1000) {
      t += 0.25
      netsim.advance(0.25)
      for (const w of wins) {
        if (t < w.next) continue
        w.next += 1000 / w.hz
        const alpha = w.match.frame(1 / w.hz, out => { out[0].moveZ = 1; out[0].moveX = 0 })
        w.view.update(w.match.sim, null, alpha, 1 / w.hz)
      }
    }
  } finally {
    for (const w of wins) { w.view.dispose(); w.match.dispose() }
  }
  return wins
}

// The arm cycle is a function of sim ticks, so a walking penguin carries the identical skin pose at every tick whatever
// the display rate of the window drawing it (here the local window at 60, 144 and 175 Hz next to a 60 Hz neighbour).
test('online round, walking penguin: the same skin pose per sim tick at 60, 144 and 175 Hz', async () => {
  const base = (await run([60, 60], 12))[0].poses
  assert.ok(maxSpeed > 3, `the penguin walks (${maxSpeed} m/s)`)
  for (const hz of [144, 175]) {
    const poses = (await run([hz, 60], 12))[0].poses
    let compared = 0
    for (const [tick, pose] of poses) {
      const ref = base.get(tick)
      if (ref === undefined) continue
      compared++
      for (let i = 0; i < pose.length; i++) assert.ok(Math.abs(pose[i] - ref[i]) < 1e-6, `${hz} Hz: pose at tick ${tick} differs at ${i}`)
    }
    assert.ok(compared > 500, `${hz} Hz: ${compared} ticks compared`)
  }
})
