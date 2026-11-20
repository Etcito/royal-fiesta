import assert from 'node:assert/strict'
import test from 'node:test'
import type { EngineInstance } from '@etcito/game-engine/loader'
import { loadEngine } from '@etcito/game-engine'
import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { encodeInput } from '@royal-fiesta/sim/input'
import { createEngineRound } from '@royal-fiesta/game/ege/round'
import type { EngineRound } from '@royal-fiesta/game/ege/round'
import { emitEngineScene } from '@royal-fiesta/game/ege/sceneEmitter'
import type { EmittedScene } from '@royal-fiesta/game/ege/sceneEmitter'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import type { CourseV1 } from '@royal-fiesta/game/courseV1'
import { decodeEvents } from '@etcito/game-engine/world-state'
import { engineCodeOfS1 } from '@royal-fiesta/game/ege/inputCodes'
import { loadEgeCourse, rfScriptBytes } from '../src/egeHarness.ts'
import { readRepoText } from '../src/files.ts'

async function roundWith(id: string, specs: FeatureSpec[] | null, sharedEngine?: EngineInstance): Promise<{
  engine: EngineInstance; scene: EmittedScene; course: CourseV1; round: EngineRound
}> {
  const { course, assets } = await loadEgeCourse(id)
  const copy = structuredClone(course)
  if (specs !== null) copy.sim!.features = specs
  const engine = sharedEngine ?? await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  if (!sharedEngine) engine.setSchema(schema)
  const scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  const round = await createEngineRound(engine, schema, await rfScriptBytes(), scene, copy, {
    profile: 'sprint', seed: 7, humans: [true, false, false, false, false, false, false, false],
  })
  return { engine, scene, course: copy, round }
}

async function roundWithEdit(specs: FeatureSpec[], edit: (course: CourseV1) => void): Promise<{
  engine: EngineInstance; scene: EmittedScene; course: CourseV1; round: EngineRound
}> {
  const { course, assets } = await loadEgeCourse('ege-strip')
  const copy = structuredClone(course)
  copy.sim!.features = specs
  edit(copy)
  const engine = await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schema)
  const scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  const round = await createEngineRound(engine, schema, await rfScriptBytes(), scene, copy, {
    profile: 'sprint', seed: 7, humans: [true, false, false, false, false, false, false, false],
  })
  return { engine, scene, course: copy, round }
}

function rec(round: EngineRound, component: string, entity: number): any {
  return round.worldState().components[component][String(entity)]
}

function code(moveZ = 0, grab = false): number {
  return encodeInput({ moveX: 0, moveZ, jump: false, dive: false, grab })
}

function near(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

const CARRY: FeatureSpec = {
  id: 'carry', kind: 'carryItem', params: {
    asset: 'candy.floor-disc',
    spawns: [[-3.5, 0.35, 0.6]],
    resetS: 8,
    homes: [],
  },
}

test('carry item mass comes from the density-one sphere and a grab rides at the hand', async () => {
  const { scene, round } = await roundWith('ege-strip', [CARRY])
  try {
    const item = scene.index('feature/carry/item/0')
    const seat = scene.seatEntities[0]
    round.step(() => code())
    const expected = 4 / 3 * Math.PI * 0.35 * 0.35 * 0.35
    near(rec(round, 'ege.body_props', item).additional_mass, expected, 1e-5, 'density-one sphere mass')
    assert.equal(rec(round, 'feature_carry_item', scene.index('feature/carry')).placed, 1)
    while (round.tick < 61) round.step(() => code())
    round.step(() => code(0, true))
    assert.equal(rec(round, 'feature_carry_item_item', item).holder, 0)
    const ch = rec(round, 'character', seat)
    assert.equal(ch.carry, 1)
    assert.equal(ch.carry_id, 0)

    round.step(() => code(0, true))
    const at = rec(round, 'ege.transform', seat)
    const carried = rec(round, 'ege.transform', item)
    near(carried.pos[0], at.pos[0] + ch.facing[0] * 0.55, 0.03, 'carry hand x')
    near(carried.pos[1], at.pos[1] + 0.25, 0.03, 'carry hand y')
    near(carried.pos[2], at.pos[2] + ch.facing[1] * 0.55, 0.03, 'carry hand z')
    near(rec(round, 'feature_carry_item_item', item).last_hand[0], at.pos[0] + ch.facing[0] * 0.55, 0.03, 'stored hand x')
    assert.equal(round.observe().faults, 0)
  } finally {
    round.dispose()
  }
})

test('carry keeps one item per seat, releases with the seat velocity and resets on its timer', async () => {
  const spec: FeatureSpec = {
    ...CARRY,
    params: { ...CARRY.params, spawns: [[-3.5, 0.35, 0.6], [-3.5, 0.35, -0.6]], resetS: 0.5 },
  }
  const { scene, round } = await roundWith('ege-strip', [spec])
  try {
    const first = scene.index('feature/carry/item/0')
    const second = scene.index('feature/carry/item/1')
    const seat = scene.seatEntities[0]
    while (round.tick < 61) round.step(() => code())
    round.step(() => code(0, true))
    const holders = [rec(round, 'feature_carry_item_item', first).holder, rec(round, 'feature_carry_item_item', second).holder]
    assert.equal(holders.filter((holder) => holder >= 0).length, 1, 'exactly one item is carried')
    const held = holders[0] >= 0 ? first : second
    const free = held === first ? second : first
    assert.equal(rec(round, 'feature_carry_item_item', free).holder, -1)
    assert.equal(rec(round, 'character', seat).carry_id, held === first ? 0 : 1)

    for (let tick = 0; tick < 10; tick++) round.step(() => code(1, true))
    round.step(() => code(1, false))
    const releasedAt = round.tick
    assert.equal(rec(round, 'feature_carry_item_item', held).holder, -1)
    assert.equal(rec(round, 'character', seat).carry, 0)
    const ch = rec(round, 'character', seat)
    const itemVelocity = rec(round, 'ege.velocity', held).lin as number[]
    const seatVelocity = rec(round, 'ege.velocity', seat).lin as number[]
    near(itemVelocity[0], seatVelocity[0], 1.5, 'release velocity x')
    near(itemVelocity[2], seatVelocity[2], 1.5, 'release velocity z')
    assert.ok(Math.hypot(itemVelocity[0], itemVelocity[2]) > 0.5, 'released item keeps the seat velocity')
    assert.equal(ch.carry_id, -1)

    while (round.tick < releasedAt + 40) round.step(() => code(1))
    const spawn = rec(round, 'feature_carry_item_item', held).spawn as number[]
    const at = rec(round, 'ege.transform', held)
    near(at.pos[0], spawn[0], 0.2, 'reset spawn x')
    near(at.pos[2], spawn[2], 0.2, 'reset spawn z')
    const rest = rec(round, 'ege.velocity', held).lin as number[]
    near(rest[0], 0, 0.1, 'reset horizontal velocity')
    near(rest[2], 0, 0.1, 'reset horizontal velocity')
    assert.equal(round.observe().faults, 0)
  } finally {
    round.dispose()
  }
})

test('carry drops at the last hand when its holder falls', async () => {
  const { scene, round } = await roundWithEdit([CARRY], course => {
    course.sim!.obstacles = []
    course.sim!.level!.respawn.mode = 'none'
  })
  try {
    const item = scene.index('feature/carry/item/0')
    const seat = scene.seatEntities[0]
    while (round.tick < 61) round.step(() => code())
    round.step(() => code(0, true))
    assert.equal(rec(round, 'feature_carry_item_item', item).holder, 0, 'the falling seat grabbed the item first')
    let dropped = false
    while (round.tick < 300 && !dropped) {
      round.step(() => code(0, true))
      assert.equal(round.observe().faults, 0)
      dropped = rec(round, 'feature_carry_item_item', item).holder < 0
    }
    assert.ok(dropped, `the item was still held at tick ${round.tick}`)
    const droppedItem = rec(round, 'feature_carry_item_item', item)
    assert.equal(rec(round, 'character', seat).carry, 0)
    assert.ok(droppedItem.last_hand[1] < -1, `dropped at hand height ${droppedItem.last_hand[1]}`)
    assert.ok(rec(round, 'ege.transform', item).pos[1] <= droppedItem.last_hand[1] + 0.05,
      'the released item falls from the last hand')
    assert.equal(round.observe().faults, 0)
  } finally {
    round.dispose()
  }
})

test('carry refuses an opposing protected home and two worlds stay equal', async () => {
  const spec: FeatureSpec = {
    ...CARRY,
    params: {
      ...CARRY.params,
      spawns: [[-3.5, 0.35, 0.6], [-3.5, 0.35, -0.6]],
      resetS: 0.5,
      homes: [{ center: [-3.5, 0.35, 0.6], half: [1, 1, 1], team: 1 }],
    },
  }
  const engine = await loadEngine()
  engine.setSchema(await readRepoText(RF_EGE_SCHEMA))
  const first = await roundWith('ege-strip', [spec], engine)
  const second = await roundWith('ege-strip', [spec], engine)
  try {
    const protectedItem = first.scene.index('feature/carry/item/0')
    const freeItem = first.scene.index('feature/carry/item/1')
    while (first.round.tick < 61) {
      first.round.step(() => code())
      second.round.step(() => code())
    }
    assert.equal(engine.worldEqual(first.round.world, second.round.world), true)
    first.round.step(() => code(0, true))
    second.round.step(() => code(0, true))
    assert.equal(rec(first.round, 'feature_carry_item_item', protectedItem).holder, -1, 'opposing home protects its item')
    assert.equal(rec(first.round, 'feature_carry_item_item', freeItem).holder, 0)
    for (let tick = 0; tick < 90; tick++) {
      first.round.step(() => code(1, true))
      second.round.step(() => code(1, true))
      assert.equal(engine.worldEqual(first.round.world, second.round.world), true, `worlds differ at tick ${first.round.tick}`)
    }
    assert.equal(first.round.observe().faults, 0)
    assert.equal(second.round.observe().faults, 0)
  } finally {
    second.round.dispose()
    first.round.dispose()
  }
})

function ballSpec(spawn: [number, number, number], resetS = 30): FeatureSpec {
  return { id: 'ball', kind: 'ball', params: { spawn, radius: 0.3, mass: 1, resetS } }
}

function goalSpec(team: number, center: [number, number, number], half: [number, number, number]): FeatureSpec {
  return { id: 'goal', kind: 'goal', params: { team, center, half } }
}

function homeLevel(course: CourseV1): void {
  course.sim!.level!.homes = [
    {
      team: 0,
      box: { center: { x: 10, y: 0.5, z: 10 }, half: { x: 1, y: 0.5, z: 1 } },
      respawn: [{ t: { x: 10, y: 0, z: 10 }, facing: { x: 0, z: 1 } }],
    },
    {
      team: 1,
      box: { center: { x: -10, y: 0.5, z: 10 }, half: { x: 1, y: 0.5, z: 1 } },
      respawn: [{ t: { x: -10, y: 0, z: 10 }, facing: { x: 0, z: 1 } }],
    },
  ]
  course.sim!.level!.respawn.spacingM = 0
}

function rawStep(round: EngineRound, codeFor: () => number): ReturnType<typeof decodeEvents> {
  const engineCode = engineCodeOfS1(codeFor())
  const codes = new Array<number>(8).fill(engineCode)
  const before = round.tick
  round.host.stepTick(round.world, codes)
  return decodeEvents(round.engine.events(round.world, before, round.tick).records, round.layout)
}

test('a character push rolls the ball and two worlds stay equal', async () => {
  const engine = await loadEngine()
  engine.setSchema(await readRepoText(RF_EGE_SCHEMA))
  // The sprint intro drops the ball onto the character capsule; the contact gives it the
  // horizontal velocity that the first playing steps carry forward.
  const specs = [ballSpec([-3.5, 10.85, 0.6])]
  const first = await roundWith('ege-strip', specs, engine)
  const second = await roundWith('ege-strip', specs, engine)
  try {
    const ball = first.scene.index('feature/ball')
    const spawn = rec(first.round, 'feature_ball', ball).spawn as number[]
    while (first.round.tick < 61) {
      first.round.step(() => code())
      second.round.step(() => code())
    }
    assert.equal(engine.worldEqual(first.round.world, second.round.world), true)
    for (let tick = 0; tick < 20; tick++) {
      first.round.step(() => code(1))
      second.round.step(() => code(1))
      assert.equal(engine.worldEqual(first.round.world, second.round.world), true, `worlds differ at tick ${first.round.tick}`)
    }
    const at = rec(first.round, 'ege.transform', ball)
    near(at.pos[0], spawn[0], 0.35, 'push keeps the ball in its lane')
    assert.ok(at.pos[2] > spawn[2] + 1, `pushed ball z ${at.pos[2]} from ${spawn[2]}`)
    assert.equal(first.round.observe().faults, 0)
    assert.equal(second.round.observe().faults, 0)
  } finally {
    second.round.dispose()
    first.round.dispose()
  }
})

test('goal scores 1 minus the defending team once, resets at the source tick and returns alive seats home', async () => {
  // The ball rests on the character's head at y 2.0; a half height of 0.05 only holds it
  // because the goal does not shrink Y by the radius.
  const specs = [ballSpec([-3.5, 2.2, 0]), goalSpec(1, [-3.5, 2.0, 0], [1, 0.05, 1])]
  const { scene, round } = await roundWithEdit(specs, homeLevel)
  try {
    const ball = scene.index('feature/ball')
    const seat = scene.seatEntities[0]
    const spawn = rec(round, 'feature_ball', ball).spawn as number[]
    const events: ReturnType<typeof decodeEvents> = []
    while (round.tick < 61) events.push(...rawStep(round, () => code()))
    assert.equal(round.worldState().resources.round.phase, 1)
    const scored = events.filter((event) => event.kind === 'team_score')
    assert.equal(scored.length, 1, 'one goal emits one team_score')
    assert.equal(scored[0].entity, ball)
    assert.deepEqual(
      { team: scored[0].fields.team, a: scored[0].fields.a, b: scored[0].fields.b },
      { team: 0, a: 1, b: 0 },
    )
    const pending = rec(round, 'feature_ball', ball).pending as number
    assert.equal(pending, 60 + 180, 'pending is the source tick plus 180')

    const repeats: ReturnType<typeof decodeEvents> = []
    for (let tick = 0; tick < 5; tick++) repeats.push(...rawStep(round, () => code()))
    assert.equal(repeats.filter((event) => event.kind === 'team_score').length, 0, 'a pending goal does not score again')
    assert.equal(rec(round, 'feature_ball', ball).pending, pending)
    near(round.poses([ball])[1], 2.0, 0.05, 'the pending ball is still inside the goal')

    for (let tick = 0; tick < 30; tick++) rawStep(round, () => code(1))
    const pushed = rec(round, 'ege.transform', ball)
    assert.ok(pushed.pos[2] < spawn[2] - 0.3 || pushed.pos[1] < spawn[1] - 0.3, `ball left its spawn (${pushed.pos})`)

    while (round.tick < pending) rawStep(round, () => code())
    assert.equal(round.poses([ball])[1] < spawn[1] - 1, true, 'the ball is away just before the reset tick')
    rawStep(round, () => code())
    assert.equal(round.tick, pending + 1)
    assert.equal(rec(round, 'feature_ball', ball).pending, -1, 'the pending score clears on the source reset tick')
    // Body poses set in the post step reach the physics port on the following step.
    rawStep(round, () => code())
    const poses = round.poses([ball, seat])
    near(poses[0], spawn[0], 1e-4, 'reset spawn x')
    near(poses[1], spawn[1], 0.01, 'reset spawn y')
    near(poses[2], spawn[2], 1e-4, 'reset spawn z')
    const ch = rec(round, 'character', seat)
    near(poses[23], 10, 1e-3, 'alive seat home x')
    near(poses[24], ch.stand + 0.01, 0.2, 'alive seat home stand')
    near(poses[25], 10, 1e-3, 'alive seat home z')
    assert.equal(round.module.faultCount, 0)
  } finally {
    round.dispose()
  }
})

test('a goal shrinks X and Z by the ball radius and rejects a ball the unshrunk box would hold', async () => {
  const specs = [ballSpec([-3.5, 2.2, 0]), goalSpec(0, [-3.5, 2.0, 0], [0.2, 1, 1])]
  const { scene, round } = await roundWithEdit(specs, homeLevel)
  try {
    const ball = scene.index('feature/ball')
    while (round.tick < 181) round.step(() => code())
    assert.equal(round.observe().events.team_score, 0, 'the shrunk goal box rejects the ball')
    assert.equal(rec(round, 'feature_ball', ball).pending, -1)
    assert.equal(round.observe().faults, 0)
  } finally {
    round.dispose()
  }
})
