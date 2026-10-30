import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '../../sim/src/course.ts'
import { neutralInput } from '../../sim/src/input.ts'
import { createMatchSim } from '../../sim/src/match/matchSim.ts'
import type { RoundSystem } from '../../sim/src/match/roundSystem.ts'
import { PROFILES } from '../../sim/src/match/setup.ts'
import { DEFAULT_BUDGET } from '../../sim/src/mechanismSpec.ts'
import type { MechanismSpec } from '../../sim/src/mechanismSpec.ts'
import { isRefusal } from '../../sim/src/refusal.ts'
import { pose } from '../../sim/src/vec.ts'
import { loadCourseV1 } from '../src/courseV1.ts'
import type { CourseV1, GameAssetResolver } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { AssetJointJson, World } from '../src/gameAsset.ts'
import { parseAssetPhysics } from '../src/mechanismsJson.ts'

const ROOT = new URL('../../../', import.meta.url)
const readJson = async (path: string): Promise<unknown> => JSON.parse(await readFile(new URL(path, ROOT), 'utf8'))
const assets: GameAssetResolver = {
  async resolve(id) {
    const path = assetFilePath(id.split('.')[0] as World, id)
    const json = await readJson(path)
    return { asset: await parseGameAsset(json, path), source: { path, json } }
  },
}
const IDS = ['candy-seesaw-run', 'ice-slide-gates', 'jungle-crane-crossing', 'neon-piston-alley'] as const

interface LoadedCourse { v1: CourseV1; sim: ResolvedCourse; json: Record<string, unknown> }
async function load(id: string): Promise<LoadedCourse> {
  const path = `courses/${id}.course.json`
  const json = await readJson(path) as Record<string, unknown>
  const v1 = await loadCourseV1(json, path, assets)
  assert.ok(v1.sim, `${id} has a simulation course`)
  return { v1, sim: v1.sim, json }
}

function usedBudget(m: MechanismSpec): { dynamicBodies: number; joints: number } {
  let dynamicBodies = 0
  let joints = m.joints.length
  for (const item of m.items) {
    joints += item.joints.length
    for (const body of item.bodies) if (body.type === 'dynamic') dynamicBodies++
  }
  return { dynamicBodies, joints }
}

const R = await initRapier()
const survival = (await load('survival-sprint')).sim

test('world asset jungle.vine-bridge loads a suspended platform chain within course budgets', async () => {
  const path = 'assets/jungle/jungle.vine-bridge.asset.json'
  const json = await readJson(path) as Record<string, unknown>
  const asset = await parseGameAsset(json, path)
  const physics = parseAssetPhysics(json.physics, asset.collision, path)
  assert.ok(physics)
  assert.equal(asset.world, 'jungle')
  assert.equal(asset.collision.length, 8)
  assert.deepEqual(physics.bodies.filter(b => b.type === 'fixed').map(b => b.id), ['post-a', 'post-b'])
  const planks = physics.bodies.filter(b => b.type === 'dynamic')
  assert.equal(planks.length, 6)
  assert.equal(physics.joints.length, 14)
  assert.deepEqual(physics.bodies.flatMap(b => b.colliders).sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7])
  const chain = ['post-a', ...planks.map(b => b.id), 'post-b']
  for (let i = 0; i < chain.length - 1; i++) {
    const ropes: AssetJointJson[] = physics.joints.filter(j => j.a === chain[i] && j.b === chain[i + 1])
    assert.equal(ropes.length, 2, 'each span is suspended on both sides')
    for (const rope of ropes) {
      assert.equal(rope.kind, 'rope')
      assert.match(rope.a, /^[a-z0-9-]{1,32}$/)
      assert.match(rope.b, /^[a-z0-9-]{1,32}$/)
      const distance = Math.hypot(...rope.anchorA.map((v, k) => v - rope.anchorB[k]))
      assert.ok(rope.lengthM! >= distance, 'rope is not overstretched at rest')
      assert.ok(rope.lengthM! < distance + 0.021, 'limited slack keeps the deck connected')
    }
  }

  // Load through S13 so collider ownership, bot-visible platform geometry and both
  // budgets are exercised by the real course loader, independently of M4 course files.
  const course = await readJson('courses/race-sprint.course.json') as Record<string, unknown>
  course.id = 'bridge-test'
  course.obstacles = [{ id: 'bridge', asset: asset.id, t: [0, 2, 8], r: [0, 0, 0, 1], s: [1, 1, 1],
    colliders: null, friction: 0.85, motion: { kind: 'static' } }]
  course.mechanisms = { budget: DEFAULT_BUDGET }
  const loaded = await loadCourseV1(course, 'bridge-test.course.json', assets)
  assert.ok(loaded.sim?.mechanisms)
  const m = loaded.sim.mechanisms
  assert.deepEqual(usedBudget(m), { dynamicBodies: 6, joints: 14 })
  assert.equal(loaded.sim.obstacles.length, 0)
  const item = m.items[0]
  for (const body of item.bodies.filter(b => b.type === 'dynamic')) {
    assert.equal(body.surface, 'normal')
    assert.equal(body.colliders.length, 1)
    const collider = body.colliders[0]
    assert.equal(collider.shape, 'cuboid')
    if (collider.shape !== 'cuboid') throw new Error('plank must be a platform cuboid')
    assert.ok(collider.half.x >= 1.5 && collider.half.z >= 0.5)
    assert.ok(collider.half.y <= 0.15)
    assert.deepEqual(collider.r, { x: 0, y: 0, z: 0, w: 1 })
    assert.equal(body.rest.t.y, 2)
  }
  for (const joint of item.joints) {
    assert.ok(item.bodies[joint.a.body])
    assert.ok(item.bodies[joint.b.body])
    assert.notEqual(joint.a.body, joint.b.body)
  }
  for (const budget of [{ dynamicBodies: 5, joints: 32 }, { dynamicBodies: 24, joints: 13 }]) {
    course.mechanisms = { budget }
    await assert.rejects(loadCourseV1(course, 'bridge-test.course.json', assets), (e: unknown) => {
      assert.ok(isRefusal(e))
      assert.ok(e.message.includes('#/mechanisms/budget'))
      return true
    })
  }
})

for (const id of IDS) {
  test(`world course ${id}`, { timeout: 200_000 }, async () => {
    const { v1, sim, json } = await load(id)
    const path = `courses/${id}.course.json`
    const world = id.split('-')[0]

    // 2. Course shape.
    assert.equal(sim.kind, 'race', `${id} is a race`)
    assert.ok(sim.profiles.includes('sprint'), `${id} allows the sprint profile`)
    assert.ok(sim.profiles.includes('standard'), `${id} allows the standard profile`)
    assert.equal(v1.world, world, `${id} is a ${world} world course`)
    assert.equal(sim.spawns.length, 8, `${id} has 8 spawns`)
    assert.equal(sim.checkpoints.length, 3, `${id} has 3 checkpoints`)
    assert.equal(sim.timeLimitS, 120, `${id} has a 120 s limit`)
    const m = sim.mechanisms
    assert.ok(m, `${id} has mechanisms`)

    // 3. Budget, including the refusal at load.
    const used = usedBudget(m)
    assert.ok(used.dynamicBodies <= m.budget.dynamicBodies,
      `${id} uses ${used.dynamicBodies} dynamic bodies, budget ${m.budget.dynamicBodies}`)
    assert.ok(used.joints <= m.budget.joints, `${id} uses ${used.joints} joints, budget ${m.budget.joints}`)
    assert.deepEqual(m.budget, DEFAULT_BUDGET, `${id} uses the default mechanism budget`)
    const lowered = structuredClone(json)
    const block = lowered.mechanisms as { budget: { dynamicBodies: number; joints: number } }
    block.budget = used.dynamicBodies > 0
      ? { dynamicBodies: used.dynamicBodies - 1, joints: m.budget.joints }
      : { dynamicBodies: m.budget.dynamicBodies, joints: used.joints - 1 }
    await assert.rejects(loadCourseV1(lowered, path, assets), (e: unknown) => {
      assert.ok(isRefusal(e), `${id} lowered budget is refused`)
      assert.ok(e.message.includes('#/mechanisms/budget'), `${id} refusal names #/mechanisms/budget: ${e.message}`)
      return true
    })

    // 4. Mechanisms use and sounds.
    const waits = sim.path.flatMap(n => n.wait === undefined ? [] : [n.wait])
    const pulls = sim.path.flatMap(n => n.pull === undefined ? [] : [n.pull])
    assert.ok(waits.length + pulls.length > 0, `${id} path has a wait or pull node`)
    for (const w of waits) assert.ok(m.signals.includes(w), `${id} wait '${w}' is a mechanism signal`)
    const levers = new Set(m.levers.map(l => l.id))
    for (const p of pulls) assert.ok(levers.has(p), `${id} pull '${p}' is a lever id`)
    assert.ok(m.switches.length + m.levers.length > 0, `${id} has a switch or lever`)
    const sounds = sim.sounds ?? []
    assert.ok(sounds.length > 0, `${id} has sounds`)
    assert.ok(sounds.some(s => s.event !== null || s.signal >= 0), `${id} binds a sound to an event or signal`)

    // 5. Eight bots finish the sprint race.
    const courses = [sim, survival].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    const courseIndex = courses.indexOf(sim)
    const match = createMatchSim(R, {
      seed: 1, playerCount: 8, humans: Array(8).fill(false), profile: 'sprint', courses,
    })
    try {
      const rounds = match.world.ctx.system<RoundSystem>('round')
      const inputs = Array.from({ length: 8 }, () => neutralInput())
      for (let t = 0; t <= PROFILES.sprint.introTicks; t++) match.step(inputs)
      const players = Array.from({ length: 8 }, (_, p) => p)
      rounds.begin(match.world.ctx, { index: 0, kind: 'race', final: false, target: 8 },
        courseIndex, players, players, PROFILES.sprint.timeCapS! * 60 - match.tick)
      const signals = [...new Set([...waits, ...pulls])]
      const seen = new Set<string>()
      // The start-grid showcase must still run on its real mechanisms: the counter's links on
      // neon-piston-alley and a seesaw tilting under the pack on candy-seesaw-run.
      const showcase = id === 'neon-piston-alley'
        ? [['laser-a', 'beams', -2], ['laser-b', 'beams', -2], ['piston-1', 'block', 0.5]] as const
        : id === 'candy-seesaw-run'
          ? [['seesaw-1', 'plank', 0.02]] as const
          : []
      const moved = new Set<string>()
      const current = pose()
      const maxTicks = PROFILES.sprint.introTicks + PROFILES.sprint.timeCapS! * 60 + 2
      while (!rounds.over && match.tick < maxTicks) {
        match.step(inputs)
        for (const s of signals) if (!seen.has(s) && match.signal(s)) seen.add(s)
        for (const [itemId, bodyId, travel] of showcase) {
          if (moved.has(itemId)) continue
          const item = m.items.findIndex(i => i.id === itemId)
          const body = m.items[item].bodies.findIndex(b => b.id === bodyId)
          assert.ok(match.mechanismBodyPose({ item, body }, current))
          const dy = current.t.y - m.items[item].bodies[body].rest.t.y
          if (travel < 0 ? dy < travel : dy > travel) moved.add(itemId)
        }
      }
      assert.ok(rounds.over, `${id} round ends within the sprint cap`)
      const round = rounds.result()
      assert.equal(round.courseIndex, courseIndex)
      assert.equal(round.plan.target, 8)
      assert.equal(round.reason, 'target',
        `${id} race result: ${JSON.stringify({ qualified: round.qualified, target: round.plan.target, seen: [...seen] })}`)
      assert.equal(round.qualified.length, 8, `${id} qualifies all 8 bots`)
      assert.deepEqual([...round.qualified].sort((a, b) => a - b), players, `${id} qualifies every player once`)
      assert.deepEqual(round.eliminated, [], `${id} eliminates none`)
      for (const s of signals) assert.ok(seen.has(s), `${id} signal '${s}' is on during the round`)
      for (const [itemId] of showcase) assert.ok(moved.has(itemId), `${itemId} moves on its real mechanism`)
    } finally {
      match.free()
    }
  })
}
