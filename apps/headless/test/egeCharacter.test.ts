import assert from 'node:assert/strict'
import test from 'node:test'
import { createEngineRound } from '@royal-fiesta/game/ege/round'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { encodeInput, NEUTRAL_CODE } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { loadEngine } from '@etcito/game-engine'
import { emitEngineScene } from '@royal-fiesta/game/ege/sceneEmitter'
import { harnessRound, loadEgeCourse, rfScriptBytes, runTicks } from '../src/egeHarness.ts'
import { readRepoText } from '../src/files.ts'

const code = (moveZ = 0, buttons: Partial<{ jump: boolean; dive: boolean; grab: boolean }> = {}) =>
  encodeInput({ moveX: 0, moveZ, jump: false, dive: false, grab: false, ...buttons })

async function relocated(id: string, edit: (course: any) => void, humans = Array(8).fill(true), patch?: (doc: any, scene: import('@royal-fiesta/game/ege/sceneEmitter').EmittedScene) => void) {
  const { course, assets } = await loadEgeCourse(id)
  const copy = structuredClone(course)
  edit(copy)
  const engine = await loadEngine()
  const schema = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schema)
  let scene = emitEngineScene(engine, { course: copy, assets, setup: { profile: 'sprint', seed: 7 } })
  if (patch) {
    // Scene text is the engine's JSON entity list; entity ids are list indices.
    const doc = JSON.parse(scene.text)
    patch(doc, scene)
    scene = { ...scene, text: JSON.stringify(doc) }
  }
  const round = await createEngineRound(engine, schema, await rfScriptBytes(), scene, copy, { profile: 'sprint', seed: 7, humans })
  return { engine, scene, course: copy, round }
}

function check(obs: ReturnType<import('@royal-fiesta/game/ege/round').EngineRound['observe']>, poses: Float32Array) {
  assert.equal(obs.faults, 0)
  for (let i = 0; i < 8; i++) {
    assert.ok(Math.abs(poses[i * 23 + 3]) < 1e-3)
    assert.ok(Math.abs(poses[i * 23 + 5]) < 1e-3)
  }
}

function observe(round: import('@royal-fiesta/game/ege/round').EngineRound, scene: import('@royal-fiesta/game/ege/sceneEmitter').EmittedScene) {
  const value = round.observe()
  check(value, round.poses(scene.seatEntities))
  return value
}

function play(round: import('@royal-fiesta/game/ege/round').EngineRound, until: number, input: (tick: number) => number) {
  while (round.tick < until) round.step(seat => seat === 0 ? input(round.tick) : NEUTRAL_CODE)
}

test('character tuning constants and helpers match their hand-derived values', async () => {
  const wasm = await rfScriptBytes()
  const module = await WebAssembly.compile(wasm)
  const imports: Record<string, Record<string, () => number>> = { engine: {} }
  for (const item of WebAssembly.Module.imports(module)) {
    imports[item.module] ??= {}
    imports[item.module][item.name] = () => 0
  }
  const instance = await WebAssembly.instantiate(module, imports)
  const exported = instance.exports as Record<string, (...args: number[]) => number>
  const near = (name: string, actual: number, expected: number) => {
    assert.ok(Math.abs(actual - expected) <= 1e-12, `${name}: ${actual} != ${expected}`)
  }

  assert.equal(exported.strokeStartTick(), 15)
  assert.equal(exported.strokeTotalTicks(), 39)
  assert.equal(exported.strokeReadyTicks(), 30)
  assert.equal(exported.strokeElapsed(39), 0)
  assert.equal(exported.strokeElapsed(10), 29)
  assert.equal(exported.strokeElapsed(0), -1)
  near('iceWalkAccel midpoint', exported.iceWalkAccel(0.04), 0.15)
  near('iceWalkBrake midpoint', exported.iceWalkBrake(0.04), 0.095)
  near('iceWalkMaxRun midpoint', exported.iceWalkMaxRun(0.04), 0.925)
  near('iceWalkAccel low clamp', exported.iceWalkAccel(0.01), 0.05)
  near('iceWalkMaxRun high clamp', exported.iceWalkMaxRun(0.2), 1.1)
  near('surfaceMaxRun mud', exported.surfaceMaxRun(2), 0.6)
  near('surfaceBounce rubber', exported.surfaceBounce(3), 0.6)
  near('slideFriction ice', exported.slideFriction(1), 0.02)
  near('charTurnRate', exported.charTurnRate(), 4 * Math.PI)
})

test('characters run, jump, dive and slide from player input', async () => {
  const { scene, round } = await harnessRound('race-sprint', { humans: Array(8).fill(true) })
  const intro = PROFILES.sprint.introTicks
  try {
    play(round, intro + 30, tick => tick >= intro ? code(1) : NEUTRAL_CODE)
    let obs = observe(round, scene)
    assert.ok(Math.abs(Math.hypot(obs.seats[0].vel.x, obs.seats[0].vel.z) - 8) < 0.05)
    play(round, intro + 120, () => code(1))
    obs = observe(round, scene)
    assert.ok(obs.seats[0].pos.z > 5)
    assert.ok(obs.seats[0].facing.z > 0.99)
  } finally { round.dispose() }

  const jump = await harnessRound('race-sprint', { humans: Array(8).fill(true) })
  try {
    play(jump.round, intro + 40, () => NEUTRAL_CODE)
    const y0 = observe(jump.round, jump.scene).seats[0].pos.y
    jump.round.step(seat => seat === 0 ? code(0, { jump: true }) : NEUTRAL_CODE)
    jump.round.step(() => NEUTRAL_CODE)
    let high = 0
    let within20 = false
    for (let i = 0; i < 60; i++) {
      jump.round.step(() => NEUTRAL_CODE)
      const y = observe(jump.round, jump.scene).seats[0].pos.y
      high = Math.max(high, y - y0)
      if (i < 20 && y - y0 > 0.5) within20 = true
    }
    assert.ok(within20)
    assert.ok(high >= 1.2 && high <= 1.5, `jump rise ${high}`)
  } finally { jump.round.dispose() }

  const dive = await relocated('race-sprint', c => {
    c.sim.spawns[0].t = { x: 4.5, y: 1, z: -1 }
    c.sim.spawns[0].facing = { x: 0, z: 1 }
  })
  try {
    play(dive.round, intro + 40, tick => tick >= intro ? code(1) : NEUTRAL_CODE)
    dive.round.step(seat => seat === 0 ? code(0, { dive: true }) : NEUTRAL_CODE)
    let obs = observe(dive.round, dive.scene)
    assert.equal(obs.seats[0].mode, 2)
    assert.ok(Math.hypot(obs.seats[0].vel.x, obs.seats[0].vel.z) >= 10.45)
    let slid = false
    for (let i = 0; i < 60; i++) {
      dive.round.step(() => NEUTRAL_CODE)
      obs = observe(dive.round, dive.scene)
      if (obs.seats[0].mode === 8) {
        slid = true
        assert.ok(Math.hypot(obs.seats[0].vel.x, obs.seats[0].vel.z) >= 6)
        break
      }
    }
    assert.ok(slid, 'dive landing enters slide')
  } finally { dive.round.dispose() }
})

test('dive capture pattern and default bots move', async () => {
  const intro = PROFILES.sprint.introTicks
  const { scene, round } = await harnessRound('race-sprint')
  try {
    let firstDive = -1
    for (let i = 0; i < intro + 240; i++) {
      round.step(seat => seat === 0 ? code(1, { jump: round.tick >= intro && (round.tick - intro) % 45 === 0, dive: round.tick === intro + 60 }) : NEUTRAL_CODE)
      const obs = observe(round, scene)
      if (firstDive < 0 && obs.seats[0].mode === 2) firstDive = obs.tick
      if (firstDive >= 0 && obs.tick === firstDive + 10) assert.equal(obs.seats[0].mode, 2)
    }
    assert.ok(firstDive >= 0)
    assert.ok(observe(round, scene).seats.slice(1).filter(s => Math.hypot(s.pos.x - (s.seat % 4 - 1.5), s.pos.z) > 1).length >= 4)
  } finally { round.dispose() }
})

test('character surface tuning, conveyor, bounce pad and platform riding', async () => {
  const intro = PROFILES.sprint.introTicks
  for (const [surface, target, tolerance] of [['ice', 7.5, 0.1], ['mud', 4.8, 0.05]] as const) {
    const setup = await relocated('race-sprint', c => {
      const floor = c.sim.obstacles.find((item: any) => item.id === 'floor-start')
      floor.surface = surface
      if (surface === 'ice') floor.friction = 0.5
    })
    try {
      play(setup.round, intro + 30, t => t >= intro ? code(1) : NEUTRAL_CODE)
      const obs = observe(setup.round, setup.scene)
      const state = setup.round.worldState()
      const ch = state.components.character[String(obs.seats[0].entity)] as any
      const groundSurface = state.components.surface?.[String(ch.ground_entity)] as any
      assert.ok(Math.abs(Math.hypot(obs.seats[0].vel.x, obs.seats[0].vel.z) - target) < tolerance, `${surface} speed ${Math.hypot(obs.seats[0].vel.x, obs.seats[0].vel.z)}; ground ${ch.ground_entity} surface ${JSON.stringify(groundSurface)}`)
    } finally { setup.round.dispose() }
  }

  for (const [motion, ticks, verify] of [
    [{ kind: 'conveyor', velocity: { x: 3, y: 0, z: 0 } }, 60, (dx: number, dz: number) => dx > 2 && Math.abs(dz) < 0.3],
    [{ kind: 'bouncePad', speed: 14 }, 90, (dx: number, dy: number) => dy > 3],
    [{ kind: 'movingPlatform', offset: { x: 2, y: 0, z: 0 }, periodTicks: 240, phase: 0, wave: 'sine' }, 60, (dx: number) => Math.abs(dx) > 0.5],
  ] as const) {
    const setup = await relocated('race-sprint', c => {
      c.sim.obstacles.find((item: any) => item.id === 'floor-start').motion = motion
    })
    try {
      play(setup.round, intro, () => NEUTRAL_CODE)
      const start = observe(setup.round, setup.scene).seats[3].pos
      let high = 0
      for (let i = 0; i < ticks; i++) {
        setup.round.step(() => NEUTRAL_CODE)
        const seat = observe(setup.round, setup.scene).seats[3].pos
        high = Math.max(high, seat.y - start.y)
        if (motion.kind === 'conveyor') assert.ok(seat.z - start.z < 0.3)
        if (motion.kind === 'movingPlatform') verify(seat.x - start.x, 0)
      }
      const end = observe(setup.round, setup.scene).seats[3].pos
      if (motion.kind === 'conveyor') verify(end.x - start.x, end.z - start.z)
      if (motion.kind === 'bouncePad') verify(0, high)
    } finally { setup.round.dispose() }
  }
})

test('player and lever grabs attach and release', async () => {
  const intro = PROFILES.sprint.introTicks
  const player = await relocated('race-sprint', c => {
    c.sim.spawns[1].t = { ...c.sim.spawns[0].t, z: c.sim.spawns[0].t.z + 0.8 }
    c.sim.spawns[1].facing = { x: 0, z: 1 }
  })
  try {
    play(player.round, intro, () => NEUTRAL_CODE)
    for (let i = 0; i < 10; i++) {
      player.round.step(seat => seat === 0 && player.round.tick >= intro ? code(0, { grab: true }) : NEUTRAL_CODE)
      if (observe(player.round, player.scene).seats[0].mode === 5) break
    }
    assert.equal(observe(player.round, player.scene).seats[0].mode, 5)
  } finally { player.round.dispose() }

  const probe = await relocated('mech-lab', c => {
    c.sim.mechanisms.items.find((item: any) => item.id === 'lever').place.t = { x: 1.25, y: 0.85, z: 23 }
    c.json.obstacles.find((item: any) => item.id === 'lever').t = [1.25, 0.85, 23]
  })
  let hx = 0, hy = 0, hz = 0, leverId = 0
  try {
    play(probe.round, PROFILES.sprint.introTicks + 1, () => NEUTRAL_CODE)
    const state = probe.round.worldState()
    const records = state.components['ege.mech.lever']
    leverId = Number(Object.keys(records)[0])
    const lever = records[String(leverId)] as any
    const handle = state.components['ege.transform']?.[String(lever.handle)] as any
    ;[hx, hy, hz] = handle.pos
  } finally { probe.round.dispose() }
  const lever = await relocated('mech-lab', c => {
    c.sim.mechanisms.items.find((item: any) => item.id === 'lever').place.t = { x: 1.25, y: 0.85, z: 23 }
    c.json.obstacles.find((item: any) => item.id === 'lever').t = [1.25, 0.85, 23]
    const spawn = c.sim.spawns[0]
    const side = hz >= 23 ? 1 : -1
    spawn.t = { x: 1.25, y: 1, z: 22.1 }
    spawn.facing = { x: 0, z: -side }
  })
  try {
    play(lever.round, intro, () => NEUTRAL_CODE)
    const leverDistance = Math.hypot(lever.round.observe().seats[0].pos.x - hx, lever.round.observe().seats[0].pos.y - hy, lever.round.observe().seats[0].pos.z - hz)
    console.log(`lever-distance ${leverDistance.toFixed(6)} m`)
    assert.ok(leverDistance <= 1, `lever handle distance ${leverDistance}; handle ${hx},${hy},${hz}`)
    for (let i = 0; i < 5; i++) {
      lever.round.step(seat => seat === 0 ? code(0, { grab: true }) : NEUTRAL_CODE)
      observe(lever.round, lever.scene)
    }
    let obs = observe(lever.round, lever.scene)
    assert.equal(obs.seats[0].mode, 5)
    assert.equal((lever.round.worldState().components.character[String(obs.seats[0].entity)] as any).grab_lever, leverId)
    let grab = lever.round.worldState().components['ege.mech.grab'][String(obs.seats[0].entity)] as any
    assert.equal(grab.held, 1)
    assert.equal(grab.player, 0xFFFFFFFF)
    assert.equal(grab.mass, 60)
    for (let i = 0; i < 2; i++) {
      lever.round.step(() => NEUTRAL_CODE)
      obs = observe(lever.round, lever.scene)
    }
    assert.ok(obs.seats[0].mode === 0 || obs.seats[0].mode === 1)
    const ch = lever.round.worldState().components.character[String(obs.seats[0].entity)] as any
    grab = lever.round.worldState().components['ege.mech.grab'][String(obs.seats[0].entity)] as any
    assert.equal(ch.grab_lever, -1)
    assert.ok(ch.grab_cooldown >= 55)
    assert.equal(grab.held, 0)
  } finally { lever.round.dispose() }
})

test('show_control replaces the SDK slot on the shared movement path', async () => {
  const intro = PROFILES.sprint.introTicks
  const forward = await relocated('race-sprint', () => {}, undefined, (doc, scene) => {
    doc.entities[scene.seatEntities[0]].components.show_control = { code: code(1) }
  })
  try {
    // SDK input points backwards; the seat's show_control must win.
    play(forward.round, intro + 30, tick => tick >= intro ? code(-1) : NEUTRAL_CODE)
    const obs = observe(forward.round, forward.scene)
    assert.ok(obs.seats[0].vel.z > 7.9, `show_control forward speed ${obs.seats[0].vel.z}`)
    assert.ok(Math.abs(Math.hypot(obs.seats[0].vel.x, obs.seats[0].vel.z) - 8) < 0.05)
  } finally { forward.round.dispose() }

  const neutral = await relocated('race-sprint', () => {}, undefined, (doc, scene) => {
    doc.entities[scene.seatEntities[0]].components.show_control = { code: NEUTRAL_CODE }
  })
  try {
    play(neutral.round, intro + 30, tick => tick >= intro ? code(1) : NEUTRAL_CODE)
    const obs = observe(neutral.round, neutral.scene)
    assert.ok(Math.hypot(obs.seats[0].vel.x, obs.seats[0].vel.z) < 0.05, 'neutral show_control ignores SDK axes')
    const ch = neutral.round.worldState().components.character[String(obs.seats[0].entity)] as any
    assert.equal(ch.prev_buttons, 0)
  } finally { neutral.round.dispose() }
})

test('a show_control jump held from the start is stored without a repeated press edge', async () => {
  const intro = PROFILES.sprint.introTicks
  const jump = await relocated('race-sprint', () => {}, undefined, (doc, scene) => {
    doc.entities[scene.seatEntities[0]].components.show_control = { code: code(0, { jump: true }) }
  })
  try {
    play(jump.round, intro + 40, () => NEUTRAL_CODE)
    const y0 = observe(jump.round, jump.scene).seats[0].pos.y
    let high = 0
    for (let i = 0; i < 60; i++) {
      jump.round.step(() => NEUTRAL_CODE)
      const obs = observe(jump.round, jump.scene)
      high = Math.max(high, obs.seats[0].pos.y - y0)
    }
    // The button was already down on the first tick, so no press edge exists after the intro.
    assert.ok(high < 0.5, `held show_control jump must not re-press: rise ${high}`)
    const ch = jump.round.worldState().components.character[String(jump.scene.seatEntities[0])] as any
    assert.equal(ch.prev_buttons, 1)
  } finally { jump.round.dispose() }
})

test('grab target is mirrored into show_character_ref for the grabbing character', async () => {
  const intro = PROFILES.sprint.introTicks
  const grab = await relocated('race-sprint', c => {
    c.sim.spawns[1].t = { ...c.sim.spawns[0].t, z: c.sim.spawns[0].t.z + 0.8 }
    c.sim.spawns[1].facing = { x: 0, z: 1 }
  }, undefined, (doc, scene) => {
    doc.entities.push({ components: { show_character_ref: { owner: scene.seatEntities[0], target: 0xFFFFFFFF, lever: 0xFFFFFFFF, carry: 0xFFFFFFFF } } })
  })
  try {
    play(grab.round, intro, () => NEUTRAL_CODE)
    for (let i = 0; i < 10; i++) {
      grab.round.step(seat => seat === 0 && grab.round.tick >= intro ? code(0, { grab: true }) : NEUTRAL_CODE)
      if (observe(grab.round, grab.scene).seats[0].mode === 5) break
    }
    assert.equal(observe(grab.round, grab.scene).seats[0].mode, 5)
    const refs = Object.values(grab.round.worldState().components.show_character_ref as Record<string, any>)
    const ref = refs.find(item => item.owner === grab.scene.seatEntities[0])
    assert.ok(ref, 'show_character_ref child exists')
    assert.equal(ref.target, grab.scene.seatEntities[1])
    assert.equal(ref.lever, 0xFFFFFFFF)
    assert.equal(ref.carry, 0xFFFFFFFF)
  } finally { grab.round.dispose() }
})

test('spinner contact stuns, and repeated input runs are deterministic', async () => {
  const stun = await relocated('race-sprint', c => {
    c.sim.spawns[0].t = { x: 1.5, y: 1, z: 8 }
    c.sim.spawns[0].facing = { x: 0, z: 1 }
  })
  try {
    const intro = PROFILES.sprint.introTicks
    let hit = false
    for (let i = 0; i < intro + 240; i++) {
      stun.round.step(() => NEUTRAL_CODE)
      const obs = observe(stun.round, stun.scene)
      if (obs.seats[0].mode === 4 && obs.seats[0].knockbacks >= 1) hit = true
    }
    assert.ok(hit, 'spinner sweep produces a stun')
  } finally { stun.round.dispose() }

  const { engine, scene, course, round: a } = await harnessRound('race-sprint', { humans: Array(8).fill(true) })
  let b: import('@royal-fiesta/game/ege/round').EngineRound | undefined
  try {
    const schema = await readRepoText(RF_EGE_SCHEMA)
    b = await createEngineRound(engine, schema, await rfScriptBytes(), scene, course, { profile: 'sprint', seed: 7, humans: Array(8).fill(true) })
    for (let i = 0; i < 300; i++) {
      const input = (tick: number) => code(1, { jump: tick >= PROFILES.sprint.introTicks && (tick - PROFILES.sprint.introTicks) % 45 === 0, dive: tick === PROFILES.sprint.introTicks + 60 })
      a.step(seat => seat === 0 ? input(a.tick) : NEUTRAL_CODE)
      b.step(seat => seat === 0 ? input(b!.tick) : NEUTRAL_CODE)
      observe(a, scene)
      observe(b, scene)
    }
    assert.equal(engine.worldEqual(a.world, b.world), true)
  } finally {
    b?.dispose()
    a.dispose()
  }
})
