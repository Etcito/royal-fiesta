import assert from 'node:assert/strict'
import test from 'node:test'
import type { TestContext } from 'node:test'
import type { DomainSpec, ShadowView } from '@gamesaloon/rollback/zones'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { newMemory } from '@royal-fiesta/sim/bots/brain'
import type { FeatureSpec, ObstacleSpec, PathNode, ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { quatIdentity, v3 } from '@royal-fiesta/sim/vec'
import type { Vec3 } from '@royal-fiesta/sim/vec'
import { cellOf } from '@royal-fiesta/sim/zones/cells'
import { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { createFiestaDomainFactory } from '@royal-fiesta/sim/zones/fiestaDomainFactory'
import { parseZonesFile, ZONES_FORMAT, ZONES_VERSION } from '@royal-fiesta/sim/zones/zonesFile'
import type { ZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { modeBotInput, newModeBotMemory } from '../src/net/modeBots.ts'
import { takeoverInput } from '../src/net/takeoverBot.ts'

const R = await initRapier()
const noShadows: ShadowView = {
  count: 0, fromDomain() { throw new Error('no link') }, reader() { throw new Error('no link') },
}
const MARKER: Vec3 = { x: 0, y: 0.85, z: 8 }
const RADIUS_M = 1.5

function obstacle(id: string, t: Vec3, half: Vec3): ObstacleSpec {
  return { id, asset: id, t, r: quatIdentity(), s: v3(1, 1, 1), friction: 0.5,
    motion: { kind: 'static' }, colliders: [{ shape: 'cuboid', half, t: v3(0, 0, 0), r: quatIdentity() }] }
}

function courseWith(features: FeatureSpec[], path: PathNode[] = []): ResolvedCourse {
  return {
    id: 'mode-bots', name: 'mode-bots', kind: 'race', profiles: ['sprint'],
    timeLimitS: 60, killPlaneY: -10, contentHash: 1,
    spawns: [{ t: v3(0, 0, 0), facing: { x: 0, z: 1 } }],
    checkpoints: [], finish: null, path, regions: [], queuePad: null,
    obstacles: [obstacle('floor', v3(0, -0.5, 10), v3(15, 0.5, 20))],
    features,
  }
}

function zonesFor(course: ResolvedCourse): ZonesFile {
  return parseZonesFile({ format: ZONES_FORMAT, version: ZONES_VERSION, course: course.id,
    grid: { origin: [-20, -10], cell: [20, 40], cols: 2, rows: 1 }, parts: {}, tuning: {},
  }, 'inline.zones', course)
}

function markerCourse(): ResolvedCourse {
  return courseWith([{ id: 'goal', kind: 'marker', params: { t: [MARKER.x, MARKER.y, MARKER.z], radiusM: RADIUS_M } }])
}

function domainFor(course: ResolvedCourse, t: TestContext): FiestaDomain {
  const zones = zonesFor(course)
  const factory = createFiestaDomainFactory(R, {
    course, zones, profile: { ...PROFILES.sprint, introTicks: 0 }, kind: 'race', seatCount: 1,
  })
  const spec: DomainSpec = { id: 1, kind: 'seat', seats: [0],
    cells: [cellOf(zones.grid, 0, 0)], replicas: [0, 1] }
  const domain = factory.create(spec, 0)
  assert.ok(domain instanceof FiestaDomain)
  t.after(() => domain.inner.world.sim.free())
  return domain
}

function markerDistance(domain: FiestaDomain): number {
  const p = domain.state(0).pos
  const dx = p.x - MARKER.x
  const dy = p.y - MARKER.y
  const dz = p.z - MARKER.z
  return Math.sqrt(dx * dx + dy * dy + dz * dz)
}

test('a bot driven by the marker feature reaches it within 600 ticks', t => {
  const domain = domainFor(markerCourse(), t)
  const memory = newModeBotMemory()
  const input = neutralInput()
  let distance = Infinity
  for (let tick = 0; tick < 600 && distance > RADIUS_M; tick++) {
    modeBotInput(domain, memory, 0, tick, input)
    domain.step([input], noShadows)
    distance = markerDistance(domain)
  }
  assert.ok(distance <= RADIUS_M, `bot reached the marker (distance ${distance.toFixed(2)} m, radius ${RADIUS_M} m)`)
})

test('a parked seat gets neutral input and a zero code', t => {
  const domain = domainFor(markerCourse(), t)
  domain.characters.park(domain.ctx, 0)
  const memory = newModeBotMemory()
  const out = { moveX: 1, moveZ: -1, jump: true, dive: true, grab: true }
  assert.equal(modeBotInput(domain, memory, 0, 0, out), 0)
  assert.deepEqual(out, neutralInput())
})

test('a course without features gives the same input as takeoverInput', t => {
  const course = courseWith([], [
    { p: v3(0, 0, 4), jump: false, dive: false },
    { p: v3(0, 0, 8), jump: false, dive: false },
  ])
  const domain = domainFor(course, t)
  const memory = newModeBotMemory()
  const takeover = newMemory()
  for (let tick = 0; tick < 120; tick++) {
    const botInput = neutralInput()
    const takeoverOut = neutralInput()
    const botCode = modeBotInput(domain, memory, 0, tick, botInput)
    const takeoverCode = takeoverInput(course, takeover, domain.state(0), tick, takeoverOut)
    assert.equal(botCode, takeoverCode, `tick ${tick}`)
    assert.deepEqual(botInput, takeoverOut, `tick ${tick}`)
    domain.step([botInput], noShadows)
  }
})
