import assert from 'node:assert/strict'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { newMemory } from '../../sim/src/bots/brain.ts'
import { nearestPathIndex } from '../../sim/src/bots/courseRead.ts'
import { encodeInput, neutralInput } from '../../sim/src/input.ts'
import { PROFILES } from '../../sim/src/match/setup.ts'
import { PlayerStatus } from '../../sim/src/match/roundSystem.ts'
import { FiestaDomain } from '../../sim/src/zones/fiestaDomain.ts'
import { createFiestaDomainFactory } from '../../sim/src/zones/fiestaDomainFactory.ts'
import { parseZonesFile } from '../../sim/src/zones/zonesFile.ts'
import { loadAllCoursesV1 } from '../../../apps/headless/src/contentFiles.ts'
import { modeBotInput, newModeBotMemory } from '../src/net/modeBots.ts'
import { takeoverInput } from '../src/net/takeoverBot.ts'

const R = await initRapier()
const shadows = { count: 0, fromDomain(): never { throw Error('no shadows') }, reader(): never { throw Error('no shadows') } }
const courses = (await loadAllCoursesV1()).flatMap(c => c.sim && (c.kind === 'race' || c.kind === 'survival') ? [c.sim] : [])

// Actual asset colliders, moving mechanisms and course features, using the show's
// controller and domain. Count respawns too: a parked/respawned bot is not a survivor.
for (const course of courses) {
  test(`show bot course cohort: ${course.id}`, () => {
    const seats = Array.from({ length: Math.min(8, course.spawns.length) }, (_, i) => i)
    const zones = parseZonesFile({ format: 'royal-fiesta.zones', version: 0, course: course.id,
      grid: { origin: [-1000, -1000], cell: [2000, 2000], cols: 1, rows: 1 }, parts: {}, tuning: {},
    }, 'bots.zones', course)
    const factory = createFiestaDomainFactory(R, { course, zones,
      profile: { ...PROFILES.standard, introTicks: 0 }, kind: course.kind as 'race' | 'survival', seatCount: seats.length })
    const domain = factory.create({ id: 1, kind: 'seat', seats, cells: [0], replicas: [0] }, 0)
    assert.ok(domain instanceof FiestaDomain)
    const finishRequired = ['race-bean-dash', 'race-sprint', 'candy-seesaw-run', 'ice-slide-gates', 'jungle-crane-crossing', 'mech-lab', 'neon-piston-alley', 's1-b-butterfly-freeway', 's1-c1-diamond-citadel', 's1-e-sugar-sprint', 's1-g-cloudstack-tower', 's1-d-spiral-of-mischief'].includes(course.id)
    const failed = new Set<number>()
    const park = domain.characters.park.bind(domain.characters)
    domain.characters.park = (ctx, p) => {
      if (domain.tick < 600 && domain.state(p).mode !== 7 && domain.status(p) !== PlayerStatus.qualified) failed.add(p)
      park(ctx, p)
    }
    const place = domain.characters.place.bind(domain.characters)
    domain.characters.place = (ctx, p, spawn) => {
      if (domain.tick < 600 && domain.state(p).mode !== 7) failed.add(p)
      place(ctx, p, spawn)
    }
    const memory = seats.map(() => newModeBotMemory()), inputs = seats.map(() => neutralInput())
    try {
      for (let tick = 0; tick < (finishRequired ? course.timeLimitS * 60 : 600); tick++) {
        for (const p of seats) modeBotInput(domain, memory[p], p, tick, inputs[p])
        if (tick === 0 && ['s1-b-butterfly-freeway', 's1-d-spiral-of-mischief', 's1-q-crown-confection'].includes(course.id)) {
          assert.equal(memory[0].target, null, 'remote feature must not replace the course route')
        }
        domain.step(inputs, shadows)
      }
      if (finishRequired) {
        const minimumFinish = course.id === 's1-d-spiral-of-mischief' ? 7 : 8
        assert.ok(seats.filter(p => domain.status(p) === PlayerStatus.qualified).length >= minimumFinish,
          `at least ${minimumFinish} bots must cross the finish`)
      }
      // Hammer Hill has real hammers that knock racers off; the controller must
      // still keep a surviving cohort. The full-course proof separately counts finishes.
      const minimum = course.id === 'race-hammer-hill' ? 1 : 6
      assert.ok(seats.length - failed.size >= minimum,
        `${seats.length - failed.size}/${seats.length} survived; expected >=${minimum}`)
    } finally { domain.dispose() }
  })
}

test('nearest waypoint distinguishes vertically stacked laps', () => {
  const c = courses.find(c => c.id === 's1-g-cloudstack-tower')!
  const node = c.path[51]
  assert.ok(nearestPathIndex(c, node.p) >= 51)
})

test('takeover cursor resets when a racer respawns', () => {
  const c = courses.find(c => c.id === 'race-sprint')!
  const memory = newMemory(), out = neutralInput()
  const state = { pos: { ...c.path[8].p }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: true, groundObstacle: 0, knockbacks: 0, teleportTick: 0 }
  takeoverInput(c, memory, state, 10, out)
  assert.ok(memory.pathIndex >= 8)
  state.pos = { ...c.spawns[0].t }
  state.teleportTick = 11
  takeoverInput(c, memory, state, 12, out)
  assert.ok(memory.pathIndex < 3)
})

test('checkpoint recovery starts at the checkpoint even late in the round', () => {
  const c = courses.find(c => c.id === 'race-sprint')!
  const memory = newMemory(), out = neutralInput()
  const state = { pos: { ...c.path[8].p }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: true, groundObstacle: 0, knockbacks: 0, teleportTick: 900 }
  takeoverInput(c, memory, state, 901, out)
  assert.ok(memory.pathIndex >= 8)
})

test('replanning cannot skip an unreached jump waypoint', () => {
  const c = courses.find(c => c.id === 's1-b-butterfly-freeway')!
  const memory = newMemory(), out = neutralInput()
  const state = { pos: { ...c.path[9].p }, vel: { x: 0, y: 0, z: 8 }, facing: { x: 0, z: 1 },
    mode: 0, grounded: true, groundObstacle: 0, knockbacks: 0, teleportTick: 0 }
  takeoverInput(c, memory, state, 200, out)
  assert.equal(memory.pathIndex, 10)
  state.pos.z = c.path[10].p.z - 1
  takeoverInput(c, memory, state, 204, out)
  assert.equal(memory.pathIndex, 10)
  state.pos.z = c.path[10].p.z + 1
  takeoverInput(c, memory, state, 208, out)
  assert.equal(memory.pathIndex, 11)
})

test('mechanism crossing has both waiting and traversable phases', async () => {
  const { crossingBlocked } = await import('../../sim/src/bots/crossing.ts')
  const c = courses.find(c => c.id === 'race-hammer-hill')!
  const pos = { x: 0, y: 2, z: 14 }, vel = { x: 0, y: 0, z: 0 }
  const phases = Array.from({ length: 180 }, (_, tick) => crossingBlocked(c, pos, vel, 0, 1, tick))
  assert.ok(phases.some(Boolean), 'wait when the hammer sweeps the crossing')
  assert.ok(phases.some(x => !x), 'the bot must be allowed through a clear interval')
})

function spiralDomain(): FiestaDomain {
  const course = courses.find(c => c.id === 's1-d-spiral-of-mischief')!
  const zones = parseZonesFile({ format: 'royal-fiesta.zones', version: 0, course: course.id,
    grid: { origin: [-1000, -1000], cell: [2000, 2000], cols: 1, rows: 1 }, parts: {}, tuning: {},
  }, 'launch-bots.zones', course)
  return createFiestaDomainFactory(R, { course, zones,
    profile: { ...PROFILES.standard, introTicks: 0 }, kind: 'race', seatCount: 1,
  }).create({ id: 1, kind: 'seat', seats: [0], cells: [0], replicas: [0] }, 0) as FiestaDomain
}

test('an airborne racer on a lower floor does not steer into an upper launch pad', () => {
  const domain = spiralDomain()
  try {
    const spawn = domain.obstacles.courses[0].spawns[0]
    domain.characters.place(domain.ctx, 0, { ...spawn, t: { x: 38, y: 4, z: 78 } })
    const memory = newModeBotMemory()
    modeBotInput(domain, memory, 0, 2, neutralInput())
    assert.equal(memory.target, null)
  } finally { domain.dispose() }
})

test('an actual launch retains its destination despite the vertical separation', () => {
  const domain = spiralDomain()
  try {
    const spawn = domain.obstacles.courses[0].spawns[0]
    domain.characters.place(domain.ctx, 0, { ...spawn, t: { x: 22, y: 15.25 - 0.86, z: 60 } })
    domain.step([neutralInput()], shadows)
    assert.ok(domain.state(0).vel.y > 20, 'the real launch feature must fire')
    const memory = newModeBotMemory()
    modeBotInput(domain, memory, 0, 2, neutralInput())
    assert.deepEqual(memory.target, { x: 6, y: 22.15, z: 60 })
  } finally { domain.dispose() }
})

test('marked spinner crossings anticipate the hub and respect floor and lane', async () => {
  const { rotorJumpAhead } = await import('../../sim/src/bots/crossing.ts')
  const course = courses.find(c => c.id === 's1-d-spiral-of-mischief')!
  const pos = { x: -14, y: 21, z: 32 }
  assert.equal(rotorJumpAhead(course, pos, 1, 0), true)
  assert.equal(rotorJumpAhead(course, pos, -1, 0), false)
  assert.equal(rotorJumpAhead(course, { ...pos, y: 5 }, 1, 0), false)
  assert.equal(rotorJumpAhead(course, { ...pos, z: 36 }, 1, 0), false)
  assert.equal(rotorJumpAhead(course, { ...pos, x: -20 }, 1, 0), false)
  assert.equal(rotorJumpAhead(course, pos, 0, 0), false)
})

test('long floor transitions follow the ramp centreline before turning onto the next ring', async () => {
  const { rampTarget } = await import('../../sim/src/bots/ramps.ts')
  const course = courses.find(c => c.id === 's1-c2-tidal-relay')!
  const from = { x: 1, y: 0.85, z: 85 }
  const target = rampTarget(course, 17, from)!
  assert.ok(target)
  assert.equal(target.x, 0, 'line to the next ring node cuts outside the narrow ramp')
  assert.ok(target.z < from.z, 'follow the course direction even when the support slopes backwards')
  const second = rampTarget(course, 33, { x: 1, y: 3.85, z: -57 })!
  assert.ok(second)
  assert.equal(second.x, 0)
  assert.ok(second.z > -57)
  assert.equal(rampTarget(course, 17, { x: 11, y: 4, z: 57 }), null, 'release the ramp on the destination floor')
  assert.equal(rampTarget(course, 1, from), null, 'flat segments keep their authored steering')
})

test('takeover encodes the refined ramp steering in its returned input', () => {
  const course = courses.find(c => c.id === 's1-c2-tidal-relay')!
  const memory = newMemory(), out = neutralInput()
  const state = { pos: { x: 0, y: 0.85, z: 85 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: -1 },
    mode: 0, grounded: true, groundObstacle: 0, knockbacks: 0, teleportTick: 0 }
  const code = takeoverInput(course, memory, state, 100, out)
  assert.equal(memory.pathIndex, 17)
  assert.equal(out.moveX, 0)
  assert.equal(out.moveZ, -1)
  // Consumers of the encoded result and the reused output must see the same command.
  assert.equal(code, encodeInput(out))
})
