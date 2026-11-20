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
import { loadEgeCourse, rfScriptBytes } from '../src/egeHarness.ts'
import { readRepoText } from '../src/files.ts'

async function roundWith(id: string, specs: FeatureSpec[] | null, humans = [true, false, false, false, false, false, false, false]): Promise<{
  engine: EngineInstance; scene: EmittedScene; course: CourseV1; round: EngineRound
}> {
  const { course, assets } = await loadEgeCourse(id)
  const copy = structuredClone(course)
  if (specs !== null) copy.sim!.features = specs
  const engine = await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schema)
  const scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  const round = await createEngineRound(engine, schema, await rfScriptBytes(), scene, copy, {
    profile: 'sprint', seed: 7, humans,
  })
  return { engine, scene, course: copy, round }
}

function rec(round: EngineRound, component: string, entity: number): any {
  return round.worldState().components[component][String(entity)]
}

function code(): number {
  return encodeInput({ moveX: 0, moveZ: 0, jump: false, dive: false, grab: false })
}

function near(actual: number, expected: number): void {
  assert.ok(Math.abs(actual - expected) <= 1e-6, `${actual} != ${expected}`)
}

test('hexField places ring one and layers, then warns and falls under a standing seat', async () => {
  const origin = [-3.5, -0.04, 0]
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'hex',
    kind: 'hexField',
    params: {
      origin, layers: 2, layerSpacingM: 0.5, rings: 1, flatM: 2, pointM: 2,
      thickM: 0.1, warnS: 0.5, decayS: 0.5, scaleWithEntrants: false,
    },
  }])
  try {
    const root = scene.index('feature/hex')
    const rootX = origin[0]
    const rootY = origin[1]
    const rootZ = origin[2]
    const root3 = Math.sqrt(3)
    const layout = [
      [0, 0],
      [-root3, 1],
      [0, 2],
      [root3, 1],
      [root3, -1],
      [0, -2],
      [-root3, -1],
    ]
    round.step(() => code())
    assert.equal(round.observe().faults, 0)
    assert.equal(rec(round, 'feature_hex_field', root).placed, 1)
    for (let index = 0; index < layout.length; index++) {
      const transform = rec(round, 'ege.transform', scene.index(`feature/hex/hex/${index}`))
      near(transform.pos[0], rootX + layout[index][0])
      near(transform.pos[1], rootY)
      near(transform.pos[2], rootZ + layout[index][1])
    }
    for (let index = 7; index < 14; index++) {
      const transform = rec(round, 'ege.transform', scene.index(`feature/hex/hex/${index}`))
      near(transform.pos[1], rootY - 0.5)
    }

    const hexEntity = scene.index('feature/hex/hex/0')
    const neighbour = scene.index('feature/hex/hex/1')
    const states: number[] = [rec(round, 'feature_hex_field_hex', hexEntity).state]
    let warningTicks = 0
    let warningColor = 0
    let groundedOnHex = false
    let fallingDisabled = false
    let fallingY = rootY
    while (round.tick < 600 && rec(round, 'feature_hex_field_hex', hexEntity).state !== 3) {
      round.step(() => code())
      assert.equal(round.observe().faults, 0)
      const hex = rec(round, 'feature_hex_field_hex', hexEntity)
      if (hex.state !== states[states.length - 1]) states.push(hex.state)
      if (hex.state === 1) {
        warningTicks++
        warningColor = rec(round, 'ege.render', hexEntity).color
      }
      if (hex.state === 2) {
        if (rec(round, 'ege.body_props', hexEntity).colliders_enabled === 0) fallingDisabled = true
        fallingY = Math.min(fallingY, rec(round, 'ege.transform', hexEntity).pos[1])
      }
      for (const seat of round.observe().seats) {
        const ch = rec(round, 'character', seat.entity)
        if (ch.grounded !== 0 && ch.ground_entity === hexEntity) groundedOnHex = true
      }
    }
    assert.deepEqual(states, [0, 1, 2, 3])
    assert.ok(groundedOnHex, 'a seat stood on the hex before it warned')
    assert.equal(warningTicks, 30)
    assert.equal(warningColor, 0xFF6B9E)
    assert.ok(fallingDisabled, 'falling disables the collider')
    assert.ok(fallingY < rootY - 0.1, `falling displaced the hex to ${fallingY}`)
    assert.equal(rec(round, 'ege.render', hexEntity).visible, 0)
    assert.equal(rec(round, 'ege.body_props', hexEntity).colliders_enabled, 0)
    assert.equal(rec(round, 'feature_hex_field_hex', neighbour).state, 0)
    assert.equal(rec(round, 'ege.body_props', neighbour).colliders_enabled, 1)
  } finally {
    round.dispose()
  }
})

function closeTo(actual: number, expected: number, tolerance: number, label: string): void {
  assert.ok(Math.abs(actual - expected) <= tolerance, `${label}: ${actual} != ${expected}`)
}

test('annulus writes first-step collider and render half sizes and its query edges', async () => {
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'ring',
    kind: 'annulus',
    params: { center: [-3.5, 0.1, -3], innerM: 2, outerM: 4, thickM: 0.4, speedDegS: 0, segments: 6 },
  }])
  try {
    const root = scene.index('feature/ring')
    const segment = scene.index('feature/ring/segment/0')
    round.step(() => code())
    assert.equal(round.observe().faults, 0)
    assert.equal(rec(round, 'feature_annulus', root).placed, 1)
    const half = rec(round, 'ege.box_collider', segment).half_extents as number[]
    closeTo(half[0], 1.52, 1e-5, 'collider half x')
    closeTo(half[1], 0.2, 1e-5, 'collider half y')
    closeTo(half[2], 1, 1e-5, 'collider half z')
    const render = rec(round, 'ege.render', segment)
    closeTo(render.params[0], half[0], 1e-6, 'render half x')
    closeTo(render.params[1], half[1], 1e-6, 'render half y')
    closeTo(render.params[2], half[2], 1e-6, 'render half z')
    assert.equal(render.color, 0xF5D0E0)
    assert.equal(render.visible, 1)

    round.step(() => code())
    assert.equal(round.observe().faults, 0)
    const obs = round.observe()
    for (const seat of [0, 1]) {
      const ch = rec(round, 'character', obs.seats[seat].entity)
      assert.equal(ch.grounded, 1, `seat ${seat} grounded`)
      assert.equal(ch.ground_entity, segment, `seat ${seat} stands on segment 0`)
    }
    const outside = rec(round, 'character', obs.seats[2].entity)
    assert.notEqual(outside.ground_entity, segment, 'seat 2 is past the tangential half extent')

    const ids = [0, 1, 2, 3, 4, 5].map(index => scene.index(`feature/ring/segment/${index}`))
    for (let tick = 0; tick < 5; tick++) round.step(() => code())
    const state = round.worldState().components.feature_annulus_segment
    assert.deepEqual(Object.keys(state).map(Number).sort((a, b) => a - b), ids)
  } finally {
    round.dispose()
  }
})

test('annulus rotates at speedDegS and carries a grounded seat', async () => {
  const speedDegS = 30
  const rad = speedDegS * Math.PI / 180
  const intro = 60
  const theta0 = rad * (0 - intro) / 60
  const mid = 3
  const center = [-3.5 - mid * Math.sin(theta0), 0.1, 0 - mid * Math.cos(theta0)]
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'ring',
    kind: 'annulus',
    params: { center, innerM: 2, outerM: 4, thickM: 0.4, speedDegS, segments: 6 },
  }])
  try {
    const root = scene.index('feature/ring')
    const segment = scene.index('feature/ring/segment/0')
    round.step(() => code())
    assert.equal(round.observe().faults, 0)
    let transform = rec(round, 'ege.transform', segment)
    closeTo(transform.rot[1], Math.sin(theta0 / 2), 1e-5, 'rot y at tick 0')
    closeTo(transform.rot[3], Math.cos(theta0 / 2), 1e-5, 'rot w at tick 0')
    closeTo(transform.pos[0], center[0] + mid * Math.sin(theta0), 1e-4, 'pos x at tick 0')
    closeTo(transform.pos[2], center[2] + mid * Math.cos(theta0), 1e-4, 'pos z at tick 0')

    for (let tick = 0; tick < 3; tick++) round.step(() => code())
    assert.equal(round.observe().faults, 0)
    const seat0 = round.observe().seats[0]
    const ch = rec(round, 'character', seat0.entity)
    assert.equal(ch.grounded, 1, 'the carried seat stays grounded')
    assert.equal(ch.ground_entity, segment)
    transform = rec(round, 'ege.transform', seat0.entity)
    const velocity = rec(round, 'ege.velocity', seat0.entity).lin as number[]
    closeTo(velocity[0], rad * (transform.pos[2] - center[2]), 0.4, 'carried tangential x')

    while (round.tick < 90) round.step(() => code())
    const at = rec(round, 'ege.transform', segment)
    const theta = rad * (89 - intro) / 60
    closeTo(at.rot[1], Math.sin(theta / 2), 1e-4, 'rot y at tick 89')
    closeTo(at.rot[3], Math.cos(theta / 2), 1e-4, 'rot w at tick 89')
    closeTo(at.pos[0], center[0] + mid * Math.sin(theta), 1e-4, 'pos x at tick 89')
    closeTo(at.pos[2], center[2] + mid * Math.cos(theta), 1e-4, 'pos z at tick 89')
    assert.equal(rec(round, 'feature_annulus', root).overtime_ticks, 0)
  } finally {
    round.dispose()
  }
})

test('sweep moves its fixed pool through laser, bars and block phases', async () => {
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'sweep', kind: 'sweep',
    params: {
      center: [-0.5, -3.9, 0], lengthM: 10, telegraphS: 0.1,
      pattern: 'laser', heightM: 0.5, gapM: 2, speedDegS: 90, speedMps: 4,
      phases: [
        { atS: 0 },
        { atS: 1, pattern: 'bars', gapM: 2 },
        { atS: 2, pattern: 'block', heightM: 4, gapM: 2 },
        { atS: 5, pattern: 'laser' },
      ],
    },
  }])
  try {
    const root = scene.index('feature/sweep')
    const ids = [0, 1].map(index => scene.index(`feature/sweep/part/${index}`))
    const advance = (target: number): void => {
      while (round.tick < target) round.step(() => code())
      assert.equal(round.observe().faults, 0)
      assert.deepEqual(Object.keys(round.worldState().components.feature_sweep_part).map(Number).sort((a, b) => a - b), ids)
      for (const id of ids) {
        const part = rec(round, 'feature_sweep_part', id)
        const half = rec(round, 'ege.box_collider', id).half_extents as number[]
        const render = rec(round, 'ege.render', id)
        for (let axis = 0; axis < 3; axis++) {
          closeTo(half[axis], part.half[axis], 1e-6, 'part collider')
          closeTo(render.params[axis], half[axis], 1e-6, 'render collider')
        }
      }
    }
    advance(1)
    assert.equal(rec(round, 'feature_sweep', root).placed, 1)
    assert.equal(rec(round, 'ege.body_props', ids[0]).colliders_enabled, 0)
    assert.equal(rec(round, 'ege.render', ids[1]).visible, 0)
    advance(67)
    assert.equal(rec(round, 'feature_sweep', root).live, 1)
    assert.equal(rec(round, 'ege.body_props', ids[0]).colliders_enabled, 1)
    assert.equal(rec(round, 'ege.body_props', ids[1]).colliders_enabled, 0)
    advance(97)
    const laser = rec(round, 'feature_sweep', root)
    closeTo(laser.cos, Math.cos(Math.PI / 4), 1e-5, 'rotation cos')
    closeTo(laser.sin, Math.sin(Math.PI / 4), 1e-5, 'rotation sin')
    closeTo(rec(round, 'ege.transform', ids[0]).rot[1], Math.sin(Math.PI / 8), 1e-5, 'rotation quaternion')
    advance(121)
    assert.equal(rec(round, 'feature_sweep', root).active, 1)
    assert.equal(rec(round, 'feature_sweep', root).live, 0)
    assert.equal(rec(round, 'ege.render', ids[1]).visible, 1)
    assert.equal(rec(round, 'ege.body_props', ids[1]).colliders_enabled, 0)
    advance(127)
    assert.equal(rec(round, 'ege.body_props', ids[1]).colliders_enabled, 1)
    advance(181)
    assert.equal(rec(round, 'feature_sweep', root).active, 2)
    for (const id of ids) {
      const half = rec(round, 'feature_sweep_part', id).half as number[]
      assert.deepEqual(half, [2, 2, 0.05])
    }
    advance(217)
    closeTo(rec(round, 'feature_sweep', root).slide, 2, 1e-6, 'block outward slide')
    advance(307)
    closeTo(rec(round, 'feature_sweep', root).slide, 2, 1e-6, 'block returning slide')
    advance(361)
    assert.equal(rec(round, 'feature_sweep', root).active, 3)
    assert.equal(rec(round, 'ege.render', ids[1]).visible, 0)
    assert.equal(rec(round, 'ege.body_props', ids[1]).colliders_enabled, 0)
  } finally {
    round.dispose()
  }
})

test('sweep block transition applies the new collider boundary to physics', async () => {
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'wall', kind: 'sweep',
    params: {
      center: [-2.1, -3.9, 0], lengthM: 10, telegraphS: 0,
      pattern: 'laser', heightM: 0.5, gapM: 2, speedDegS: 0, speedMps: 0,
      phases: [{ atS: 0 }, { atS: 0.05, pattern: 'block', heightM: 4, speedMps: 0 }],
    },
  }])
  try {
    const part = scene.index('feature/wall/part/0')
    // The post knock lifts the seat off the block; observe the first grounded step after the transition.
    while (round.tick < 66) round.step(() => code())
    assert.equal(round.observe().faults, 0)
    const seat = round.observe().seats[0].entity
    assert.equal(rec(round, 'character', seat).ground_entity, part)
    assert.notEqual(rec(round, 'character', round.observe().seats[2].entity).ground_entity, part)
  } finally {
    round.dispose()
  }
})

test('laser-only sweep keeps one part and deterministic state', async () => {
  const { engine, scene, course, round: a } = await roundWith('ege-strip', [{
    id: 'laser', kind: 'sweep',
    params: {
      center: [0, 2, 0], lengthM: 10, telegraphS: 0,
      pattern: 'laser', heightM: 0.5, gapM: 2, speedDegS: 90, speedMps: 0,
      phases: [{ atS: 0 }],
    },
  }])
  let b: EngineRound | undefined
  try {
    b = await createEngineRound(engine, await readRepoText(RF_EGE_SCHEMA), await rfScriptBytes(), scene, course, {
      profile: 'sprint', seed: 7, humans: [true, false, false, false, false, false, false, false],
    })
    const root = scene.index('feature/laser')
    const part = scene.index('feature/laser/part/0')
    for (let i = 0; i < 90; i++) {
      a.step(() => code())
      b.step(() => code())
      assert.deepEqual(Object.keys(a.worldState().components.feature_sweep_part).map(Number), [part])
      if (i === 60) assert.equal(rec(a, 'feature_sweep', root).live, 0)
      if (i === 61) assert.equal(rec(a, 'feature_sweep', root).live, 1)
    }
    assert.equal(a.observe().faults, 0)
    assert.equal(b.observe().faults, 0)
    assert.equal(engine.worldEqual(a.world, b.world), true)
  } finally {
    b?.dispose()
    a.dispose()
  }
})

async function roundWithEdit(specs: FeatureSpec[] | null, edit: (course: any) => void): Promise<{
  engine: EngineInstance; scene: EmittedScene; course: CourseV1; round: EngineRound
}> {
  const { course, assets } = await loadEgeCourse('ege-strip')
  const copy = structuredClone(course)
  if (specs !== null) copy.sim!.features = specs
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

function inputX(moveX: number): number {
  return encodeInput({ moveX, moveZ: 0, jump: false, dive: false, grab: false })
}

test('sweep knocks a respawned seat after protection and spares it while protected', async () => {
  const { scene, round } = await roundWithEdit([{
    id: 'knock', kind: 'sweep',
    params: {
      center: [-8.5, 0.35, 0], lengthM: 10, telegraphS: 1,
      pattern: 'laser', heightM: 0.5, gapM: 2, speedDegS: 0, speedMps: 0,
      phases: [{ atS: 0 }],
    },
  }], course => {
    course.sim.level.respawn.protectTicks = 300
    course.sim.level.respawn.slots = 1
    course.sim.level.respawn.spacingM = 0
  })
  try {
    const seatEntity = round.observe().seats[0].entity
    let fell = false
    while (round.tick < 400 && !fell) {
      round.step(seat => seat === 0 ? inputX(-1) : code())
      assert.equal(round.observe().faults, 0)
      fell = rec(round, 'character', seatEntity).parked === 1
    }
    assert.ok(fell, `seat 0 did not fall by tick ${round.tick}`)
    while (round.tick < 600 && rec(round, 'seat', seatEntity).wait_until >= 0) {
      round.step(() => code())
      assert.equal(round.observe().faults, 0)
    }
    assert.equal(rec(round, 'feature_sweep', scene.index('feature/knock')).live, 1)
    const protectUntil = rec(round, 'seat', seatEntity).protect_until as number
    assert.ok(protectUntil > round.tick, `respawned seat is protected until ${protectUntil} at ${round.tick}`)
    while (round.tick < protectUntil - 2) {
      round.step(() => code())
      assert.equal(round.observe().faults, 0)
      assert.equal(rec(round, 'character', seatEntity).knockbacks, 0)
    }
    while (round.tick < protectUntil + 60 && rec(round, 'character', seatEntity).knockbacks === 0) {
      round.step(() => code())
      assert.equal(round.observe().faults, 0)
    }
    assert.equal(rec(round, 'character', seatEntity).knockbacks, 1)
    assert.equal(rec(round, 'character', seatEntity).mode, 4)
    round.step(() => code())
    const velocity = rec(round, 'ege.velocity', seatEntity).lin as number[]
    closeTo(Math.hypot(velocity[0], velocity[2]), 8, 0.5, 'knock horizontal')
    assert.ok(velocity[1] > 3 && velocity[1] <= 4.1, `knock vertical ${velocity[1]}`)
  } finally {
    round.dispose()
  }
})

test('survival laser eliminates the seat it hits', async () => {
  const { scene, round } = await roundWithEdit([{
    id: 'lethal', kind: 'sweep',
    params: {
      center: [-8.5, 0.35, 0], lengthM: 10, telegraphS: 0.1,
      pattern: 'laser', heightM: 0.5, gapM: 2, speedDegS: 0, speedMps: 0,
      phases: [{ atS: 0 }],
    },
  }], course => {
    course.kind = 'survival'
    course.sim.level.kind = 'survival'
    course.sim.level.finalRule = null
    course.sim.level.respawn.mode = 'none'
  })
  try {
    const seatEntity = round.observe().seats[0].entity
    let eliminated = false
    while (round.tick < 200 && !eliminated) {
      round.step(() => code())
      assert.equal(round.observe().faults, 0)
      eliminated = round.observe().seats[0].status === 3
    }
    assert.ok(eliminated, `seat 0 not eliminated by tick ${round.tick}`)
    assert.ok(round.observe().eliminated >= 1)
    assert.equal(rec(round, 'character', seatEntity).parked, 1)
    assert.equal(rec(round, 'feature_sweep', scene.index('feature/lethal')).live, 1)
  } finally {
    round.dispose()
  }
})

const MASK64 = (1n << 64n) - 1n
const GAMMA = 0x9E3779B97F4A7C15n

// Engine splitmix64 stream of crates/ege-core/src/rng.rs, seeded like World::rng_next.
function mix64(z: bigint): bigint {
  let h = (z ^ (z >> 30n)) & MASK64
  h = (h * 0xBF58476D1CE4E5B9n) & MASK64
  h = (h ^ (h >> 27n)) & MASK64
  h = (h * 0x94D049BB133111EBn) & MASK64
  return (h ^ (h >> 31n)) & MASK64
}

function expectedCycles(seed: number, salt: number, count: number, cycles: number, symbols: number): {
  cells: number[]; target: number
}[] {
  let state = mix64((BigInt(seed) + (BigInt(salt) + 1n) * GAMMA) & MASK64)
  const next = (): number => {
    state = (state + GAMMA) & MASK64
    return Number((mix64(state) >> 32n) & 0xFFFFFFFFn)
  }
  const out: { cells: number[]; target: number }[] = []
  for (let c = 0; c < cycles; c++) {
    const cells: number[] = []
    for (let i = 0; i < count; i++) cells.push(next() % symbols)
    out.push({ cells, target: next() % symbols })
  }
  return out
}

function cycleSymbol(cell: any, cycle: number): number {
  return cycle < 16 ? cell.cycle_symbols[cycle] : cell.cycle_symbols_tail[cycle - 16]
}

function memoryParams(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    origin: [0, 0.1, -6], cols: 4, rows: 4, cellM: 2, symbols: 4, cycles: 20,
    revealS: 0.1, hideS: 0.1, choiceS: 0.2, penaltyS: 14, ...overrides,
  }
}

test('memoryTiles places cells at cellM half sizes, first-step collision and marker poses', async () => {
  const origin = [-3.5, 0.1, 0]
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'memory-demo', kind: 'memoryTiles',
    params: memoryParams({ origin, cols: 4, rows: 4 }),
  }])
  try {
    const root = scene.index('feature/memory-demo')
    round.step(() => code())
    round.step(() => code())
    assert.equal(round.observe().faults, 0)
    assert.equal(rec(round, 'feature_memory_tiles', root).placed, 1)
    for (let index = 0; index < 16; index++) {
      const column = index % 4
      const row = Math.floor(index / 4)
      const entity = scene.index(`feature/memory-demo/cell/${index}`)
      const t = rec(round, 'ege.transform', entity).pos as number[]
      near(t[0], origin[0] + column * 2)
      near(t[1], origin[1])
      near(t[2], origin[2] + row * 2)
      const cell = rec(round, 'feature_memory_tiles_cell', entity)
      assert.deepEqual(cell.t, [origin[0] + column * 2, origin[1], origin[2] + row * 2])
      for (let axis = 0; axis < 3; axis++) closeTo(cell.half[axis], [0.95, 0.2, 0.95][axis], 1e-6, 'cell half')
      const collider = rec(round, 'ege.box_collider', entity).half_extents as number[]
      const render = rec(round, 'ege.render', entity)
      for (let axis = 0; axis < 3; axis++) {
        closeTo(collider[axis], [0.95, 0.2, 0.95][axis], 1e-6, 'collider half')
        closeTo(render.params[axis], collider[axis], 1e-6, 'render half')
      }
      assert.equal(render.visible, 1)
      assert.equal(render.color, 0xF5D0E0)
      assert.equal(rec(round, 'ege.body_props', entity).colliders_enabled, 1)
      assert.equal(cell.state, 0)
    }
    const obs = round.observe()
    assert.equal(rec(round, 'character', obs.seats[0].entity).ground_entity, scene.index('feature/memory-demo/cell/0'))
    assert.equal(rec(round, 'character', obs.seats[2].entity).ground_entity, scene.index('feature/memory-demo/cell/1'))

    const marker = scene.index('feature/memory-demo/marker/0')
    const at = rec(round, 'ege.transform', marker).pos as number[]
    near(at[0], origin[0])
    near(at[1], origin[1] + 0.2 + 0.3)
    near(at[2], origin[2])
    const markerRender = rec(round, 'ege.render', marker)
    closeTo(markerRender.params[0], 1, 1e-6, 'marker radius')
    closeTo(markerRender.params[1], 0.05, 1e-6, 'marker half height')
    assert.equal(markerRender.params[2], 0)
    assert.equal(markerRender.visible, 0)
    const far = rec(round, 'ege.transform', scene.index('feature/memory-demo/marker/16')).pos as number[]
    near(far[0], origin[0] + 3)
    near(far[1], origin[1] + 0.3)
    near(far[2], origin[2] + 6 + 1 + 0.5)
  } finally {
    round.dispose()
  }
})

test('memoryTiles writes the deterministic twenty-cycle source sequence into both split arrays', async () => {
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'memory-full', kind: 'memoryTiles', params: memoryParams({ origin: [0, 0.1, -6] }),
  }])
  try {
    round.step(() => code())
    assert.equal(round.observe().faults, 0)
    const expected = expectedCycles(7, 256, 16, 20, 4)
    for (let cycle = 0; cycle < 20; cycle++) {
      const target = rec(round, 'feature_memory_tiles_cycle', scene.index(`feature/memory-full/cycle/${cycle}`)).target
      assert.equal(target, expected[cycle].target, `cycle ${cycle} target`)
      for (let index = 0; index < 16; index++) {
        const cell = rec(round, 'feature_memory_tiles_cell', scene.index(`feature/memory-full/cell/${index}`))
        assert.equal(cycleSymbol(cell, cycle), expected[cycle].cells[index], `cycle ${cycle} cell ${index}`)
        assert.ok(cycleSymbol(cell, cycle) >= 0 && cycleSymbol(cell, cycle) < 4, 'symbol in range')
      }
    }
    const first = rec(round, 'feature_memory_tiles_cell', scene.index('feature/memory-full/cell/0'))
    assert.equal(first.cycle_symbols.length, 16)
    assert.equal(first.cycle_symbols_tail.length, 4)
    assert.deepEqual(first.cycle_symbols, expected.slice(0, 16).map(cycle => cycle.cells[0]))
    assert.deepEqual(first.cycle_symbols_tail, expected.slice(16, 20).map(cycle => cycle.cells[0]))
    assert.equal(first.cycle_symbols[15], expected[15].cells[0], 'cycle 15 stays in the first array')
    assert.equal(first.cycle_symbols_tail[0], expected[16].cells[0], 'cycle 16 starts the tail')
    assert.equal(first.cycle_symbols_tail[3], expected[19].cells[0], 'cycle 19 ends the tail')
  } finally {
    round.dispose()
  }
})

test('memoryTiles leaves the unused cycle slots zero for a shorter configuration', async () => {
  const { scene, round } = await roundWith('ege-strip', [{
    id: 'memory-short', kind: 'memoryTiles',
    params: memoryParams({ origin: [0, 0.1, -6], cols: 2, rows: 2, symbols: 3, cycles: 3 }),
  }])
  try {
    round.step(() => code())
    assert.equal(round.observe().faults, 0)
    const expected = expectedCycles(7, 256, 4, 3, 3)
    const cells = round.worldState().components.feature_memory_tiles_cycle
    assert.equal(Object.keys(cells).length, 3)
    for (let index = 0; index < 4; index++) {
      const cell = rec(round, 'feature_memory_tiles_cell', scene.index(`feature/memory-short/cell/${index}`))
      assert.deepEqual(cell.cycle_symbols.slice(0, 3), expected.map(cycle => cycle.cells[index]))
      assert.deepEqual(cell.cycle_symbols.slice(3), Array(13).fill(0))
      assert.deepEqual(cell.cycle_symbols_tail, [0, 0, 0, 0])
    }
    for (let cycle = 0; cycle < 3; cycle++) {
      const target = rec(round, 'feature_memory_tiles_cycle', scene.index(`feature/memory-short/cycle/${cycle}`)).target
      assert.equal(target, expected[cycle].target)
    }
  } finally {
    round.dispose()
  }
})

test('memoryTiles keeps its generated symbols across repeated pre runs and two worlds stay equal', async () => {
  const { engine, scene, course, round: a } = await roundWith('ege-strip', [{
    id: 'memory-stable', kind: 'memoryTiles', params: memoryParams({ origin: [0, 0.1, -6] }),
  }])
  let b: EngineRound | undefined
  const symbols = (round: EngineRound): number[] => {
    const out: number[] = []
    for (let cycle = 0; cycle < 20; cycle++) {
      out.push(rec(round, 'feature_memory_tiles_cycle', scene.index(`feature/memory-stable/cycle/${cycle}`)).target)
      for (let index = 0; index < 16; index++) {
        const cell = rec(round, 'feature_memory_tiles_cell', scene.index(`feature/memory-stable/cell/${index}`))
        out.push(cycleSymbol(cell, cycle))
      }
    }
    return out
  }
  try {
    b = await createEngineRound(engine, await readRepoText(RF_EGE_SCHEMA), await rfScriptBytes(), scene, course, {
      profile: 'sprint', seed: 7, humans: [true, false, false, false, false, false, false, false],
    })
    a.step(() => code())
    b.step(() => code())
    const first = symbols(a)
    assert.equal(a.observe().faults, 0)
    assert.equal(b.observe().faults, 0)
    for (let tick = 0; tick < 130; tick++) {
      a.step(() => code())
      b.step(() => code())
    }
    assert.equal(a.observe().faults, 0)
    assert.equal(b.observe().faults, 0)
    assert.deepEqual(symbols(a), first, 'no repeated RNG initialization')
    assert.deepEqual(symbols(b), first)
    assert.equal(engine.worldEqual(a.world, b.world), true)
  } finally {
    b?.dispose()
    a.dispose()
  }
})
