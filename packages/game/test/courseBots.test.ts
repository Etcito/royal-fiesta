import assert from 'node:assert/strict'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { newMemory } from '../../sim/src/bots/brain.ts'
import { nearestPathIndex } from '../../sim/src/bots/courseRead.ts'
import { neutralInput } from '../../sim/src/input.ts'
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
  test(`show bot survival cohort at 10 seconds: ${course.id}`, () => {
    const seats = Array.from({ length: Math.min(8, course.spawns.length) }, (_, i) => i)
    const zones = parseZonesFile({ format: 'royal-fiesta.zones', version: 0, course: course.id,
      grid: { origin: [-1000, -1000], cell: [2000, 2000], cols: 1, rows: 1 }, parts: {}, tuning: {},
    }, 'bots.zones', course)
    const factory = createFiestaDomainFactory(R, { course, zones,
      profile: { ...PROFILES.standard, introTicks: 0 }, kind: course.kind as 'race' | 'survival', seatCount: seats.length })
    const domain = factory.create({ id: 1, kind: 'seat', seats, cells: [0], replicas: [0] }, 0)
    assert.ok(domain instanceof FiestaDomain)
    const finishRequired = ['race-bean-dash', 'race-sprint', 'candy-seesaw-run', 'ice-slide-gates', 'jungle-crane-crossing', 'mech-lab'].includes(course.id)
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
      if (finishRequired) assert.ok(seats.some(p => domain.status(p) === PlayerStatus.qualified), 'a bot must cross the finish')
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
