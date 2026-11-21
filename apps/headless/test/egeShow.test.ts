import assert from 'node:assert/strict'
import test from 'node:test'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import { readWorldState } from '@etcito/game-engine/world-state'
import type { WorldState } from '@etcito/game-engine/world-state'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { buildShowPhysicsScenes, buildShowRulesScene } from '@royal-fiesta/game/ege/showScene'
import { createEngineShow } from '@royal-fiesta/game/ege/showRuntime'
import { readShowRoundResult, readShowState } from '@royal-fiesta/game/ege/showState'
import type {
  EngineShowConfig,
  EngineShowObservation,
  EngineShowPresentation,
  EngineShowRuntime,
  EngineShowSnapshot,
} from '@royal-fiesta/game/ege/showTypes'
import { legacyLevel } from '@royal-fiesta/sim/course'
import type { CourseV1 } from '@royal-fiesta/game/courseV1'
import { encodeInput } from '@royal-fiesta/sim/input'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { parseZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { parseEngineShowArgs, runEngineShow } from '../src/engineShow.ts'
import { loadEgeCourse, rfScriptBytes } from '../src/egeHarness.ts'
import { readRepoText } from '../src/files.ts'

const engine = await loadEngine()
const schemaText = await readRepoText(RF_EGE_SCHEMA)
engine.setSchema(schemaText)
const layout = schemaLayout(engine)
const script = await rfScriptBytes()

// The runtime is exercised on the real strip course with a short authored gameplay cap so a full
// show fits a test; the runtime itself never shortens a cap (testMode only shortens presentation).
const loaded = await loadEgeCourse('ege-strip')
const level = { ...(loaded.course.sim!.level ?? legacyLevel(loaded.course.sim!)), timeCapTicks: 600, overtimeTicks: 0 }
const course = { ...loaded.course, sim: { ...loaded.course.sim!, level } } as typeof loaded.course
const yardLoaded = await loadEgeCourse('ege-yard-a')
const yardLevel = { ...(yardLoaded.course.sim!.level ?? legacyLevel(yardLoaded.course.sim!)), timeCapTicks: 600, overtimeTicks: 0 }
const yard = { ...yardLoaded.course, sim: { ...yardLoaded.course.sim!, level: yardLevel } } as typeof yardLoaded.course

function zonesFor(selected: CourseV1): ZonesFile {
  return parseZonesFile({
    format: 'royal-fiesta.zones', version: 0, course: selected.id,
    grid: { origin: [-64, -64], cell: [2, 2], cols: 64, rows: 64 }, parts: {}, tuning: {},
  }, `courses/${selected.id}.zones.json`, selected.sim!)
}

const zones = new Map([[course.id, zonesFor(course)], [yard.id, zonesFor(yard)]])
const assets = new Map([...loaded.assets, ...yardLoaded.assets])

const season = [
  { id: 'A', course: 0, kind: 'race', finalRule: null, stages: ['R1'], team: false, cut: false },
  { id: 'B', course: 1, kind: 'race', finalRule: null, stages: ['R1'], team: false, cut: false },
  { id: 'Q', course: 0, kind: 'final', finalRule: 'crown', stages: ['final'], team: false, cut: false },
] as const

function humansAt(rooms: readonly number[]): boolean[] {
  return Array.from({ length: 60 }, (_, room) => rooms.includes(room))
}

function showConfig(humans: readonly boolean[], over: Partial<EngineShowConfig> = {}): EngineShowConfig {
  return {
    engine, schemaText, scriptBytes: script.slice(), seed: 7,
    identity: { backend: 'engine', schemaKey: layout.key, moduleKey: 'publication' },
    courses: [course, yard], assets, zones, season, humans, plan: [60, 2], testMode: true,
    ...over,
  }
}

const NEUTRAL = encodeInput({ moveX: 0, moveZ: 0, jump: false, dive: false, grab: false })
const MOVE = encodeInput({ moveX: 1, moveZ: 1, jump: true, dive: false, grab: false })
const FORWARD = encodeInput({ moveX: 0, moveZ: 1, jump: false, dive: false, grab: false })
const RIGHT = encodeInput({ moveX: 1, moveZ: 0, jump: false, dive: false, grab: false })
const LEFT = encodeInput({ moveX: -1, moveZ: 0, jump: false, dive: false, grab: false })
const JUMP = encodeInput({ moveX: 0, moveZ: 0, jump: true, dive: false, grab: false })
const DIVE = encodeInput({ moveX: 0, moveZ: 0, jump: false, dive: true, grab: false })
const GRAB = encodeInput({ moveX: 0, moveZ: 0, jump: false, dive: false, grab: true })
const BUTTON_MASK = 0x70000

test('frame accumulates finite seconds, caps at eight ticks and samples active humans once per tick', async () => {
  const runtime = await createEngineShow(showConfig(humansAt([2, 45])))
  try {
    const calls: number[] = []
    const start = nextTick(runtime)
    runtime.frame(0.001, room => { calls.push(room); return NEUTRAL })
    assert.equal(calls.length, 0)
    assert.equal(nextTick(runtime), start)

    runtime.frame(1 / 60, room => { calls.push(room); return NEUTRAL })
    assert.deepEqual(calls, [2, 45])
    assert.equal(nextTick(runtime), start + 1)

    calls.length = 0
    runtime.frame(9 / 60, room => { calls.push(room); return NEUTRAL })
    assert.equal(calls.length, 16)
    assert.deepEqual(calls.slice(0, 4), [2, 45, 2, 45])
    assert.equal(nextTick(runtime), start + 9)

    calls.length = 0
    runtime.frame(0, room => { calls.push(room); return NEUTRAL })
    assert.deepEqual(calls, [2, 45])
    assert.equal(nextTick(runtime), start + 10)

    for (const dt of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const before = nextTick(runtime)
      calls.length = 0
      assert.throws(() => runtime.frame(dt, room => { calls.push(room); return NEUTRAL }), RefusalError)
      assert.equal(calls.length, 0)
      assert.equal(nextTick(runtime), before)
    }

    for (const bad of [4294967296, -1, 1.5, Number.NaN, undefined]) {
      const before = nextTick(runtime)
      assert.throws(() => runtime.frame(1 / 60, () => bad as number), RefusalError)
      assert.equal(nextTick(runtime), before)
    }
    const boom = new Error('sampler failed')
    const before = nextTick(runtime)
    assert.throws(() => runtime.frame(1 / 60, () => { throw boom }), error => error === boom)
    assert.equal(nextTick(runtime), before)
  } finally { runtime.dispose() }
})

test('frame converts sampled S1 codes once and routes them through the mapped human slots', async () => {
  const runtime = await createEngineShow(showConfig(humansAt([0, 31])))
  try {
    for (let i = 0; i < 3; i++) {
      runtime.frame(1 / 60, room => room === 0 ? MOVE : NEUTRAL)
    }
    const seat = runtime.worlds().find(ref => ref.kind === 'seat')
    assert.ok(seat, 'a playing round opens its show_seat world')
    const state = readWorldState(engine, seat.world, layout)
    const entityOf = (room: number) => Object.entries(state.components.show_seat_identity)
      .find(([, row]) => Number(row.room_seat) === room)![0]
    // The runtime converts the S1 sample to engine input once; the controls script converts the assigned
    // SDK slot back to the S1 storage the landed character decoder reads, so the stored code is the sample.
    assert.equal(Number(state.components.show_control[entityOf(0)]!.code), MOVE)
    assert.equal(Number(state.components.show_control[entityOf(31)]!.code), NEUTRAL)
    // A configured bot has no input slot and is never sampled; its scripted control stays S1 neutral.
    assert.equal(Number(state.components.show_control[entityOf(5)]!.code), 32639)
  } finally { runtime.dispose() }
})

test('ordinary samples deliver neutral, both directions and buttons with their physical responses', async () => {
  const runtime = await createEngineShow(showConfig(humansAt([0])))
  try {
    let sample = NEUTRAL
    const drive = (ticks: number, code: number): void => {
      sample = code
      for (let i = 0; i < ticks; i++) runtime.frame(1 / 60, () => sample)
    }
    for (let frame = 0; frame < 300 && runtime.snapshot().screen !== 'playing'; frame++) drive(1, NEUTRAL)
    assert.equal(runtime.snapshot().screen, 'playing')
    drive(12, NEUTRAL)
    const world = () => runtime.worlds().find(ref => ref.kind === 'seat')!.world
    const seatEntity = (): number => {
      const state = readWorldState(engine, world(), layout)
      return Number(Object.entries(state.components.show_seat_identity)
        .find(([, row]) => Number(row.room_seat) === 0)![0])
    }
    const read = (): WorldState => readWorldState(engine, world(), layout)
    const control = (): number => Number(read().components.show_control[String(seatEntity())]!.code)
    const velocity = (): number[] => read().components['ege.velocity']![String(seatEntity())]!.lin as number[]
    const position = (): number[] => read().components['ege.transform']![String(seatEntity())]!.pos as number[]
    const mode = (): number => Number(read().components.character![String(seatEntity())]!.mode)

    drive(10, NEUTRAL)
    assert.equal(control(), NEUTRAL)
    const still = velocity()
    assert.ok(Math.hypot(still[0]!, still[2]!) < 0.2, `neutral keeps the seat stationary, got ${still}`)

    const startX = position()[0]!
    drive(12, RIGHT)
    assert.equal(control(), RIGHT)
    assert.ok(velocity()[0]! > 0.5, `moveX +1 drives east, got ${velocity()[0]}`)
    assert.ok(position()[0]! > startX + 0.1, 'the positive direction moves the character east')
    drive(12, LEFT)
    assert.equal(control(), LEFT)
    assert.ok(velocity()[0]! < -0.5, `moveX -1 drives west, got ${velocity()[0]}`)

    drive(20, NEUTRAL)
    assert.equal(mode(), 0, 'the character settles on the stationary surface')
    drive(1, JUMP)
    assert.equal(control() & BUTTON_MASK, JUMP & BUTTON_MASK)
    assert.ok(velocity()[1]! > 0 || mode() === 1, `jump imparts vertical speed or air mode, got ${velocity()[1]}`)
    drive(30, NEUTRAL)

    drive(1, DIVE)
    assert.equal(control() & BUTTON_MASK, DIVE & BUTTON_MASK)
    assert.ok(velocity()[1]! > 0 || mode() === 2, `dive imparts the authored dive response, got ${velocity()[1]}/${mode()}`)
    drive(40, NEUTRAL)

    drive(1, GRAB)
    assert.equal(control() & 0x40000, GRAB & 0x40000, 'the grab bit reaches the stored S1 control')
  } finally { runtime.dispose() }
})

function nextTick(runtime: EngineShowRuntime): number {
  const global = runtime.worlds().find(ref => ref.kind === 'global')!
  return global.confirmedTick
}

function votesOf(runtime: EngineShowRuntime): { seat: number; choice: number }[] {
  const global = runtime.worlds().find(ref => ref.kind === 'global')!
  const state = readWorldState(engine, global.world, layout)
  return Object.values(state.components.show_vote ?? {}).map(row => ({
    seat: Number(row.seat), choice: Number(row.choice),
  }))
}

test('vote replaces a pending choice, repeats idempotently and refuses invalid or out-of-phase votes', async () => {
  const runtime = await createEngineShow(showConfig(humansAt([0, 31])))
  try {
    runtime.frame(1 / 60, () => NEUTRAL)
    const open = runtime.snapshot()
    assert.equal(open.screen, 'vote')
    assert.equal(open.candidates.length, 2)
    for (const attempt of [() => runtime.vote(5, 0), () => runtime.vote(0, -1), () => runtime.vote(0, 2), () => runtime.vote(99, 0)]) {
      assert.throws(attempt, RefusalError)
    }
    assert.deepEqual(votesOf(runtime), [])
    runtime.vote(0, 0)
    assert.deepEqual(votesOf(runtime), [{ seat: 0, choice: 0 }])
    runtime.vote(0, 1)
    assert.deepEqual(votesOf(runtime), [{ seat: 0, choice: 1 }])
    runtime.vote(0, 1)
    assert.deepEqual(votesOf(runtime), [{ seat: 0, choice: 1 }])
    runtime.vote(31, 0)
    assert.equal(votesOf(runtime).length, 2)
    runtime.frame(2 / 60, () => NEUTRAL)
    assert.notEqual(runtime.snapshot().screen, 'vote')
    assert.throws(() => runtime.vote(0, 0), RefusalError)
  } finally { runtime.dispose() }
})

interface ShowRun {
  readonly snapshot: EngineShowSnapshot
  readonly screens: ReadonlySet<string>
}

async function driveShow(runtime: EngineShowRuntime, framesPerCall: number): Promise<ShowRun> {
  const screens = new Set<string>()
  const sample = (room: number): number => room === 0 ? FORWARD : NEUTRAL
  let votedRound = -1
  for (let frame = 0; frame < 4000; frame++) {
    const state = runtime.snapshot()
    screens.add(state.screen)
    if (state.screen === 'done') return { snapshot: state, screens }
    if (state.screen === 'vote' && state.candidates.length > 1 && votedRound !== state.round) {
      for (const room of [0, 1]) if (state.seatOf.includes(room)) runtime.vote(room, 1)
      votedRound = state.round
    }
    runtime.frame(frame === 0 ? 1 / 60 : framesPerCall, sample)
  }
  throw new Error('the scripted show did not reach done')
}

test('completes a sixty-seat scripted show through a confirmed final and equal replay/restore', async () => {
  const config = showConfig(humansAt([0, 1]))
  const runtime = await createEngineShow(config)
  const showId = runtime.presentation().showId
  let final: EngineShowSnapshot
  try {
    const outcome = await driveShow(runtime, 1 / 60)
    final = outcome.snapshot
    for (const screen of ['vote', 'loading', 'intro', 'playing', 'results', 'podium', 'done']) {
      assert.ok(outcome.screens.has(screen), `the show displayed '${screen}'`)
    }
    assert.equal(final.faults, 0)
    assert.equal(final.screen, 'done')
    assert.equal(final.seatOf.length, 2)
    assert.ok(final.results.length >= 2)
    const last = final.results.at(-1)!
    assert.equal(last.final, true)
    assert.equal(last.champion, 0)
    assert.equal(final.champion, 0)
    assert.deepEqual(final.alive, [0])

    const copy = runtime.snapshot()
    ;(copy.seatOf as number[]).push(99)
    ;(copy.results as unknown[]).pop()
    ;(copy.results[0]!.ranking as number[]).push(99)
    const fresh = runtime.snapshot()
    assert.ok(!fresh.seatOf.includes(99))
    assert.equal(fresh.results.length, final.results.length)
    assert.ok(!fresh.results[0]!.ranking.includes(99))

    const global = runtime.worlds().find(ref => ref.kind === 'global')!
    assert.equal(readShowRoundResult(config, global.world, last.endTick), null)
    assert.deepEqual(readShowRoundResult(config, global.world, last.endTick + 1), last)
    const pending = readShowState(config, global.world, last.endTick, final.faults)
    assert.equal(pending.results.some(result => result.index === last.index), false)
    assert.equal(pending.champion, null)
    const confirmed = readShowState(config, global.world, last.endTick + 1, final.faults)
    assert.deepEqual(confirmed.results, final.results)
    assert.equal(confirmed.champion, 0)

    const saved = engine.snapshot(global.world).slice()
    const restored = engine.createWorld(JSON.stringify(buildShowRulesScene(config)))
    try {
      engine.restore(restored, saved)
      assert.deepEqual(readShowState(config, restored, engine.tick(restored), final.faults), final)
      assert.deepEqual(readShowRoundResult(config, restored, engine.tick(restored)), last)
    } finally { engine.freeWorld(restored) }
  } finally { runtime.dispose() }
  runtime.dispose()
  assert.throws(() => runtime.worlds(), RefusalError)

  const replay = await createEngineShow(showConfig(humansAt([0, 1])))
  try {
    assert.notEqual(replay.presentation().showId, showId)
    const outcome = await driveShow(replay, 8 / 60)
    assert.deepEqual(outcome.snapshot, final)
  } finally { replay.dispose() }
})

test('presentation selects each committed round map, exposes live mappings and drains before release', async () => {
  const runtime = await createEngineShow(showConfig(humansAt([0, 1])))
  const observations: EngineShowObservation[] = []
  const frames: EngineShowObservation[][] = []
  const released: { tick: number; world: number }[] = []
  const mappedRounds = new Set<number>()
  const globalWorld = runtime.worlds().find(ref => ref.kind === 'global')!.world
  let capApplied = false
  try {
    const unsubscribe = runtime.onPresentation(observation => {
      observations.push(observation)
      const current = frames.at(-1)
      if (current !== undefined) current.push(observation)
      const presentation = observation.presentation
      if (!capApplied && observation.snapshot.screen === 'intro' && presentation.course !== null) {
        capApplied = true
        const rules = readWorldState(engine, globalWorld, layout)
        const clock = Object.values(rules.components.show_clock ?? {})[0]!
        const authored = presentation.course.level!
        assert.equal(Number(clock.round_ticks), authored.timeCapTicks, 'the selected cap is applied before readiness')
        assert.equal(Number(clock.overtime_ticks), authored.overtimeTicks)
        assert.equal(
          Number(clock.end_tick) - Number(clock.start_tick),
          Number(clock.intro_ticks) + Number(clock.round_ticks) + Number(clock.overtime_ticks),
        )
      }
      if (observation.kind === 'post-tick' && presentation.worlds.length > 0 && !mappedRounds.has(presentation.round)) {
        mappedRounds.add(presentation.round)
        const world = presentation.worlds[0]!
        assert.equal(world.ref.kind, 'seat')
        assert.equal(world.seats.length, observation.snapshot.seatOf.length)
        // Live template-to-entity mappings are valid now, before the next tick and any release.
        const state = readWorldState(engine, world.ref.world, layout)
        for (const seat of world.seats) {
          assert.equal(Number(state.components.show_seat_identity[String(seat.entity)]!.room_seat), seat.roomSeat)
          const template = world.scene.show!.seats[seat.roundSeat]!
          assert.equal(world.entities.get(template.entity), seat.entity)
        }
        assert.equal(world.obstacles.length, presentation.course!.obstacles.length)
        assert.deepEqual(world.mechanisms, presentation.course!.mechanisms?.items ?? [])
        assert.equal(world.publishers.size, world.seats.length * 19)
        for (const publisher of world.publishers.values()) assert.ok(publisher.startsWith('show/publish/'))
      }
      if (observation.kind !== 'before-release') return
      const world = observation.presentation.worlds[0]
      assert.ok(world, 'the departing physics world is still present in its release observation')
      assert.equal(observation.presentation.course?.id, world.scene.courseId)
      // The event source and metadata are readable now, before the factory frees the world.
      assert.equal(typeof engine.tick(world.ref.world), 'number')
      const events = engine.events(world.ref.world, Math.max(0, observation.tick - 3), observation.tick)
      assert.ok(Array.isArray(events.records))
      released.push({ tick: observation.tick, world: world.ref.world })
    })
    const sample = (room: number): number => room === 0 ? FORWARD : NEUTRAL
    let voted = -1
    for (let frame = 0; frame < 4000; frame++) {
      const state = runtime.snapshot()
      if (state.screen === 'done') break
      if (state.screen === 'vote' && state.candidates.length > 1 && voted !== state.round) {
        for (const room of [0, 1]) if (state.seatOf.includes(room)) runtime.vote(room, 1)
        voted = state.round
      }
      frames.push([])
      const tick = nextTick(runtime)
      runtime.frame(frame === 0 ? 1 / 60 : 8 / 60, sample)
      assert.equal(runtime.snapshot().round >= 0, true)
      assert.equal(nextTick(runtime) >= tick, true)
    }
    unsubscribe()
    unsubscribe()
    assert.equal(runtime.snapshot().screen, 'done')
    assert.deepEqual(released.map(entry => entry.tick), [...new Set(released.map(entry => entry.tick))])
    for (const entry of released) assert.throws(() => engine.tick(entry.world))
    const post = observations.filter(observation => observation.kind === 'post-tick')
    assert.equal(post.length, nextTick(runtime))
    for (let i = 1; i < post.length; i++) assert.equal(post[i]!.tick, post[i - 1]!.tick + 1)

    const releaseFrame = frames.find(frame => frame.some(observation => observation.kind === 'before-release'))!
    const releasePosts = releaseFrame.filter(observation => observation.kind === 'post-tick')
    assert.equal(releasePosts.length, 8, 'the terminal tick executed inside an eight-tick frame')
    const releaseTicks = releaseFrame.map(observation => observation.tick)
    assert.ok(releaseTicks.includes(released[0]!.tick))
    const terminal = releaseFrame.find(observation => observation.kind === 'before-release')!
    assert.ok(terminal.snapshot.screen === 'results' || terminal.snapshot.screen === 'podium' || terminal.snapshot.screen === 'done')
    assert.equal(terminal.snapshot.round, terminal.presentation.round)

    const maps = new Map<number, Set<string>>()
    const courses = new Map<number, Set<string>>()
    let mapped: EngineShowPresentation | undefined
    for (const observation of post) {
      const { presentation } = observation
      if (presentation.map === null || presentation.course === null) {
        assert.deepEqual(presentation.worlds, [])
        continue
      }
      mapped ??= presentation
      if (!maps.has(presentation.round)) maps.set(presentation.round, new Set())
      if (!courses.has(presentation.round)) courses.set(presentation.round, new Set())
      maps.get(presentation.round)!.add(presentation.map)
      courses.get(presentation.round)!.add(presentation.course.id)
    }
    assert.ok(mapped)
    assert.ok(post.some(observation => observation.presentation.worlds.length === 0), 'rules-only ticks are observed')
    assert.equal(capApplied, true)
    assert.equal(maps.get(0)!.has('B'), true, 'the voted second map is the script-committed round map')
    assert.equal(courses.get(0)!.has(yard.id), true)
    const finalRound = [...maps.keys()].find(round => maps.get(round)!.has('Q'))!
    assert.notEqual(finalRound, undefined)
    assert.equal(courses.get(finalRound)!.has(course.id), true)
    assert.ok(courses.size >= 2, 'the show crossed at least two physical courses')
    assert.equal(runtime.presentation().worlds.length, 0)
  } finally {
    runtime.dispose()
  }
})

test('listener failures surface without replaying a tick and disposal still releases the world', async () => {
  const runtime = await createEngineShow(showConfig(humansAt([0])))
  try {
    for (let frame = 0; frame < 300 && runtime.snapshot().screen !== 'playing'; frame++) {
      runtime.frame(1 / 60, () => NEUTRAL)
    }
    assert.equal(runtime.snapshot().screen, 'playing')
    const before = nextTick(runtime)
    const boom = new Error('listener failed')
    const unsubscribe = runtime.onPresentation(() => { throw boom })
    assert.throws(() => runtime.frame(1 / 60, () => NEUTRAL), error => error === boom)
    assert.equal(nextTick(runtime), before + 1, 'the executed tick is not replayed after a listener failure')
    unsubscribe()
    unsubscribe()
    runtime.frame(1 / 60, () => NEUTRAL)
    assert.equal(nextTick(runtime), before + 2)

    const released: EngineShowObservation[] = []
    let releasedWorld = -1
    runtime.onPresentation(observation => {
      if (observation.kind !== 'before-release') return
      released.push(observation)
      releasedWorld = observation.presentation.worlds[0]!.ref.world
      // Readable while the release notification runs; the world is freed only afterwards.
      assert.equal(typeof engine.tick(releasedWorld), 'number')
    })
    const releaseFailure = new Error('release listener failed')
    runtime.onPresentation(() => { throw releaseFailure })
    assert.throws(() => runtime.dispose(), error => error === releaseFailure)
    assert.equal(released.length, 1)
    assert.throws(() => engine.tick(releasedWorld))
    assert.throws(() => runtime.worlds(), RefusalError)
  } finally {
    runtime.dispose()
  }
})

test('runner arguments and prepared options refuse invalid seeds, seats, humans and plans', async () => {
  for (const argv of [
    ['--seed', 'nope'], ['--seed', '4294967296'], ['--seats', '1'], ['--humans', '60'],
    ['--humans', '0,0'], ['--plan', '0'], ['--max-frames', 'soon'],
  ]) {
    assert.throws(() => parseEngineShowArgs(argv), RefusalError, argv.join(' '))
  }
  const parsed = parseEngineShowArgs(['--seed', '9', '--seats', '8', '--humans', '0,7', '--plan', '8,1', '--test'])
  assert.equal(parsed.seed, 9)
  assert.equal(parsed.seats, 8)
  assert.equal(parsed.testMode, true)
  assert.deepEqual(parsed.humans, [true, false, false, false, false, false, false, true])
  assert.deepEqual(parsed.plan, [8, 1])

  for (const over of [{ seed: 1.5 }, { humans: [] as boolean[] }, { plan: [0] }, { season: [] }]) {
    await assert.rejects(() => runEngineShow({ config: showConfig(humansAt([0, 1]), over) }), RefusalError)
  }
  await assert.rejects(() => runEngineShow({ dir: 'no-such-show-content' }), RefusalError)
})

test('runner completes a prepared show and prints the confirmed final result', { timeout: 120_000 }, async () => {
  const lines: string[] = []
  const result = await runEngineShow({
    config: showConfig(humansAt([0, 1])),
    sample: room => room === 0 ? FORWARD : NEUTRAL,
    log: line => lines.push(line),
  })
  assert.equal(result.snapshot.screen, 'done')
  assert.equal(result.snapshot.faults, 0)
  assert.ok(result.snapshot.champion !== null)
  assert.equal(result.seats, 60)
  assert.ok(lines.some(line => line.startsWith('[engine-show] final ')), lines.join('\n'))
  assert.ok(lines.some(line => line.includes(`champion=${result.snapshot.champion}`)), lines.join('\n'))
  const final = result.snapshot.results.at(-1)!
  assert.equal(final.final, true)
  assert.equal(final.champion, result.snapshot.champion)
})

test('runner refuses failed preparation and a stalled show actionably', async () => {
  const broken = showConfig(humansAt([0, 1]), { scriptBytes: new Uint8Array() })
  await assert.rejects(() => runEngineShow({ config: broken }), /preparation|script|wasm|compile/i)
  await assert.rejects(
    () => runEngineShow({ config: showConfig(humansAt([0, 1])), maxFrames: 1 }),
    /stalled .*round 0 screen 'vote'/,
  )
})

test('mixed-course season builds each selected physical template and the rules clock refuses missing maps', async () => {
  const humans = humansAt([0, 1])
  const config = showConfig(humans)
  const rules = buildShowRulesScene(config)
  const entries = rules.entities.filter(row => row.components?.show_catalog_entry).map(row => row.components!.show_catalog_entry)
  assert.deepEqual(entries.map(entry => entry.course), [0, 1, 0])
  assert.deepEqual(entries.map(entry => entry.final_rule), [0, 0, 1])
  const selected = buildShowPhysicsScenes(config, yard, [0, 1], [0, 1], season[1])
  assert.equal(selected.seat.scene.resources!.round.kind, 0)
  const field = buildShowPhysicsScenes(config, course, [0, 1], [0, 1], season[2])
  assert.equal(field.seat.scene.resources!.round.final_rule, 1)
  assert.notEqual(selected.seat.text, field.seat.text)
  const bad = showConfig(humans, { courses: [course] })
  await assert.rejects(() => createEngineShow(bad), RefusalError)
})
