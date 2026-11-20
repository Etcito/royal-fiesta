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
import { harnessRound, loadEgeCourse, rfScriptBytes } from '../src/egeHarness.ts'
import { createRoundRun } from '../../web/src/engineRound/run.ts'
import type { RoundRunArgs } from '../../web/src/engineRound/run.ts'
import { readRepoText } from '../src/files.ts'

async function roundWith(id: string, specs: FeatureSpec[] | null, sharedEngine?: EngineInstance, humans?: boolean[]): Promise<{
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
    profile: 'sprint', seed: 7, humans: humans ?? [true, false, false, false, false, false, false, false],
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

function collectSpec(spots: [number, number, number][], value: number, regenS: number): FeatureSpec {
  return { id: 'pickup', kind: 'collectible', params: { spots, value, regenS } }
}

const ALL_HUMAN = [true, true, true, true, true, true, true, true]

test('collectible pickup scores its value, hides the spot and regenerates on the exact source tick', async () => {
  // The idle human seat stands with its body centre at feet + stand + 0.01, i.e. y 0.86.
  const engine = await loadEngine()
  engine.setSchema(await readRepoText(RF_EGE_SCHEMA))
  const spec = collectSpec([[-3.5, 0.86, 0]], 7, 0.5)
  const first = await roundWith('ege-strip', [spec], engine)
  const second = await roundWith('ege-strip', [spec], engine)
  try {
    const spot = first.scene.index('feature/pickup/spot/0')
    const seat = first.scene.seatEntities[0]
    const events: ReturnType<typeof decodeEvents> = []
    while (first.round.tick < 60) {
      events.push(...rawStep(first.round, () => code()))
      rawStep(second.round, () => code())
    }
    assert.equal(events.filter((event) => event.kind === 'score').length, 0, 'no pickup during the intro')
    assert.equal(rec(first.round, 'ege.render', spot).visible, 1, 'an untouched spot is visible')
    events.push(...rawStep(first.round, () => code()))
    rawStep(second.round, () => code())
    assert.equal(first.round.tick, 61)
    assert.equal(engine.worldEqual(first.round.world, second.round.world), true)

    const scored = events.filter((event) => event.kind === 'score')
    assert.equal(scored.length, 1, 'one pickup emits one score')
    assert.equal(scored[0].entity, seat)
    assert.deepEqual(
      { seat: scored[0].fields.seat, a: scored[0].fields.a, b: scored[0].fields.b },
      { seat: 0, a: 7, b: 0 },
    )
    const ready = rec(first.round, 'feature_collectible_spot', spot).ready_tick as number
    assert.equal(ready, 90, 'ready tick is the source tick plus round(0.5 s * 60)')
    assert.equal(rec(first.round, 'ege.render', spot).visible, 0, 'a collected spot is hidden during its cooldown')

    for (let i = 0; i < 20; i++) {
      events.push(...rawStep(first.round, () => code(1)))
      rawStep(second.round, () => code(1))
      assert.equal(engine.worldEqual(first.round.world, second.round.world), true, `worlds differ at tick ${first.round.tick}`)
    }
    while (first.round.tick < 90) {
      events.push(...rawStep(first.round, () => code()))
      rawStep(second.round, () => code())
    }
    assert.equal(rec(first.round, 'ege.render', spot).visible, 0, 'still hidden one tick before the ready tick')
    events.push(...rawStep(first.round, () => code()))
    rawStep(second.round, () => code())
    assert.equal(first.round.tick, 91)
    assert.equal(events.filter((event) => event.kind === 'score').length, 1, 'the far seat does not score')
    assert.equal(rec(first.round, 'feature_collectible_spot', spot).ready_tick, 90, 'no pickup keeps the ready tick')
    assert.equal(rec(first.round, 'ege.render', spot).visible, 1, 'the spot is visible again at its ready tick')
    assert.equal(first.round.observe().faults, 0)
    assert.equal(second.round.observe().faults, 0)
  } finally {
    second.round.dispose()
    first.round.dispose()
  }
})

test('a collectible tie goes to the lower room seat', async () => {
  const engine = await loadEngine()
  engine.setSchema(await readRepoText(RF_EGE_SCHEMA))
  // Seats 0 and 1 spawn one metre apart at x -3.5 and -2.5; the spot sits at the midpoint.
  const spec = collectSpec([[-3.0, 0.86, 0]], 3, 1)
  const first = await roundWith('ege-strip', [spec], engine, ALL_HUMAN)
  const second = await roundWith('ege-strip', [spec], engine, ALL_HUMAN)
  try {
    const events: ReturnType<typeof decodeEvents> = []
    while (first.round.tick < 61) {
      events.push(...rawStep(first.round, () => code()))
      rawStep(second.round, () => code())
    }
    const scored = events.filter((event) => event.kind === 'score')
    assert.equal(scored.length, 1)
    assert.equal(scored[0].entity, first.scene.seatEntities[0], 'the equal-distance tie keeps seat 0')
    assert.deepEqual(
      { seat: scored[0].fields.seat, a: scored[0].fields.a, b: scored[0].fields.b },
      { seat: 0, a: 3, b: 0 },
    )
    assert.equal(engine.worldEqual(first.round.world, second.round.world), true)
    assert.equal(first.round.observe().faults, 0)
    assert.equal(second.round.observe().faults, 0)
  } finally {
    second.round.dispose()
    first.round.dispose()
  }
})

test('bank records dynamic debris once and remains deterministic', async () => {
  const engine = await loadEngine()
  engine.setSchema(await readRepoText(RF_EGE_SCHEMA))
  const bank: FeatureSpec = { id: 'bank-demo', kind: 'bank', params: {
    center: [-3.5, 0.35, 0.6], half: [2, 2, 2], team: 1,
  } }
  const first = await roundWith('ege-strip', [CARRY, bank], engine, ALL_HUMAN)
  const second = await roundWith('ege-strip', [CARRY, bank], engine, ALL_HUMAN)
  try {
    const owner = first.scene.index('feature/bank-demo')
    const item = first.scene.index('feature/carry/item/0')
    assert.equal(Object.keys(first.round.worldState().components.feature_bank_inside).length, 0)
    for (let i = 0; i < 5; i++) {
      rawStep(first.round, () => code())
      rawStep(second.round, () => code())
      assert.equal(engine.worldEqual(first.round.world, second.round.world), true)
    }
    const records = Object.values(first.round.worldState().components.feature_bank_inside) as any[]
    assert.equal(records.length, 1)
    assert.deepEqual({ owner: records[0].owner, item: records[0].item, team: records[0].team }, { owner, item, team: 1 })
    assert.equal(first.round.observe().faults, 0)
    assert.equal(second.round.observe().faults, 0)
  } finally {
    second.round.dispose()
    first.round.dispose()
  }
})

test('bank counts all dynamic debris across overlap capacity and excludes other body types', async () => {
  const { course, assets } = await loadEgeCourse('ege-strip')
  const copy = structuredClone(course)
  copy.sim!.features = [{ id: 'bank-demo', kind: 'bank', params: {
    center: [100, 20, 0], half: [10, 5, 5], team: 0,
  } }]
  const engine = await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schema)
  const scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  const doc = JSON.parse(scene.text)
  doc.gravity = [0, 0, 0]
  doc.resources.round.intro_ticks = 0
  const ids: number[] = []
  for (let i = 0; i < 23; i++) {
    ids.push(doc.entities.length)
    const type = i < 20 ? 'dynamic' : ['fixed', 'kinematic_position', 'kinematic_velocity'][i - 20]
    doc.entities.push({
      name: `debris/${i}`,
      components: { 'ege.transform': { pos: [96 + i * 0.35, 20, 0], rot: [0, 0, 0, 1] } },
      body: { type, gravity_scale: 0, can_sleep: true },
      colliders: [{ shape: 'sphere', radius: 0.1, group: 'debris' }],
    })
  }
  const modified = { ...scene, text: JSON.stringify(doc) }
  const setup = { profile: 'sprint' as const, seed: 7, humans: ALL_HUMAN }
  const first = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  const second = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  try {
    const events = rawStep(first, () => code())
    rawStep(second, () => code())
    assert.equal(engine.worldEqual(first.world, second.world), true)
    const records = Object.values(first.worldState().components.feature_bank_inside) as any[]
    assert.deepEqual(records.map((record) => record.item).sort((a, b) => a - b), ids.slice(0, 20))
    assert.equal(events.filter((event) => event.kind === 'team_score' && event.fields.a === 1).length, 20)
    const repeats = rawStep(first, () => code())
    rawStep(second, () => code())
    assert.equal(repeats.filter((event) => event.kind === 'team_score').length, 0)
    for (let i = 0; i < 200; i++) {
      rawStep(first, () => code())
      rawStep(second, () => code())
    }
    assert.equal(Object.keys(first.worldState().components.feature_bank_inside).length, 20)
    assert.equal(engine.worldEqual(first.world, second.world), true)
    assert.equal(first.observe().faults, 0)
    assert.equal(second.observe().faults, 0)
  } finally {
    second.dispose()
    first.dispose()
  }
})

test('bank deposits on entry and withdraws on departure with retained neutral credit', async () => {
  const { course, assets } = await loadEgeCourse('ege-strip')
  const copy = structuredClone(course)
  copy.sim!.features = [{ id: 'bank-demo', kind: 'bank', params: {
    center: [100, 20, 0], half: [2, 2, 2], team: null,
  } }]
  const engine = await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schema)
  const scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  const doc = JSON.parse(scene.text)
  doc.gravity = [0, 0, 0]
  doc.resources.round.intro_ticks = 0
  const item = doc.entities.length
  doc.entities.push({
    components: { 'ege.transform': { pos: [96, 20, 0], rot: [0, 0, 0, 1] } },
    body: { type: 'dynamic', gravity_scale: 0, linvel: [30, 0, 0] },
    colliders: [{ shape: 'sphere', radius: 0.1, group: 'debris' }],
  })
  const modified = { ...scene, text: JSON.stringify(doc) }
  const setup = { profile: 'sprint' as const, seed: 7, humans: ALL_HUMAN }
  const first = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  const second = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  try {
    const events: ReturnType<typeof decodeEvents> = []
    let recordTeam: number | undefined
    for (let i = 0; i < 20; i++) {
      events.push(...rawStep(first, () => code()))
      rawStep(second, () => code())
      assert.equal(engine.worldEqual(first.world, second.world), true)
      const records = Object.values(first.worldState().components.feature_bank_inside) as any[]
      if (records.length) {
        assert.equal(records[0].item, item)
        if (recordTeam === undefined) recordTeam = records[0].team
        assert.equal(records[0].team, recordTeam)
      }
    }
    const scores = events.filter((event) => event.kind === 'team_score')
    assert.deepEqual(scores.map((event) => event.fields.a), [1, -1])
    assert.equal(scores[0].fields.team, recordTeam)
    assert.equal(scores[1].fields.team, recordTeam)
    assert.equal(Object.keys(first.worldState().components.feature_bank_inside).length, 0)
    assert.equal(first.observe().faults, 0)
    assert.equal(second.observe().faults, 0)
  } finally {
    second.dispose()
    first.dispose()
  }
})

test('bank excludes a carried item at the hand and removes its inside record', async () => {
  const bank: FeatureSpec = { id: 'bank-demo', kind: 'bank', params: {
    center: [-3.5, 1, 0.6], half: [2, 2, 2], team: 0,
  } }
  const engine = await loadEngine()
  engine.setSchema(await readRepoText(RF_EGE_SCHEMA))
  const first = await roundWith('ege-strip', [CARRY, bank], engine, ALL_HUMAN)
  const second = await roundWith('ege-strip', [CARRY, bank], engine, ALL_HUMAN)
  try {
    while (first.round.tick < 61) {
      rawStep(first.round, () => code())
      rawStep(second.round, () => code())
    }
    assert.equal(Object.keys(first.round.worldState().components.feature_bank_inside).length, 1)
    const events = rawStep(first.round, () => code(0, true))
    rawStep(second.round, () => code(0, true))
    events.push(...rawStep(first.round, () => code(0, true)))
    rawStep(second.round, () => code(0, true))
    assert.equal(Object.keys(first.round.worldState().components.feature_bank_inside).length, 0)
    assert.equal(events.filter((event) => event.kind === 'team_score' && event.fields.a === -1).length, 1)
    assert.equal(engine.worldEqual(first.round.world, second.round.world), true)
    assert.equal(first.round.observe().faults, 0)
    assert.equal(second.round.observe().faults, 0)
  } finally {
    second.round.dispose()
    first.round.dispose()
  }
})

test('neutral bank breaks equal-distance credit ties by seat id', async () => {
  const { course, assets } = await loadEgeCourse('ege-strip')
  const copy = structuredClone(course)
  copy.sim!.features = [{ id: 'bank-demo', kind: 'bank', params: {
    center: [100, 20, 0], half: [2, 2, 2], team: null,
  } }]
  const engine = await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schema)
  const scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  const doc = JSON.parse(scene.text)
  doc.gravity = [0, 0, 0]
  doc.resources.round.intro_ticks = 0
  for (let i = 0; i < 8; i++) {
    const seat = doc.entities[scene.seatEntities[i]].components.seat
    seat.status = i < 2 ? 1 : 0
    seat.team = i === 0 ? 1 : 0
    seat.spawn_t = [i === 0 ? 99 : 101, 19, 0]
  }
  doc.entities.push({
    components: { 'ege.transform': { pos: [100, 20, 0], rot: [0, 0, 0, 1] } },
    body: { type: 'dynamic', gravity_scale: 0 },
    colliders: [{ shape: 'sphere', radius: 0.1, group: 'debris' }],
  })
  const modified = { ...scene, text: JSON.stringify(doc) }
  const setup = { profile: 'sprint' as const, seed: 7, humans: ALL_HUMAN }
  const first = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  const second = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  try {
    const events = rawStep(first, () => code())
    rawStep(second, () => code())
    const scores = events.filter((event) => event.kind === 'team_score')
    assert.equal(scores.length, 1)
    assert.equal(scores[0].fields.team, 1)
    assert.equal(engine.worldEqual(first.world, second.world), true)
    assert.equal(first.observe().faults, 0)
    assert.equal(second.observe().faults, 0)
  } finally {
    second.dispose()
    first.dispose()
  }
})

function captureSpec(captureS = 0.5): FeatureSpec {
  return { id: 'capture-demo', kind: 'captureZone', params: {
    center: [0, 0.86, 0], half: [5, 2, 2], captureS,
  } }
}

function captureAlive(doc: any, scene: EmittedScene, alive: number[]): void {
  for (let i = 0; i < 8; i++) {
    doc.entities[scene.seatEntities[i]].components.seat.status = alive.includes(i) ? 1 : 0
  }
}

interface CaptureRig { engine: EngineInstance; scene: EmittedScene; first: EngineRound; second: EngineRound }

async function captureRig(
  spec: FeatureSpec,
  edit?: (doc: any, scene: EmittedScene) => void,
): Promise<CaptureRig> {
  const { course, assets } = await loadEgeCourse('ege-strip')
  const copy = structuredClone(course)
  copy.sim!.features = [spec]
  const engine = await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schema)
  const scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  const doc = JSON.parse(scene.text)
  doc.gravity = [0, 0, 0]
  edit?.(doc, scene)
  const modified = { ...scene, text: JSON.stringify(doc) }
  const setup = { profile: 'sprint' as const, seed: 7, humans: ALL_HUMAN }
  const first = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  const second = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  return { engine, scene, first, second }
}

function stepBoth(rig: CaptureRig, events: ReturnType<typeof decodeEvents>): void {
  events.push(...rawStep(rig.first, () => code()))
  rawStep(rig.second, () => code())
}

test('capture needs 30 progress ticks, changes owner at the boundary and scores every 60 owned ticks', async () => {
  const rig = await captureRig(captureSpec(0.5), (doc, scene) => {
    captureAlive(doc, scene, [0, 1])
    // Seat 1 is an alive team 1 seat parked inside the box; the tally must exclude it, so team 0
    // captures alone instead of tying.
    const parked = doc.entities[scene.seatEntities[1]].components
    parked.seat.team = 1
    parked.character.placed = 1
    parked.character.mode = 7
    parked.character.parked = 1
    parked['ege.transform'].pos = [-3, 0.86, 0]
  })
  const root = rig.scene.index('feature/capture-demo')
  const visual = rig.scene.index('feature/capture-demo/visual/0')
  const events: ReturnType<typeof decodeEvents> = []
  try {
    while (rig.first.tick < 60) stepBoth(rig, events)
    assert.equal(rec(rig.first, 'feature_capture_zone', root).progress, 0, 'no progress during the intro')
    assert.equal(rec(rig.first, 'ege.render', visual).color, 0xF2E6D0, 'the unowned zone keeps its base colour')

    stepBoth(rig, events)
    assert.equal(rig.first.tick, 61)
    let zone = rec(rig.first, 'feature_capture_zone', root)
    assert.deepEqual(
      { owner: zone.owner, progress_team: zone.progress_team, progress: zone.progress },
      { owner: -1, progress_team: 0, progress: 1 },
      'the first playing step starts team 0 progress',
    )

    while (rig.first.tick < 89) stepBoth(rig, events)
    zone = rec(rig.first, 'feature_capture_zone', root)
    assert.equal(zone.progress, 29, '29 progress ticks do not capture a 0.5 s zone')
    assert.equal(zone.owner, -1)
    assert.equal(rec(rig.first, 'ege.render', visual).color, 0xF2E6D0, 'progress alone does not tint the zone')

    stepBoth(rig, events)
    assert.equal(rig.first.tick, 90)
    zone = rec(rig.first, 'feature_capture_zone', root)
    assert.deepEqual(
      { owner: zone.owner, progress: zone.progress, owned_ticks: zone.owned_ticks },
      { owner: 0, progress: 0, owned_ticks: 1 },
      'the thirtieth progress tick captures at the boundary',
    )
    assert.equal(rec(rig.first, 'ege.render', visual).color, 0x54BAFF, 'team 0 owns the zone')

    while (rig.first.tick < 149) stepBoth(rig, events)
    const scored = events.filter((event) => event.kind === 'team_score')
    assert.equal(scored.length, 1, 'one score after 60 owned ticks')
    assert.equal(scored[0].entity, root)
    assert.deepEqual(
      { team: scored[0].fields.team, a: scored[0].fields.a, b: scored[0].fields.b },
      { team: 0, a: 1, b: 0 },
    )
    assert.equal(rig.engine.worldEqual(rig.first.world, rig.second.world), true)
    assert.equal(rig.first.observe().faults, 0)
    assert.equal(rig.second.observe().faults, 0)
  } finally {
    rig.second.dispose()
    rig.first.dispose()
  }
})

test('a capture tie holds the retained progress and shows the contested tint', async () => {
  const rig = await captureRig(captureSpec(0.5), (doc, scene) => {
    captureAlive(doc, scene, [0, 1])
    doc.entities[scene.seatEntities[1]].components.seat.team = 1
    const zone = doc.entities[scene.index('feature/capture-demo')].components.feature_capture_zone
    zone.progress_team = 0
    zone.progress = 7
  })
  const root = rig.scene.index('feature/capture-demo')
  const visual = rig.scene.index('feature/capture-demo/visual/0')
  const events: ReturnType<typeof decodeEvents> = []
  try {
    while (rig.first.tick < 100) stepBoth(rig, events)
    const zone = rec(rig.first, 'feature_capture_zone', root)
    assert.deepEqual(
      { owner: zone.owner, progress_team: zone.progress_team, progress: zone.progress },
      { owner: -1, progress_team: 0, progress: 7 },
      'an equal team tie neither advances nor resets the retained progress',
    )
    assert.equal(events.filter((event) => event.kind === 'team_score').length, 0)
    assert.equal(rec(rig.first, 'ege.render', visual).color, 0xFF6B9E, 'a contested zone uses tint 1')
    assert.equal(rig.engine.worldEqual(rig.first.world, rig.second.world), true)
    assert.equal(rig.first.observe().faults, 0)
    assert.equal(rig.second.observe().faults, 0)
  } finally {
    rig.second.dispose()
    rig.first.dispose()
  }
})

test('a new capture leader resets progress carried from another team', async () => {
  const rig = await captureRig(captureSpec(0.5), (doc, scene) => {
    captureAlive(doc, scene, [0])
    const zone = doc.entities[scene.index('feature/capture-demo')].components.feature_capture_zone
    zone.progress_team = 1
    zone.progress = 9
  })
  const root = rig.scene.index('feature/capture-demo')
  try {
    while (rig.first.tick < 60) {
      rawStep(rig.first, () => code())
      rawStep(rig.second, () => code())
    }
    assert.equal(rec(rig.first, 'feature_capture_zone', root).progress, 9, 'progress waits during the intro')
    rawStep(rig.first, () => code())
    rawStep(rig.second, () => code())
    const zone = rec(rig.first, 'feature_capture_zone', root)
    assert.deepEqual(
      { progress_team: zone.progress_team, progress: zone.progress },
      { progress_team: 0, progress: 1 },
      'a different leader restarts progress from zero',
    )
    assert.equal(rig.engine.worldEqual(rig.first.world, rig.second.world), true)
    assert.equal(rig.first.observe().faults, 0)
    assert.equal(rig.second.observe().faults, 0)
  } finally {
    rig.second.dispose()
    rig.first.dispose()
  }
})

function tailSpec(count: 'half' | number, spawn: [number, number, number], immunityS = 1): FeatureSpec {
  return { id: 'tails-demo', kind: 'tailSet', params: { count, spawn, immunityS } }
}

interface TailRig { engine: EngineInstance; scene: EmittedScene; first: EngineRound; second: EngineRound }

async function tailRig(
  spec: FeatureSpec,
  edit?: (doc: any, scene: EmittedScene) => void,
): Promise<TailRig> {
  const { course, assets } = await loadEgeCourse('ege-strip')
  const copy = structuredClone(course)
  copy.sim!.features = [spec]
  const engine = await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schema)
  const scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  const doc = JSON.parse(scene.text)
  doc.gravity = [0, 0, 0]
  edit?.(doc, scene)
  const modified = { ...scene, text: JSON.stringify(doc) }
  const setup = { profile: 'sprint' as const, seed: 7, humans: ALL_HUMAN }
  const first = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  const second = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  return { engine, scene, first, second }
}

function tailSteps(rig: TailRig, n: number, grab: boolean, events?: ReturnType<typeof decodeEvents>): void {
  for (let tick = 0; tick < n; tick++) {
    const records = rawStep(rig.first, () => code(0, grab))
    rawStep(rig.second, () => code(0, grab))
    if (events) events.push(...records)
  }
}

function placeSeatAt(doc: any, scene: EmittedScene, seat: number, t: [number, number, number]): void {
  doc.entities[scene.seatEntities[seat]].components.seat.spawn_t = t
}

function tailSeat(doc: any, scene: EmittedScene, id: string, seat: number): any {
  return doc.entities[scene.index(`feature/${id}/seat/${seat}`)].components.feature_tail_set_seat
}

function tailFeature(doc: any, scene: EmittedScene, id: string): any {
  return doc.entities[scene.index(`feature/${id}`)].components.feature_tail_set
}

test('half the seats receive a tail on the first round tick and the rest stay empty', async () => {
  const rig = await tailRig(tailSpec('half', [20, 0, 20]))
  try {
    tailSteps(rig, 60, false)
    const root = rig.scene.index('feature/tails-demo')
    assert.equal(rec(rig.first, 'feature_tail_set', root).assigned, 0, 'no assignment during the intro')
    tailSteps(rig, 1, false)
    const feature = rec(rig.first, 'feature_tail_set', root)
    assert.deepEqual(
      { assigned: feature.assigned, count: feature.count, free_tails: feature.free_tails },
      { assigned: 1, count: -1, free_tails: 0 },
    )
    let holders = 0
    for (let seat = 0; seat < 8; seat++) {
      const state = rec(rig.first, 'feature_tail_set_seat', rig.scene.index(`feature/tails-demo/seat/${seat}`))
      const ch = rec(rig.first, 'character', rig.scene.seatEntities[seat])
      const visual = rec(rig.first, 'ege.render', rig.scene.index(`feature/tails-demo/seat/${seat}`))
      assert.equal(state.has_tail === 1 ? 1 : 0, visual.visible, `seat ${seat} visual follows its tail`)
      if (state.has_tail !== 1) {
        assert.equal(ch.carry, 0, `seat ${seat} holds nothing`)
        continue
      }
      holders++
      assert.equal(ch.carry, 3, `seat ${seat} carries the tail kind`)
      assert.equal(ch.carry_id, 0)
    }
    assert.equal(holders, 4, 'floor(8 / 2) seats hold a tail')
    assert.equal(rig.engine.worldEqual(rig.first.world, rig.second.world), true)
    assert.equal(rig.first.observe().faults, 0)
    assert.equal(rig.second.observe().faults, 0)
  } finally {
    rig.second.dispose()
    rig.first.dispose()
  }
})

test('a valid grab transfers one tail with exact possess payloads', async () => {
  const rig = await tailRig(tailSpec('half', [50, 50, 50]), (doc, scene) => {
    placeSeatAt(doc, scene, 0, [0, 0, 0])
    placeSeatAt(doc, scene, 1, [0.5, 0, 0])
    for (let seat = 2; seat < 8; seat++) placeSeatAt(doc, scene, seat, [10 + seat, 0, 0])
    tailFeature(doc, scene, 'tails-demo').assigned = 1
    tailSeat(doc, scene, 'tails-demo', 0).has_tail = 1
    const holder = doc.entities[scene.seatEntities[0]].components.character
    holder.carry = 3
    holder.carry_id = 0
  })
  const events: ReturnType<typeof decodeEvents> = []
  try {
    tailSteps(rig, 60, false)
    tailSteps(rig, 1, true, events)
    assert.equal(rig.first.tick, 61)
    const moved = events.filter((event) => event.kind === 'possess')
    assert.equal(moved.length, 2, 'one holder loses and one grabber gains')
    const lost = moved.find((event) => event.fields.seat === 0)
    const gained = moved.find((event) => event.fields.seat === 1)
    assert.ok(lost && gained, 'both seat possess events are present')
    assert.deepEqual({ a: lost.fields.a, b: lost.fields.b }, { a: 0, b: 0 })
    assert.deepEqual({ a: gained.fields.a, b: gained.fields.b }, { a: 1, b: 0 })
    assert.equal(lost.entity, rig.scene.seatEntities[0])
    assert.equal(gained.entity, rig.scene.seatEntities[1])

    const from = rec(rig.first, 'feature_tail_set_seat', rig.scene.index('feature/tails-demo/seat/0'))
    const to = rec(rig.first, 'feature_tail_set_seat', rig.scene.index('feature/tails-demo/seat/1'))
    assert.deepEqual({ has_tail: from.has_tail, immune_until: from.immune_until }, { has_tail: 0, immune_until: 0 })
    assert.deepEqual({ has_tail: to.has_tail, immune_until: to.immune_until }, { has_tail: 1, immune_until: 120 })
    const loser = rec(rig.first, 'character', rig.scene.seatEntities[0])
    const winner = rec(rig.first, 'character', rig.scene.seatEntities[1])
    assert.deepEqual({ carry: loser.carry, carry_id: loser.carry_id }, { carry: 0, carry_id: -1 })
    assert.deepEqual({ carry: winner.carry, carry_id: winner.carry_id }, { carry: 3, carry_id: 0 })
    assert.equal(rig.engine.worldEqual(rig.first.world, rig.second.world), true)
    assert.equal(rig.first.observe().faults, 0)
    assert.equal(rig.second.observe().faults, 0)
  } finally {
    rig.second.dispose()
    rig.first.dispose()
  }
})

test('the gatherer immunity blocks an early repeat grab', async () => {
  const rig = await tailRig(tailSpec('half', [50, 50, 50], 1), (doc, scene) => {
    placeSeatAt(doc, scene, 0, [0, 0, 0])
    placeSeatAt(doc, scene, 1, [0.5, 0, 0])
    for (let seat = 2; seat < 8; seat++) placeSeatAt(doc, scene, seat, [10 + seat, 0, 0])
    tailFeature(doc, scene, 'tails-demo').assigned = 1
    tailSeat(doc, scene, 'tails-demo', 0).has_tail = 1
  })
  const events: ReturnType<typeof decodeEvents> = []
  try {
    tailSteps(rig, 60, false)
    tailSteps(rig, 1, true, events)
    assert.equal(events.filter((event) => event.kind === 'possess').length, 2, 'the first grab transfers the tail')
    // Release for one tick, then press again while seat 1 is still immune.
    tailSteps(rig, 1, false)
    tailSteps(rig, 1, true, events)
    assert.equal(rig.first.tick, 63)
    assert.equal(events.filter((event) => event.kind === 'possess').length, 2, 'an immune holder is not stolen back')
    const holder = rec(rig.first, 'feature_tail_set_seat', rig.scene.index('feature/tails-demo/seat/1'))
    assert.equal(holder.has_tail, 1, 'seat 1 keeps the tail through the immunity window')
    assert.equal(rec(rig.first, 'feature_tail_set_seat', rig.scene.index('feature/tails-demo/seat/0')).has_tail, 0)
    assert.equal(rig.engine.worldEqual(rig.first.world, rig.second.world), true)
    assert.equal(rig.first.observe().faults, 0)
    assert.equal(rig.second.observe().faults, 0)
  } finally {
    rig.second.dispose()
    rig.first.dispose()
  }
})

test('a dead holder frees its tail and a nearby grabber restores possession', async () => {
  const rig = await tailRig(tailSpec('half', [0.5, 0.9, 0]), (doc, scene) => {
    placeSeatAt(doc, scene, 0, [0, 0, 0])
    placeSeatAt(doc, scene, 1, [0.5, 0, 0])
    for (let seat = 2; seat < 8; seat++) placeSeatAt(doc, scene, seat, [10 + seat, 0, 0])
    const feature = tailFeature(doc, scene, 'tails-demo')
    feature.assigned = 1
    // The free pile sits at the picker's own feet so the spawn range covers it.
    const stand = doc.entities[scene.seatEntities[1]].components.character.stand
    feature.spawn = [0.5, stand + 0.01, 0]
    tailSeat(doc, scene, 'tails-demo', 0).has_tail = 1
    const dead = doc.entities[scene.seatEntities[0]].components
    dead.seat.status = 0
    dead.character.carry = 3
    dead.character.carry_id = 0
    const picker = doc.entities[scene.seatEntities[1]].components.character
    picker.carry = 0
    picker.carry_id = -1
  })
  const events: ReturnType<typeof decodeEvents> = []
  try {
    tailSteps(rig, 60, false)
    const root = rig.scene.index('feature/tails-demo')
    assert.equal(rec(rig.first, 'feature_tail_set', root).free_tails, 1, 'the death dropped the tail to the pile')
    const dead = rec(rig.first, 'feature_tail_set_seat', rig.scene.index('feature/tails-demo/seat/0'))
    assert.equal(dead.has_tail, 0)
    assert.equal(rec(rig.first, 'character', rig.scene.seatEntities[0]).carry, 0)

    tailSteps(rig, 1, false)
    assert.equal(rec(rig.first, 'feature_tail_set', root).free_tails, 1, 'the free tail waits for a grabber')
    tailSteps(rig, 1, true, events)
    assert.equal(rec(rig.first, 'feature_tail_set', root).free_tails, 0, 'the pickup empties the pile')
    const picked = rec(rig.first, 'feature_tail_set_seat', rig.scene.index('feature/tails-demo/seat/1'))
    assert.equal(picked.has_tail, 1, 'the nearby seat now holds the tail')
    assert.equal(rec(rig.first, 'character', rig.scene.seatEntities[1]).carry, 3)
    const gains = events.filter((event) => event.kind === 'possess' && event.fields.seat === 1)
    assert.equal(gains.length, 1)
    assert.deepEqual({ a: gains[0].fields.a, b: gains[0].fields.b }, { a: 1, b: 0 })
    assert.equal(rig.engine.worldEqual(rig.first.world, rig.second.world), true)
    assert.equal(rig.first.observe().faults, 0)
    assert.equal(rig.second.observe().faults, 0)
  } finally {
    rig.second.dispose()
    rig.first.dispose()
  }
})

function crownSpec(t: [number, number, number], grabRangeM = 1): FeatureSpec {
  return { id: 'crown-demo', kind: 'crown', params: { t, grabRangeM } }
}

interface CrownRig { engine: EngineInstance; scene: EmittedScene; first: EngineRound; second: EngineRound }

async function crownRig(
  spec: FeatureSpec,
  edit?: (doc: any, scene: EmittedScene) => void,
): Promise<CrownRig> {
  const { course, assets } = await loadEgeCourse('ege-strip')
  const copy = structuredClone(course)
  copy.sim!.features = [spec]
  const engine = await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schema)
  const scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  const doc = JSON.parse(scene.text)
  doc.gravity = [0, 0, 0]
  edit?.(doc, scene)
  const modified = { ...scene, text: JSON.stringify(doc) }
  const setup = { profile: 'sprint' as const, seed: 7, humans: ALL_HUMAN }
  const first = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  const second = await createEngineRound(engine, schema, await rfScriptBytes(), modified, copy, setup)
  return { engine, scene, first, second }
}

function crownDoc(doc: any, scene: EmittedScene, id: string): any {
  return doc.entities[scene.index(`feature/${id}`)].components.feature_crown
}

function crownSeatDoc(doc: any, scene: EmittedScene, id: string, seat: number): any {
  return doc.entities[scene.index(`feature/${id}/seat/${seat}`)].components.feature_crown_seat
}

function crownSteps(rig: CrownRig, n: number, grab: boolean, events?: ReturnType<typeof decodeEvents>): void {
  for (let tick = 0; tick < n; tick++) {
    const records = rawStep(rig.first, () => code(0, grab))
    rawStep(rig.second, () => code(0, grab))
    if (events) events.push(...records)
  }
}

test('a grab within range emits the crown with sub-tick 0 and the taken tint', async () => {
  // Seat 0 stands with its body centre at feet + stand + 0.01 = 0.86; the crown sits there too.
  const rig = await crownRig(crownSpec([-3.5, 0.86, 0]), doc => {
    doc.resources.round.intro_ticks = 0
  })
  const root = rig.scene.index('feature/crown-demo')
  const visual = rig.scene.index('feature/crown-demo/visual/0')
  const events: ReturnType<typeof decodeEvents> = []
  try {
    assert.equal(rec(rig.first, 'ege.render', visual).color, 0xFFD140, 'an untaken crown keeps the tower base colour')
    crownSteps(rig, 1, true, events)
    const crowns = events.filter((event) => event.kind === 'crown')
    assert.equal(crowns.length, 1, 'the first post-step crossing reports the grab')
    assert.equal(crowns[0].entity, rig.scene.seatEntities[0], 'the crown event belongs to the seat entity')
    assert.deepEqual(
      { seat: crowns[0].fields.seat, a: crowns[0].fields.a, b: crowns[0].fields.b },
      { seat: 0, a: 0, b: 0 },
      'the initialised previous distance keeps the sub-tick at 0',
    )
    assert.equal(rec(rig.first, 'feature_crown', root).taken, 1)
    assert.equal(rec(rig.first, 'ege.render', visual).color, 0x73D966, 'the taken crown shows tint 4')
    assert.equal(rig.engine.worldEqual(rig.first.world, rig.second.world), true)
    assert.equal(rig.first.observe().faults, 0)
    assert.equal(rig.second.observe().faults, 0)
  } finally {
    rig.second.dispose()
    rig.first.dispose()
  }
})

test('simultaneous contenders retain both crown events on the first grab tick', async () => {
  // Seats 0 and 1 spawn at x -3.5 and -2.5; the crown sits halfway at x -3.0, so both are inside
  // the one metre grab range on the same tick.
  const rig = await crownRig(crownSpec([-3.0, 0.86, 0]), doc => {
    doc.resources.round.intro_ticks = 0
  })
  const root = rig.scene.index('feature/crown-demo')
  const events: ReturnType<typeof decodeEvents> = []
  try {
    crownSteps(rig, 1, true, events)
    const crowns = events.filter((event) => event.kind === 'crown')
    assert.equal(crowns.length, 2, 'both contenders are reported before taken flips')
    const bySeat = new Map(crowns.map((event) => [event.fields.seat, event]))
    assert.equal(bySeat.get(0)!.entity, rig.scene.seatEntities[0])
    assert.equal(bySeat.get(1)!.entity, rig.scene.seatEntities[1])
    for (const seat of [0, 1]) {
      assert.deepEqual({ a: bySeat.get(seat)!.fields.a, b: bySeat.get(seat)!.fields.b }, { a: 0, b: 0 })
    }
    assert.equal(rec(rig.first, 'feature_crown', root).taken, 1)
    assert.equal(rig.engine.worldEqual(rig.first.world, rig.second.world), true)
    assert.equal(rig.first.observe().faults, 0)
    assert.equal(rig.second.observe().faults, 0)
  } finally {
    rig.second.dispose()
    rig.first.dispose()
  }
})

test('an out-of-range or protected grab does not emit the crown', async () => {
  const far = await crownRig(crownSpec([50, 0.86, 50]), doc => {
    doc.resources.round.intro_ticks = 0
  })
  const farEvents: ReturnType<typeof decodeEvents> = []
  try {
    crownSteps(far, 3, true, farEvents)
    assert.equal(farEvents.filter((event) => event.kind === 'crown').length, 0, 'a far crown is not grabbable')
    assert.equal(rec(far.first, 'feature_crown', far.scene.index('feature/crown-demo')).taken, 0)
    assert.equal(far.engine.worldEqual(far.first.world, far.second.world), true)
    assert.equal(far.first.observe().faults, 0)
    assert.equal(far.second.observe().faults, 0)
  } finally {
    far.second.dispose()
    far.first.dispose()
  }

  const guarded = await crownRig(crownSpec([-3.5, 0.86, 0]), (doc, scene) => {
    doc.resources.round.intro_ticks = 0
    doc.entities[scene.seatEntities[0]].components.character.protected_until = 10000
  })
  const guardedEvents: ReturnType<typeof decodeEvents> = []
  try {
    crownSteps(guarded, 3, true, guardedEvents)
    assert.equal(guardedEvents.filter((event) => event.kind === 'crown').length, 0, 'a protected seat cannot grab')
    assert.equal(rec(guarded.first, 'feature_crown', guarded.scene.index('feature/crown-demo')).taken, 0)
    assert.equal(guarded.engine.worldEqual(guarded.first.world, guarded.second.world), true)
    assert.equal(guarded.first.observe().faults, 0)
    assert.equal(guarded.second.observe().faults, 0)
  } finally {
    guarded.second.dispose()
    guarded.first.dispose()
  }
})

test('the crossing sub-tick interpolates the previous distance inside the grab range', async () => {
  // With range 1, previous distance 2 and current distance 0.5, the source maps the crossed share
  // round(65535 * (2 - 1) / (2 - 0.5)) = round(65535 * 2 / 3) = 43690.
  const rig = await crownRig(crownSpec([0, 5.86 - 1 / 180, 0]), (doc, scene) => {
    doc.resources.round.intro_ticks = 0
    for (let seat = 1; seat < 8; seat++) {
      doc.entities[scene.seatEntities[seat]].components.seat.spawn_t = [100 + seat, 0, 0]
    }
    const holder = doc.entities[scene.seatEntities[0]].components
    holder.character.placed = 1
    holder['ege.transform'].pos = [0, 5.86, 0.5]
    const crown = crownDoc(doc, scene, 'crown-demo')
    crown.placed = 1
    crown.next_reset_tick = 100000
    crownSeatDoc(doc, scene, 'crown-demo', 0).prev_dist = 2
  })
  const events: ReturnType<typeof decodeEvents> = []
  try {
    crownSteps(rig, 1, true, events)
    const crowns = events.filter((event) => event.kind === 'crown')
    assert.equal(crowns.length, 1)
    assert.equal(crowns[0].fields.a, 43690, 'the hand-derived crossing sub-tick')
    assert.equal(crowns[0].fields.b, 0)
    assert.equal(rig.engine.worldEqual(rig.first.world, rig.second.world), true)
    assert.equal(rig.first.observe().faults, 0)
    assert.equal(rig.second.observe().faults, 0)
  } finally {
    rig.second.dispose()
    rig.first.dispose()
  }
})

test('the cap reset returns every alive seat to the CP1 respawn slots on the source tick', async () => {
  // CP1 respawn is [0, 0, 15] facing +Z, slots 8 at 1.2 m apart. Slot 0 is (1.8, 0, 16.2) and
  // slot 7 is (-1.8, 0, 15). With intro 0 and a three-tick cap the reset runs at pre-step tick 3.
  const rig = await crownRig(crownSpec([100, 0.86, 0]), doc => {
    doc.resources.round.intro_ticks = 0
    doc.resources.round.round_ticks = 3
    doc.resources.round.overtime_ticks = 0
  })
  const root = rig.scene.index('feature/crown-demo')
  const seat0State = rig.scene.index('feature/crown-demo/seat/0')
  const seat7State = rig.scene.index('feature/crown-demo/seat/7')
  const events: ReturnType<typeof decodeEvents> = []
  try {
    crownSteps(rig, 3, false, events)
    assert.equal(rig.first.tick, 3)
    near(rec(rig.first, 'feature_crown_seat', seat0State).prev_dist, 103.5, 1e-3,
      'before the cap the previous distance still points from the spawn')
    assert.equal(events.filter((event) => event.kind === 'crown').length, 0)
    crownSteps(rig, 1, false, events)
    assert.equal(rig.first.tick, 4)
    near(rec(rig.first, 'feature_crown_seat', seat0State).prev_dist, Math.hypot(98.2, 0.86, 16.2), 1e-3,
      'seat 0 resets through the first source slot')
    near(rec(rig.first, 'feature_crown_seat', seat7State).prev_dist, Math.hypot(101.8, 0.86, 15), 1e-3,
      'seat 7 resets through the eighth source slot')
    const at = rec(rig.first, 'ege.transform', rig.scene.seatEntities[0])
    near(at.pos[0], 1.8, 1e-3, 'seat 0 slot x')
    near(at.pos[1], 0.86, 0.02, 'seat 0 slot stand')
    near(at.pos[2], 16.2, 1e-3, 'seat 0 slot z')
    assert.equal(rec(rig.first, 'feature_crown', root).next_reset_tick, 603)
    assert.equal(rig.engine.worldEqual(rig.first.world, rig.second.world), true)
    assert.equal(rig.first.observe().faults, 0)
    assert.equal(rig.second.observe().faults, 0)
  } finally {
    rig.second.dispose()
    rig.first.dispose()
  }
})

test('ege-yard-c runs every objective kind with faults 0 and identical worlds for identical codes', async () => {
  const engine = await loadEngine()
  engine.setSchema(await readRepoText(RF_EGE_SCHEMA))
  const first = await roundWith('ege-yard-c', null, engine, ALL_HUMAN)
  const second = await roundWith('ege-yard-c', null, engine, ALL_HUMAN)
  try {
    const features = Object.values(first.round.worldState().components.feature) as any[]
    const kinds = features.map((record) => record.kind as number).sort((a, b) => a - b)
    // ranks: carryItem 7, ball 14, goal 15 x2, collectible 16, bank 17 x2, captureZone 18, tailSet 19, crown 20
    assert.deepEqual(kinds, [7, 14, 15, 15, 16, 17, 17, 18, 19, 20])
    for (let tick = 0; tick < 200; tick++) {
      const c = code(tick % 90 < 45 ? 1 : 0, tick % 40 < 5)
      rawStep(first.round, () => c)
      rawStep(second.round, () => c)
      if (tick % 20 === 0) assert.equal(engine.worldEqual(first.round.world, second.round.world), true, `tick ${tick}`)
    }
    assert.equal(engine.worldEqual(first.round.world, second.round.world), true)
    assert.equal(first.round.observe().faults, 0)
    assert.equal(second.round.observe().faults, 0)
  } finally {
    second.round.dispose()
    first.round.dispose()
  }
})

// The authored approach of s1-q-crown-confection, flattened to the [x, z] waypoints the page's
// runPath follows. The crown sits at [289, 13, 72]; capturing at 2280 puts every penguin on the
// final climb a few metres short of it while the crown is still on its tower.
const CROWN_APPROACH: [number, number][] = [
  [29.2, 72], [45, 72], [51, 72], [59, 63.6], [71, 51], [91, 30], [125, 33.5],
  [156, 30], [187, 26.5], [220, 30], [240, 51], [258, 70], [263, 72], [276, 72], [289, 72],
]

// The M6 Honeycomb waypoints, reused unchanged by the M7 survival demo row.
const SURVIVAL_PATH: [number, number][] = [
  [-14.289, 8.25], [0, 16.5], [14.289, 8.25], [14.289, -8.25], [9.526, -19.25], [4.763, 2.75],
]

test('the crown capture arguments keep the crown on its tower with penguins on the climbing approach', async () => {
  const args: RoundRunArgs = {
    course: 's1-q-crown-confection', profile: 'sprint', seed: 7, frames: 2280, local: 'run',
    captureAt: 'end', focus: 'kind:crown', runPath: CROWN_APPROACH,
  }
  const { scene, course, round } = await harnessRound('s1-q-crown-confection')
  const run = createRoundRun(round, args, course)
  try {
    while (run.step()) {}
    const facts = run.facts()
    assert.equal(facts.tick, 2280)
    assert.equal(facts.phase, 'playing')
    assert.equal(facts.faults, 0)
    assert.equal(facts.features.crown, 1)
    assert.deepEqual(facts.focus, { kind: 'crown', id: 'crown-1', moved: false, changed: 0 })
    assert.equal(facts.upright, true)
    near(facts.local.pos[0], 277.65, 0.6, 'followed seat approach x')
    near(facts.local.pos[1], 12.85, 0.05, 'followed seat approach y')
    near(facts.local.pos[2], 71.98, 0.6, 'followed seat approach z')
    const seats = round.observe().seats
    for (let seat = 0; seat < seats.length; seat++) {
      assert.ok(seats[seat].pos.x >= 277 && seats[seat].pos.x <= 291, `seat ${seat} on the climbing approach`)
      near(seats[seat].pos.y, 12.85, 0.05, `seat ${seat} approach height`)
    }
    const crown = rec(round, 'feature_crown', scene.index('feature/crown-1'))
    assert.equal(crown.taken, 0, 'the crown remains on its tower')
    near(crown.t[0], 289, 1e-3, 'crown tower x')
    near(crown.t[1], 13, 1e-3, 'crown tower y')
    near(crown.t[2], 72, 1e-3, 'crown tower z')
  } finally {
    round.dispose()
  }
})

test('the survival capture arguments keep the playing phase with the followed seat on remaining hex floor', async () => {
  const args: RoundRunArgs = {
    course: 's1-i-honeycomb-heights', profile: 'sprint', seed: 7, frames: 900, local: 'run',
    captureAt: 'end', focus: null, runPath: SURVIVAL_PATH,
  }
  const { course, round } = await harnessRound('s1-i-honeycomb-heights')
  const run = createRoundRun(round, args, course)
  try {
    while (run.step()) {}
    const facts = run.facts()
    assert.equal(facts.tick, 900)
    assert.equal(facts.phase, 'playing', 'the survival round is still playing')
    assert.equal(facts.faults, 0)
    assert.ok(facts.botsMoved >= 4, `botsMoved ${facts.botsMoved}`)
    assert.equal(facts.upright, true)
    assert.equal(facts.features.hexField, 1)
    assert.equal(facts.local.mode, 0, 'the followed penguin stands on a floor disc')
    assert.equal(facts.local.status, 1)
    near(facts.local.pos[0], 4.767, 0.6, 'followed seat hex x')
    near(facts.local.pos[1], 1.019, 0.05, 'followed seat hex floor height')
    near(facts.local.pos[2], 2.747, 0.6, 'followed seat hex z')
    assert.equal(round.observe().alive, 8)
  } finally {
    round.dispose()
  }
})
