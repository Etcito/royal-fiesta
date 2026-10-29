// Proves the real-game skin wiring (Q11) without a GPU: the MAMA worker meshes assets/common/penguin.body.asset.json
// and now carries each part's S18 joints/weights in its payload; the SDF provider's characterSkin step (inlined
// here, the provider imports the graph through Vite ?raw) builds the SkinnedCharacter from that payload, the
// document rig and clips and penguin.animgraph.json; SceneView registers it once per port and poses every
// character of a real 8-player MatchSim. Writes proofs/m19/scene-view-skin-wiring.json.
// Usage: node --experimental-strip-types proofs/m19/scene-view-skin-wiring.mjs
import assert from 'node:assert/strict'
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { createMatchSim } from '@royal-fiesta/sim/match/matchSim'
import { neutralInput } from '@royal-fiesta/sim/input'
import { nodeGameAssets } from '../../apps/headless/src/contentFiles.ts'
import { meshGameAsset } from '../../apps/headless/src/mama/meshNode.ts'
import { fixtureResolver } from '../../packages/game/src/assets.ts'
import { matchCourses } from '../../packages/game/src/courseSet.ts'
import { netSetup } from '../../packages/game/src/net/tuning.ts'
import { NullRenderPort } from '../../packages/game/src/render/nullPort.ts'
import { SceneView } from '../../packages/game/src/render/sceneView.ts'

const { asset } = await nodeGameAssets().resolve('penguin.body')
const meshed = await meshGameAsset(asset, { timeoutMs: 55000 })

// apps/web/src/content/providers/sdf.ts characterSkin, step for step.
const parts = []
const keys = new Set()
for (const group of meshed.data.groups) {
  for (const part of group.parts) {
    const key = keys.has(part.name) ? `${group.group}/${part.partId}` : part.name
    keys.add(key)
    const vertices = part.meshes.reduce((n, m) => n + m.positions.length / 3, 0)
    if (part.skin !== undefined) {
      assert.equal(part.skin.joints.length, vertices * 4, `${key}: one joint quad per vertex of the concatenated part mesh`)
      parts.push({ name: key, skin: part.skin })
    }
  }
}
assert.ok(parts.length > 0, 'the meshed penguin carries a part skin')
const owner = Object.values(asset.document.nodes).find(node => node.rig !== undefined)
const skinned = { assetId: 'penguin.body', skin: { rig: owner.rig, clips: owner.clips ?? [], parts }, graph: readFileSync('assets/common/penguin.animgraph.json', 'utf8') }

const resolver = fixtureResolver(async rel => readFileSync(rel, 'utf8'))
const entries = readdirSync('fixtures/courses').filter(n => n.endsWith('.course.json')).sort()
  .map(n => ({ path: `fixtures/courses/${n}`, json: JSON.parse(readFileSync(`fixtures/courses/${n}`, 'utf8')) }))
const courses = await matchCourses(entries, resolver, 'sprint')
const assets = new Map()
for (const c of courses) for (const o of c.obstacles) if (!assets.has(o.asset)) assets.set(o.asset, (await resolver.resolve(o.asset)).asset)
const bean = (await resolver.resolve('bean')).asset

const R = await initRapier()
const setup = netSetup(7, 1, 'sprint', courses)
const sim = createMatchSim(R, { ...setup, humans: setup.humans.map(() => false) })
const port = new NullRenderPort()
await port.init({ canvas: null, width: 320, height: 180, viewports: [{ x: 0, y: 0, width: 320, height: 180 }] })
let registered = 0
const register = port.registerSkinned.bind(port)
port.registerSkinned = (id, skin) => { registered++; return register(id, skin) }
const opts = { port, viewport: 0, localPlayer: 0, bean, assets: n => assets.get(n), skinned }
const view = new SceneView(opts)
const second = new SceneView(opts)
assert.equal(view.animationError, null)
assert.equal(registered, 1, 'two views on one port register the skinned penguin once')

const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
for (let f = 0; f < 120 && view.anim === null; f++) {
  view.update(sim, null, 1, 1 / 30)
  await new Promise(r => setTimeout(r, 20))
}
assert.ok(view.anim !== null, 'the animation driver loaded')
for (let f = 0; f < 180; f++) {
  for (let k = 0; k < (f % 6 === 5 ? 0 : 2); k++) sim.step(inputs)
  view.update(sim, null, 1, 1 / 30)
}
const poses = view.beans.map(h => port.poseOf(h)).filter(p => p !== null)
const distinct = new Set(poses.map(p => Array.from(p.subarray(0, 64), v => v.toFixed(4)).join()))
assert.equal(poses.length, sim.setup.playerCount, 'every character is posed')
assert.ok(distinct.size >= 2, 'characters carry their own poses')
const record = {
  asset: 'assets/common/penguin.body.asset.json', mesher: meshed.mesher, skinnedParts: parts.map(p => ({ name: p.name, vertices: p.skin.joints.length / 4 })),
  bones: owner.rig.bones.length, clips: skinned.skin.clips.length, characters: sim.setup.playerCount, posed: poses.length,
  distinctPoses: distinct.size, setPoseCalls: port.calls.setPose, tick: sim.tick,
  registerSkinnedCalls: registered, views: 2,
}
second.dispose()
view.dispose()
writeFileSync('proofs/m19/scene-view-skin-wiring.json', JSON.stringify(record, null, 2) + '\n')
console.log(JSON.stringify(record, null, 2))
process.exit(0)
