import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { encodeInput } from '@royal-fiesta/sim/input'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { createEngineRound } from '../src/ege/round.ts'
import { collectRfScripts, formatRfDiagnostic, rfCompiler } from '../../../tools/egeScripts.ts'
import { FEATURE_EMITTERS } from '../src/ege/featureEmitters.ts'
import { emitEngineScene } from '../src/ege/sceneEmitter.ts'
import type { EmitInput, EmittedScene } from '../src/ege/sceneEmitter.ts'
import { loadCourseV1 } from '../src/courseV1.ts'
import type { CourseV1, GameAssetResolver, ResolvedGameAsset } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'

const ROOT = new URL('../../../', import.meta.url)
const readJson = (path: string): unknown => JSON.parse(readFileSync(new URL(path, ROOT), 'utf8'))
const assets: GameAssetResolver = {
  async resolve(id) {
    const path = assetFilePath(id.split('.')[0] as World, id)
    const json = readJson(path)
    return { asset: await parseGameAsset(json, path), source: { path, json } }
  },
}
const engine = await loadEngine()
engine.setSchema(readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8'))

async function inputWith(path: string, specs: FeatureSpec[] | null): Promise<EmitInput> {
  const course = await loadCourseV1(readJson(path), path, assets)
  assert.ok(course.sim)
  const copy: CourseV1 = structuredClone(course)
  if (specs !== null) copy.sim!.features = specs
  const resolved = new Map<string, ResolvedGameAsset>()
  for (const assetId of copy.assetIds) resolved.set(assetId, await assets.resolve(assetId))
  return { course: copy, assets: resolved, setup: { profile: 'sprint', seed: 7 } }
}

function emitBuilds(input: EmitInput): EmittedScene {
  const emitted = emitEngineScene(engine, input)
  assert.ok(engine.createWorld(emitted.text) >= 1)
  return emitted
}

function refusedAt(input: EmitInput, spec: FeatureSpec, key: string): void {
  const path = `courses/${input.course.id}.course.json#/features/0`
  assert.throws(
    () => FEATURE_EMITTERS[spec.kind](spec, {
      course: input.course.sim!, index: 0, path: `courses/${input.course.id}.course.json`, assets: input.assets,
    }),
    (error: unknown) => error instanceof RefusalError &&
      error.message.startsWith(`[feature] ${path}${key ? `/${key}` : ''}:`),
  )
}

test('marker keeps its floor-disc visual on the identified feature root', async () => {
  const spec: FeatureSpec = { id: 'm', kind: 'marker', params: { t: [0, 0.5, 4], radiusM: 1.5 } }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/m')
  const root = emitted.scene.entities[rootIndex]
  assert.deepEqual(root.components?.feature, { kind: 0, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_marker?.t, [0, 0.5, 4])
  assert.equal(root.components?.['ege.render']?.shape, 4)
  assert.deepEqual(root.components?.['ege.render']?.params, [1.5, 0.05, 0, 0])
  refusedAt(input, { id: 'm', kind: 'marker', params: { t: [0, 0, 4], radiusM: 20 } }, 'radiusM')
})

test('road emits a data root and s1-glacier-run builds', async () => {
  const input = await inputWith('courses/s1-glacier-run.course.json', null)
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/glacier-entry')
  const root = emitted.scene.entities[rootIndex]
  assert.deepEqual(root.components?.feature, { kind: 21, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_road, { width: 14, surface: 1 })
  assert.deepEqual(root.components?.['ege.transform'], { pos: [0, 32, -8], rot: [0, 0, 0, 1] })
  assert.deepEqual(emitted.featureEntities.length, 3)
  const strip = await inputWith('fixtures/ege/ege-strip.course.json', null)
  const invalid: FeatureSpec = { id: 'r', kind: 'road', params: {} }
  refusedAt(strip, invalid, '')
  assert.throws(() => FEATURE_EMITTERS.road(invalid, {
    course: strip.course.sim!, index: 0, path: `courses/${strip.course.id}.course.json`, assets: strip.assets,
  }), (error: unknown) => error instanceof RefusalError && error.message.includes('Invalid road sweep'))
})

test('swimVolume emits a root and a slime-pool visual that build', async () => {
  const spec: FeatureSpec = { id: 'pool', kind: 'swimVolume', params: { center: [-3.5, 0.75, 6], half: [1, 0.75, 2] } }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/pool')
  const visualIndex = emitted.index('feature/pool/visual/0')
  assert.equal(visualIndex, rootIndex + 1)
  const root = emitted.scene.entities[rootIndex]
  const visual = emitted.scene.entities[visualIndex]
  assert.deepEqual(root.components?.feature, { kind: 6, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_swim_volume, {
    center: [-3.5, 0.75, 6], half: [1, 0.75, 2], drag: 2.5, buoyancy: 22,
    inside: [0, 0, 0, 0, 0, 0, 0, 0],
  })
  assert.equal(visual.components?.['ege.render']?.shape, 1)
  assert.deepEqual(visual.components?.['ege.render']?.params, [1, 0.75, 2, 0])
  const path = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  refusedAt(path, { id: 'pool', kind: 'swimVolume', params: { center: [0, 0, 0], half: [1, -1, 1] } }, 'half')
  refusedAt(path, { id: 'pool', kind: 'swimVolume', params: { center: [0, 0, 0], half: [1, 1, 1], drag: 30 } }, 'drag')
})

test('catchVolume emits a root resolved to its checkpoint', async () => {
  const spec: FeatureSpec = {
    id: 'catch', kind: 'catchVolume', params: { center: [-3.5, 1, 6], half: [1, 1.5, 0.5], respawnStage: 0 },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/catch')
  const visualIndex = emitted.index('feature/catch/visual/0')
  assert.equal(visualIndex, rootIndex + 1)
  const root = emitted.scene.entities[rootIndex]
  const visual = emitted.scene.entities[visualIndex]
  assert.deepEqual(root.components?.feature, { kind: 3, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_catch_volume, {
    center: [-3.5, 1, 6], half: [1, 1.5, 0.5], respawn_stage: 0, checkpoint: 0,
    inside: [0, 0, 0, 0, 0, 0, 0, 0],
  })
  assert.equal(visual.components?.['ege.render']?.shape, 4)
  assert.equal(visual.components?.['ege.render']?.color, 0xF2E6D0)
  assert.equal(visual.components?.['ege.render']?.visible, 0)
  assert.deepEqual(visual.components?.['ege.render']?.params, [1, 1.5, 0, 0])
  refusedAt(input, { ...spec, params: { ...spec.params, respawnStage: 3 } }, 'respawnStage')
  assert.throws(
    () => FEATURE_EMITTERS.catchVolume({ ...spec, params: { ...spec.params, respawnStage: 3 } }, {
      course: input.course.sim!, index: 0, path: `courses/${input.course.id}.course.json`, assets: input.assets,
    }), /no checkpoint at route stage 3; add a checkpoint of that stage/,
  )
  refusedAt(input, { ...spec, params: { ...spec.params, respawnStage: 1.5 } }, 'respawnStage')
})

test('tileField emits one fixed box body per tile', async () => {
  const spec: FeatureSpec = {
    id: 'tiles', kind: 'tileField',
    params: {
      tiles: [
        { t: [-3.5, -0.04, 0], size: [2, 2, 0.1] },
        { t: [-3.5, -0.04, 2], size: [2, 2, 0.1] },
      ],
      decayS: 0.5, warnS: 0.5, mode: 'reset', resetS: 2,
    },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const root = emitted.scene.entities[emitted.index('feature/tiles')]
  assert.deepEqual(root.components?.feature, { kind: 8, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_tile_field, {
    warn_s: 0.5, decay_s: 0.5, mode: 0, reset_s: 2, tile_count: 2,
  })
  for (let index = 0; index < 2; index++) {
    const entity = emitted.scene.entities[emitted.index(`feature/tiles/tile/${index}`)]
    assert.deepEqual(entity.colliders?.[0]?.half_extents, [1, 0.05, 1])
    assert.deepEqual(entity.components?.feature_tile_field_tile, {
      owner: 0, index, t: [-3.5, -0.04, index * 2], half: [1, 0.05, 1], state: 0, timer: 0,
    })
    assert.equal(entity.body?.type, 'fixed')
  }
  const permanent = await inputWith('fixtures/ege/ege-strip.course.json', [{
    ...spec, params: { ...spec.params, mode: 'permanent', resetS: undefined },
  }])
  const permanentScene = emitBuilds(permanent)
  const permanentRoot = permanentScene.scene.entities[permanentScene.index('feature/tiles')]
  assert.deepEqual(permanentRoot.components?.feature_tile_field, {
    warn_s: 0.5, decay_s: 0.5, mode: 1, reset_s: 0, tile_count: 2,
  })
  refusedAt(input, { ...spec, params: { ...spec.params, tiles: [] } }, 'tiles')
  refusedAt(input, {
    ...spec, params: { ...spec.params, tiles: [{ t: [0, 0, 0], size: [2, 2, 0.01] }] },
  }, 'tiles/0/size/2')
  refusedAt(input, { ...spec, params: { ...spec.params, mode: 'sometimes' } }, 'mode')
})

test('boostLane emits a root and a conveyor visual', async () => {
  const spec: FeatureSpec = {
    id: 'lane', kind: 'boostLane',
    params: {
      center: [-3.5, 1, 14], half: [1, 2, 13], yawDeg: 0, boost: 4,
      durationS: 2, rechargeS: 0, eligibility: 'all',
    },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/lane')
  const visualIndex = emitted.index('feature/lane/visual/0')
  assert.equal(visualIndex, rootIndex + 1)
  const root = emitted.scene.entities[rootIndex]
  const visual = emitted.scene.entities[visualIndex]
  assert.deepEqual(root.components?.feature, { kind: 1, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_boost_lane, {
    center: [-3.5, 1, 14], half: [1, 2, 13], yaw_deg: 0, boost: 4,
    duration_s: 2, recharge_s: 0, eligibility: 0, placed: 0,
    boost_until: Array(8).fill(0), ready_at: Array(8).fill(0),
  })
  assert.deepEqual(root.components?.['ege.transform'], { pos: [-3.5, 1, 14], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.transform'], { pos: [-3.5, 1, 14], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.render'], {
    shape: 1, color: 0x8C6BD9, visible: 1, params: [1, 2, 13, 0],
  })
  refusedAt(input, { ...spec, params: { ...spec.params, yawDeg: 200 } }, 'yawDeg')
  refusedAt(input, { ...spec, params: { ...spec.params, boost: 11 } }, 'boost')
  refusedAt(input, { ...spec, params: { ...spec.params, eligibility: 'some' } }, 'eligibility')
  refusedAt(input, { ...spec, params: { ...spec.params, durationS: 0 } }, 'durationS')
})

test('launchPad emits a pad visual and eight seat records', async () => {
  const spec: FeatureSpec = {
    id: 'pad', kind: 'launchPad',
    params: { center: [-3.5, 0.25, 4], half: [0.8, 0.25, 0.8], target: [-3.5, 0, 12], apexM: 2 },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/pad')
  const visualIndex = emitted.index('feature/pad/visual/0')
  assert.equal(visualIndex, rootIndex + 1)
  const root = emitted.scene.entities[rootIndex]
  const visual = emitted.scene.entities[visualIndex]
  assert.deepEqual(root.components?.feature, { kind: 2, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_launch_pad, {
    center: [-3.5, 0.25, 4], half: [0.8, 0.25, 0.8], target: [-3.5, 0, 12],
    apex_m: 2, recover_only: 0, pad_stage: -1, placed: 0,
  })
  assert.deepEqual(root.components?.['ege.transform'], { pos: [-3.5, 0.25, 4], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.transform'], { pos: [-3.5, 0.25, 4], rot: [0, 0, 0, 1] })
  assert.deepEqual(visual.components?.['ege.render'], {
    shape: 4, color: 0xFF8C42, visible: 1, params: [0.8, 0.25, 0, 0],
  })
  for (let seat = 0; seat < 8; seat++) {
    const index = emitted.index(`feature/pad/seat/${seat}`)
    assert.equal(index, visualIndex + 1 + seat)
    assert.deepEqual(emitted.scene.entities[index].components?.feature_launch_pad_seat, {
      owner: 0, seat, inside: 0, launched: -1, flight: 0, last_fall: -1, prev_protected: 0, alive: 1,
    })
  }
  const recoverInput = await inputWith('fixtures/ege/ege-strip.course.json', [
    { ...spec, params: { ...spec.params, recoverOnly: true } },
  ])
  const recover = emitBuilds(recoverInput)
  assert.equal(recover.scene.entities[recover.index('feature/pad')].components?.feature_launch_pad?.recover_only, 1)
  refusedAt(input, { ...spec, params: { ...spec.params, apexM: 0.1 } }, 'apexM')
  refusedAt(input, { ...spec, params: { ...spec.params, target: [1, 2] } }, 'target')
  refusedAt(input, { ...spec, params: { ...spec.params, recoverOnly: 'yes' } }, 'recoverOnly')
})

test('boostLane show worlds build with the G6 cooldown storage preserved', async () => {
  const spec: FeatureSpec = {
    id: 'lane', kind: 'boostLane',
    params: {
      center: [-3.5, 1, 14], half: [1, 2, 13], yawDeg: 0, boost: 4,
      durationS: 2, rechargeS: 0, eligibility: 'all',
    },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const seatOf = Array.from({ length: 60 }, (_, seat) => seat)
  const show = {
    worldKind: 'show_field' as const,
    seatOf,
    inputSlots: seatOf.map(() => -1),
    humans: seatOf.map(() => false),
  }
  const emitted = emitBuilds({ ...input, show })
  const rootIndex = emitted.index('feature/lane')
  assert.equal(emitted.index('feature/lane/visual/0'), rootIndex + 1)
  const round = emitBuilds(input)
  const roundRoot = round.scene.entities[round.index('feature/lane')].components?.feature_boost_lane
  assert.deepEqual(roundRoot?.boost_until, Array(8).fill(0))
  assert.deepEqual(roundRoot?.ready_at, Array(8).fill(0))
})

test('launchPad show worlds emit one seat row per roster seat', async () => {
  const spec: FeatureSpec = {
    id: 'pad', kind: 'launchPad',
    params: { center: [-3.5, 0.25, 4], half: [0.8, 0.25, 0.8], target: [-3.5, 0, 12], apexM: 2 },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const seatOf = Array.from({ length: 60 }, (_, seat) => seat)
  const show = {
    worldKind: 'show_field' as const,
    seatOf,
    inputSlots: seatOf.map(() => -1),
    humans: seatOf.map(() => false),
  }
  const emitted = emitBuilds({ ...input, show })
  const visualIndex = emitted.index('feature/pad/visual/0')
  const seat59 = emitted.index('feature/pad/seat/59')
  assert.equal(seat59, visualIndex + 1 + 59)
  assert.deepEqual(emitted.scene.entities[seat59].components?.feature_launch_pad_seat, {
    owner: 0, seat: 59, inside: 0, launched: -1, flight: 0, last_fall: -1, prev_protected: 0, alive: 1,
  })
  assert.equal(emitted.index('feature/pad/seat/60'), -1)
  const round = emitBuilds(input)
  assert.equal(round.index('feature/pad/seat/8'), -1)
  assert.ok(round.index('feature/pad/seat/7') > 0)
})

test('rollingLog emits a kinematic cylinder root', async () => {
  const spec: FeatureSpec = {
    id: 'log', kind: 'rollingLog',
    params: { from: [20, 1, 10], to: [20, 1, 16], radius: 0.6, length: 4, speed: 3, periodS: 6 },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const rootIndex = emitted.index('feature/log')
  const root = emitted.scene.entities[rootIndex]
  assert.deepEqual(root.components?.feature, { kind: 4, index: 0, salt: 0x100 })
  assert.deepEqual(root.components?.feature_rolling_log, {
    from: [20, 1, 10], to: [20, 1, 16], radius: 0.6, length: 4, speed: 3, period_s: 6, phase_s: 0,
  })
  assert.deepEqual(root.components?.['ege.transform'], { pos: [20, 1, 10], rot: [0, 0, 0, 1] })
  assert.equal(root.body?.type, 'kinematic_position')
  assert.deepEqual(root.colliders?.[0], { shape: 'cylinder', radius: 0.6, half_height: 2, group: 'moving' })
  assert.deepEqual(root.components?.['ege.render'], {
    shape: 4, color: 0xB0784A, visible: 1, params: [0.6, 2, 0, 0],
  })
  assert.equal(emitted.index('feature/log/visual/0'), -1)
  refusedAt(input, { ...spec, params: { ...spec.params, to: [20, 1, 10] } }, 'to')
  refusedAt(input, { ...spec, params: { ...spec.params, from: [0, 1, 10], to: [0, 3, 10] } }, 'to')
  refusedAt(input, { ...spec, params: { ...spec.params, periodS: 1 } }, 'periodS')
  assert.throws(
    () => FEATURE_EMITTERS.rollingLog({ ...spec, params: { ...spec.params, periodS: 1 } }, {
      course: input.course.sim!, index: 0, path: `courses/${input.course.id}.course.json`, assets: input.assets,
    }),
    (error: unknown) => error instanceof RefusalError && error.message.includes('12 m round trip'),
  )
  refusedAt(input, { ...spec, params: { ...spec.params, radius: 5 } }, 'radius')
})

test('rollingLog body stays at from before any rolling-log script', async () => {
  const spec: FeatureSpec = {
    id: 'log', kind: 'rollingLog',
    params: { from: [20, 1, 10], to: [20, 1, 16], radius: 0.6, length: 4, speed: 3, periodS: 6 },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const engine = await loadEngine()
  const schema = JSON.parse(readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8'))
  for (const worldKind of schema.world_kinds) {
    worldKind.schedule = worldKind.schedule.filter(({ system }: { system: string }) =>
      system !== 'rf.feature.rolling_log.pre' && system !== 'rf.feature.rolling_log.post')
  }
  const schemaText = JSON.stringify(schema)
  const compiled = await (await rfCompiler()).compile(collectRfScripts(), schemaText)
  const errors = compiled.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
  assert.deepEqual(errors.map(formatRfDiagnostic), [], 'rolling-log isolated-schema compilation errors')
  assert.ok(compiled.wasm, 'rolling-log isolated-schema compilation produced no wasm')
  engine.setSchema(schemaText)
  const scene = emitEngineScene(engine, input)
  const round = await createEngineRound(engine, schemaText, Uint8Array.from(compiled.wasm), scene, input.course, {
    profile: 'sprint', seed: 7, humans: [true, false, false, false, false, false, false, false],
  })
  try {
    const entity = scene.index('feature/log')
    for (let tick = 0; tick < 30; tick++) {
      round.step(() => encodeInput({ moveX: 0, moveZ: 0, jump: false, dive: false, grab: false }))
      assert.equal(round.observe().faults, 0)
      const transform = round.worldState().components['ege.transform'][String(entity)] as { pos: number[] }
      assert.ok(transform.pos.every((value, axis) => Math.abs(value - [20, 1, 10][axis]!) <= 1e-3))
    }
    assert.equal(round.tick, 30)
  } finally {
    round.dispose()
  }
})

test('doorBank emits door bodies and hidden debris visuals', async () => {
  const doors = [
    { t: [-3.5, 1, 8], yawDeg: 0, size: [0.9, 2, 0.3] },
    { t: [-2.5, 1, 8], yawDeg: 0, size: [0.9, 2, 0.3] },
  ]
  const spec: FeatureSpec = { id: 'bank', kind: 'doorBank', params: { rows: [{ doors, real: 1 }], breakSpeed: 3 } }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const emitted = emitBuilds(input)
  const root = emitted.index('feature/bank')
  assert.deepEqual(emitted.scene.entities[root].components?.feature_door_bank, {
    break_speed: 3, door_count: 2, placed: 0,
  })
  for (let i = 0; i < 2; i++) {
    const id = emitted.index(`feature/bank/door/${i}`)
    assert.equal(id, root + 1 + i)
    const door = emitted.scene.entities[id]
    assert.equal(door.body?.type, 'fixed')
    assert.deepEqual(door.colliders?.[0], { shape: 'box', half_extents: [0.45, 1, 0.15], group: 'static' })
    assert.equal(door.components?.['ege.body_props'].colliders_enabled, 1)
    assert.deepEqual(door.components?.feature_door_bank_door, {
      owner: 0, index: i, row: 0, real: 1, t: doors[i].t, size: doors[i].size,
      yaw_deg: 0, solid: 0, open: 0, revealed: 0, open_tick: -1,
    })
    assert.deepEqual(door.components?.['ege.render'], { shape: 1, color: 0xC98B5A, params: [0.45, 1, 0.15, 0], visible: 1 })
  }
  for (let i = 0; i < 6; i++) {
    const id = emitted.index(`feature/bank/debris/${i}`)
    assert.equal(id, root + 3 + i)
    const debris = emitted.scene.entities[id]
    assert.deepEqual(debris.components?.feature_door_bank_debris, { owner: 0, door: Math.floor(i / 3), piece: i % 3 - 1 })
    assert.deepEqual(debris.components?.['ege.render'], { shape: 1, color: 0xE8C39E, params: [0, 0, 0, 0], visible: 0 })
  }
  emitBuilds(await inputWith('courses/s1-e-sugar-sprint.course.json', null))
  refusedAt(input, { ...spec, params: { ...spec.params, rows: [{ doors: doors.slice(0, 1), real: 1 }] } }, 'rows/0/doors')
  refusedAt(input, { ...spec, params: { ...spec.params, rows: [{ doors, real: 2 }] } }, 'rows/0/real')
  refusedAt(input, { ...spec, params: { ...spec.params, rows: [{ doors: [{ ...doors[0], size: [0.05, 2, 0.3] }, doors[1]], real: 1 }] } }, 'rows/0/doors/0/size/0')
  refusedAt(input, { ...spec, params: { ...spec.params, breakSpeed: 0 } }, 'breakSpeed')
})

test('doorBank doors block a running seat before any script', async () => {
  const spec: FeatureSpec = {
    id: 'bank', kind: 'doorBank', params: {
      rows: [{ doors: [
        { t: [-3.5, 1, 8], yawDeg: 0, size: [0.9, 2, 0.3] },
        { t: [-2.5, 1, 8], yawDeg: 0, size: [0.9, 2, 0.3] },
      ], real: 1 }], breakSpeed: 3,
    },
  }
  const input = await inputWith('fixtures/ege/ege-strip.course.json', [spec])
  const engine = await loadEngine()
  const schema = JSON.parse(readFileSync(new URL('../../../ege.schema.json', import.meta.url), 'utf8'))
  for (const worldKind of schema.world_kinds) {
    worldKind.schedule = worldKind.schedule.filter(({ system }: { system: string }) => system !== 'rf.feature.door_bank.pre')
  }
  const schemaText = JSON.stringify(schema)
  const compiled = await (await rfCompiler()).compile(collectRfScripts(), schemaText)
  assert.deepEqual(compiled.diagnostics.filter(d => d.severity === 'error').map(formatRfDiagnostic), [])
  assert.ok(compiled.wasm)
  engine.setSchema(schemaText)
  const scene = emitEngineScene(engine, input)
  const round = await createEngineRound(engine, schemaText, Uint8Array.from(compiled.wasm), scene, input.course, {
    profile: 'sprint', seed: 7, humans: [true, false, false, false, false, false, false, false],
  })
  try {
    while (round.tick < 180) {
      round.step(seat => encodeInput({ moveX: 0, moveZ: seat === 0 && round.tick >= 60 ? 1 : 0, jump: false, dive: false, grab: false }))
      assert.equal(round.observe().faults, 0)
      assert.ok(round.observe().seats[0].pos.z < 8)
    }
    for (let i = 0; i < 2; i++) {
      const entity = String(scene.index(`feature/bank/door/${i}`))
      assert.equal((round.worldState().components['ege.body_props'][entity] as { colliders_enabled: number }).colliders_enabled, 1)
      assert.equal((round.worldState().components.feature_door_bank_door[entity] as { open: number }).open, 0)
    }
  } finally {
    round.dispose()
  }
})

test('show volumes preserve their round payloads for runtime membership', async () => {
  const specs: FeatureSpec[] = [
    { id: 'catch', kind: 'catchVolume', params: { center: [0, 1, 6], half: [1, 1, 1], respawnStage: 0 } },
    { id: 'pool', kind: 'swimVolume', params: { center: [0, 1, 8], half: [1, 1, 1] } },
  ]
  const input = await inputWith('fixtures/ege/ege-strip.course.json', specs)
  const round = emitBuilds(input)
  const seatOf = Array.from({ length: 60 }, (_, seat) => seat)
  const show = emitBuilds({ ...input, show: {
    worldKind: 'show_field', seatOf, inputSlots: seatOf.map(() => -1), humans: seatOf.map(() => false),
  } })
  for (const [id, component] of [['catch', 'feature_catch_volume'], ['pool', 'feature_swim_volume']] as const) {
    assert.deepEqual(show.scene.entities[show.index(`feature/${id}`)].components?.[component],
      round.scene.entities[round.index(`feature/${id}`)].components?.[component])
  }
})
