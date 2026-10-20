import assert from 'node:assert/strict'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { createFlatFloorWorld, flatFloorScript } from '../src/scenarios/flatFloor.ts'
import type { FiestaWorld } from '../src/world.ts'
import { isRefusal } from '../src/refusal.ts'

const R = await initRapier()

function stepScript(world: FiestaWorld<number>, seed: number, toTick: number): void {
  const inputs = new Array<number>(world.playerCount)
  while (world.tick < toTick) {
    for (let p = 0; p < inputs.length; p++) inputs[p] = flatFloorScript(seed, p, world.tick)
    world.step(inputs)
  }
}

test('flatFloorScript is constant within a 30-tick window and in range', () => {
  for (let p = 0; p < 8; p++) {
    for (let w = 0; w < 40; w++) {
      const first = flatFloorScript(7, p, w * 30)
      assert.ok((first & 255) <= 254 && ((first >>> 8) & 255) <= 254)
      for (let k = 1; k < 30; k++) assert.equal(flatFloorScript(7, p, w * 30 + k), first)
    }
  }
})

test('two 8-player worlds stay bit-identical over 600 ticks', () => {
  const a = createFlatFloorWorld(R, { players: 8, seed: 7 })
  const b = createFlatFloorWorld(R, { players: 8, seed: 7 })
  try {
    for (let t = 60; t <= 600; t += 60) {
      stepScript(a, 7, t)
      stepScript(b, 7, t)
      assert.equal(a.stateHash(), b.stateHash(), `hash at tick ${t}`)
    }
    assert.deepEqual(a.takeSnapshotBytes(), b.takeSnapshotBytes())
  } finally {
    a.free()
    b.free()
  }
})

test('capsules stand on the floor and move', () => {
  const world = createFlatFloorWorld(R, { players: 8, seed: 7 })
  try {
    const start: { x: number; z: number }[] = []
    // The ground is created first, then the capsules in player order.
    const capsules = world.physics.ids().slice(1)
    assert.equal(capsules.length, 8)
    for (let i = 0; i < 8; i++) start.push(world.physics.body(capsules[i]).translation())
    stepScript(world, 7, 120)
    let moved = false
    for (let i = 0; i < 8; i++) {
      const t = world.physics.body(capsules[i]).translation()
      assert.ok(t.y > 0, `capsule ${i} fell through: y=${t.y}`)
      const dx = t.x - start[i].x
      const dz = t.z - start[i].z
      if (Math.sqrt(dx * dx + dz * dz) > 1) moved = true
    }
    assert.ok(moved, 'no capsule moved more than 1 m in xz')
  } finally {
    world.free()
  }
})

test('snapshot at 300, restore and rerun to 400 gives the same hash', () => {
  const world = createFlatFloorWorld(R, { players: 8, seed: 7 })
  try {
    stepScript(world, 7, 300)
    const snap = world.takeSnapshotBytes()
    stepScript(world, 7, 400)
    const h1 = world.stateHash()
    world.restoreSnapshotBytes(snap)
    assert.equal(world.tick, 300)
    stepScript(world, 7, 400)
    assert.equal(world.stateHash(), h1)
  } finally {
    world.free()
  }
})

test('a 3-player world refuses an 8-player snapshot', () => {
  const a = createFlatFloorWorld(R, { players: 8, seed: 7 })
  const b = createFlatFloorWorld(R, { players: 3, seed: 7 })
  try {
    const snap = a.takeSnapshotBytes()
    assert.throws(() => b.restoreSnapshotBytes(snap), (e: unknown) => isRefusal(e))
  } finally {
    a.free()
    b.free()
  }
})
