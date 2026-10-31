import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { Checkpoint, PathNode, ResolvedCourse, RespawnSpec, RouteSpec, SpawnPoint } from '../src/course.ts'
import {
  dueRespawn, newRespawnState, nextSlot, readRespawn, respawnSlot, scheduleRespawn, writeRespawn,
} from '../src/season/respawn.ts'
import type { RespawnState } from '../src/season/respawn.ts'
import {
  finishCrossed, gateCrossed, newRouteState, readRoute, routeDistanceMm, subTick, writeRoute,
} from '../src/season/route.ts'
import type { RouteState } from '../src/season/route.ts'
import { v3 } from '../src/vec.ts'

function spawn(x: number, y: number, z: number, fx = 0, fz = 1): SpawnPoint {
  return { t: v3(x, y, z), facing: { x: fx, z: fz } }
}

function checkpoint(x: number, y: number, z: number): Checkpoint {
  return { box: { center: v3(x, y, z), half: v3(1, 1, 1) }, respawn: spawn(x, 0, z) }
}

function pathNode(x: number, y: number, z: number): PathNode {
  return { p: v3(x, y, z), jump: false, dive: false }
}

function course(overrides: Partial<ResolvedCourse>): ResolvedCourse {
  return {
    id: 'season-route-test',
    name: 'Season Route Test',
    kind: 'race',
    profiles: ['standard'],
    timeLimitS: 60,
    killPlaneY: -12,
    spawns: [],
    checkpoints: [],
    finish: null,
    path: [],
    regions: [],
    queuePad: null,
    obstacles: [],
    contentHash: 0,
    ...overrides,
  }
}

function routeSpec(overrides: Partial<RouteSpec> = {}): RouteSpec {
  return { ordered: true, laps: 1, stages: [], ...overrides }
}

function respawnSpec(overrides: Partial<RespawnSpec> = {}): RespawnSpec {
  return { mode: 'checkpoint', waitTicks: 0, protectTicks: 0, slots: 12, spacingM: 1.5, ...overrides }
}

function distance(a: SpawnPoint, b: SpawnPoint): number {
  return Math.hypot(a.t.x - b.t.x, a.t.y - b.t.y, a.t.z - b.t.z)
}

describe('ordered route gates', () => {
  it('refuses a skipped stage and never re-accepts a passed gate', () => {
    const spec = routeSpec({ stages: [0, 1, 1, 2] })
    const st = newRouteState(1)
    assert.equal(gateCrossed(spec, st, 0, 1), false)
    assert.equal(gateCrossed(spec, st, 0, 3), false)
    assert.equal(st.stage[0], -1)
    assert.equal(gateCrossed(spec, st, 0, 0), true)
    assert.equal(st.stage[0], 0)
    assert.equal(gateCrossed(spec, st, 0, 0), false)
    assert.equal(gateCrossed(spec, st, 0, 1), true)
    assert.equal(st.stage[0], 1)
    assert.equal(gateCrossed(spec, st, 0, 1), false)
    assert.equal(gateCrossed(spec, st, 0, 3), true)
    assert.equal(st.stage[0], 2)
    assert.equal(gateCrossed(spec, st, 0, 2), false)
  })

  it('accepts either branch checkpoint of a shared stage', () => {
    const spec = routeSpec({ stages: [0, 1, 1, 2] })
    const left = newRouteState(1)
    const right = newRouteState(1)
    assert.equal(gateCrossed(spec, left, 0, 0), true)
    assert.equal(gateCrossed(spec, right, 0, 0), true)
    assert.equal(gateCrossed(spec, left, 0, 1), true)
    assert.equal(gateCrossed(spec, right, 0, 2), true)
    assert.equal(left.stage[0], 1)
    assert.equal(right.stage[0], 1)
    assert.equal(gateCrossed(spec, left, 0, 3), true)
    assert.equal(gateCrossed(spec, right, 0, 3), true)
  })

  it('keeps the V1 highest-checkpoint rule for unordered routes', () => {
    const spec = routeSpec({ ordered: false, stages: [0, 1, 2, 3] })
    const st = newRouteState(1)
    assert.equal(gateCrossed(spec, st, 0, 2), true)
    assert.equal(st.stage[0], 2)
    assert.equal(gateCrossed(spec, st, 0, 1), false)
    assert.equal(gateCrossed(spec, st, 0, 3), true)
  })
})

describe('route laps and finish', () => {
  it('counts 2 laps as lap then finish and ignores the finish before the last stage', () => {
    const spec = routeSpec({ laps: 2, stages: [0] })
    const st = newRouteState(1)
    assert.equal(finishCrossed(spec, st, 0, 0), 'ignored')
    assert.equal(st.finished[0], 0)
    assert.equal(gateCrossed(spec, st, 0, 0), true)
    assert.equal(finishCrossed(spec, st, 0, 0), 'lap')
    assert.equal(st.lap[0], 1)
    assert.equal(st.stage[0], -1)
    assert.equal(finishCrossed(spec, st, 0, 0), 'ignored')
    assert.equal(gateCrossed(spec, st, 0, 0), true)
    assert.equal(finishCrossed(spec, st, 0, 0), 'finish')
    assert.equal(st.lap[0], 1)
    assert.equal(st.finished[0], 1)
  })
})

describe('routeDistanceMm', () => {
  it('measures along a U-shaped path, not straight across the gap', () => {
    const c = course({
      path: [
        pathNode(0, 0, 0),
        pathNode(0, 0, 20),
        pathNode(10, 0, 20),
        pathNode(10, 0, 0),
      ],
      checkpoints: [checkpoint(10, 1, 0), checkpoint(30, 1, 0)],
      finish: { center: v3(30, 1, 0), half: v3(1, 1, 1) },
    })
    const spec = routeSpec({ stages: [0, 1] })
    const mm = routeDistanceMm(c, spec, -1, v3(0, 0, 1))
    const straight = Math.hypot(10, 0, 1)
    assert.ok(mm > 2 * straight * 1000, `arc ${mm}mm should exceed twice the straight ${straight * 1000}mm`)
    assert.ok(Math.abs(mm - 49000) <= 1, `expected the 49m arc, got ${mm}mm`)
  })
})

describe('subTick', () => {
  it('reports the crossing fraction at 0, 0.5 and 1', () => {
    assert.equal(subTick(5, -5, 5), 0)
    assert.equal(subTick(5, -5, 0), 32768)
    assert.equal(subTick(5, -5, -5), 65535)
  })

  it('returns 0 when the tick does not move and clamps out-of-range fractions', () => {
    assert.equal(subTick(2, 2, 1), 0)
    assert.equal(subTick(5, -5, 10), 0)
    assert.equal(subTick(5, -5, -10), 65535)
  })
})

describe('respawn timing', () => {
  it('starts idle, schedules the wait and protection, and is due at the wait tick', () => {
    const spec = respawnSpec({ waitTicks: 180, protectTicks: 60 })
    const st = newRespawnState(2, 3)
    assert.deepEqual([...st.waitUntil], [-1, -1])
    assert.deepEqual([...st.protectUntil], [-1, -1])
    assert.deepEqual([...st.slotCursor], [0, 0, 0])
    scheduleRespawn(spec, st, 1, 100)
    assert.equal(st.waitUntil[1], 280)
    assert.equal(st.protectUntil[1], 340)
    assert.equal(dueRespawn(st, 0, 1000), false)
    assert.equal(dueRespawn(st, 1, 279), false)
    assert.equal(dueRespawn(st, 1, 280), true)
    st.waitUntil[1] = -1
    assert.equal(dueRespawn(st, 1, 280), false)
  })
})

describe('respawn slots', () => {
  it('spreads 12 distinct slots on a centred grid spacingM apart', () => {
    const spec = respawnSpec({ slots: 16, spacingM: 1.5 })
    const base = spawn(2, 1, -3)
    const slots: SpawnPoint[] = []
    for (let i = 0; i < 12; i++) slots.push(respawnSlot(base, i, spec, spawn(0, 0, 0)))
    let sumX = 0
    let sumY = 0
    let sumZ = 0
    for (const slot of slots) {
      assert.equal(slot.t.y, base.t.y)
      assert.deepEqual(slot.facing, base.facing)
      sumX += slot.t.x
      sumY += slot.t.y
      sumZ += slot.t.z
    }
    assert.ok(Math.abs(sumX / 12 - base.t.x) < 1e-9)
    assert.ok(Math.abs(sumY / 12 - base.t.y) < 1e-9)
    assert.ok(Math.abs(sumZ / 12 - base.t.z) < 1e-9)
    for (let i = 0; i < slots.length; i++) {
      for (let j = i + 1; j < slots.length; j++) {
        const d = distance(slots[i], slots[j])
        assert.ok(d >= spec.spacingM - 1e-9, `slots ${i} and ${j} are only ${d}m apart`)
      }
    }
    assert.ok(Math.abs(distance(slots[0], slots[1]) - spec.spacingM) < 1e-9)
    assert.ok(Math.abs(distance(slots[0], slots[4]) - spec.spacingM) < 1e-9)
    const wrapped = respawnSlot(base, 12, spec, spawn(0, 0, 0))
    assert.ok(distance(wrapped, slots[0]) < 1e-9)
  })

  it('cycles slots round-robin per anchor independently', () => {
    const spec = respawnSpec({ slots: 16 })
    const st = newRespawnState(1, 2)
    for (let i = 0; i < 12; i++) assert.equal(nextSlot(st, 0, spec), i)
    assert.equal(st.slotCursor[0], 0)
    assert.equal(nextSlot(st, 0, spec), 0)
    assert.equal(st.slotCursor[0], 1)
    assert.equal(nextSlot(st, 1, spec), 0)
    assert.equal(nextSlot(st, 1, spec), 1)
    assert.equal(st.slotCursor[0], 1)
    assert.equal(nextSlot(st, 0, spec), 1)
  })
})

function routeBytes(st: RouteState): Uint8Array {
  const w = new SnapWriter()
  writeRoute(w, st)
  return w.bytes().slice()
}

function respawnBytes(st: RespawnState): Uint8Array {
  const w = new SnapWriter()
  writeRespawn(w, st)
  return w.bytes().slice()
}

describe('season route snapshots', () => {
  it('round-trips route state byte-identically', () => {
    const st = newRouteState(3)
    st.stage.set([-1, 0, 3])
    st.lap.set([0, 1, 2])
    st.finished.set([0, 0, 1])
    const bytes = routeBytes(st)
    const copy = newRouteState(3)
    readRoute(new SnapReader(bytes), copy)
    assert.deepEqual(routeBytes(copy), bytes)
    assert.deepEqual([...copy.stage], [-1, 0, 3])
    assert.deepEqual([...copy.lap], [0, 1, 2])
    assert.deepEqual([...copy.finished], [0, 0, 1])
  })

  it('round-trips respawn state byte-identically', () => {
    const spec = respawnSpec({ waitTicks: 90, protectTicks: 30 })
    const st = newRespawnState(3, 4)
    scheduleRespawn(spec, st, 0, 50)
    scheduleRespawn(spec, st, 2, 900)
    st.slotCursor.set([0, 1, 11, 7])
    const bytes = respawnBytes(st)
    const copy = newRespawnState(3, 4)
    readRespawn(new SnapReader(bytes), copy)
    assert.deepEqual(respawnBytes(copy), bytes)
    assert.deepEqual([...copy.waitUntil], [...st.waitUntil])
    assert.deepEqual([...copy.protectUntil], [...st.protectUntil])
    assert.deepEqual([...copy.slotCursor], [0, 1, 11, 7])
  })
})
