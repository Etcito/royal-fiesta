import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { describe, it } from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { CAPSULE, CHARACTER_ASSET, parseCharacterCapsule } from '../src/character/capsule.ts'
import { CHAR } from '../src/character/constants.ts'
import { characterBody } from '../src/character/system.ts'
import { isRefusal } from '../src/refusal.ts'

// The character body is penguin.body's saved capsule (SDF Modeler's Save asset writes it), never a constant of the sim.
const saved = JSON.parse(readFileSync(new URL(`../../../${CHARACTER_ASSET}`, import.meta.url), 'utf8')) as { collision: Record<string, unknown>[] }
const withCollision = (collision: unknown): unknown => ({ ...saved, collision })
const CAP = { shape: 'capsule', t: [0, 0, 0], r: [0, 0, 0, 1], radius: 0.4, halfHeight: 0.45 }

function refusedAt(asset: unknown, path: string): void {
  assert.throws(() => parseCharacterCapsule(asset, 'penguin'), (e: unknown) => isRefusal(e) && e.path === path, path)
}

describe('character capsule', () => {
  it('is the capsule penguin.body saved', () => {
    const c = saved.collision[0]!
    assert.equal(saved.collision.length, 1)
    assert.equal(CAPSULE.radius, c.radius)
    assert.equal(CAPSULE.halfHeight, c.halfHeight)
    assert.equal(CAPSULE.stand, (c.radius as number) + (c.halfHeight as number))
    assert.ok(!('radius' in CHAR) && !('halfHeight' in CHAR), 'CHAR keeps only tuning values')
  })

  it('is the body collider of every seat', async () => {
    const R = await initRapier()
    const world = new R.World({ x: 0, y: 0, z: 0 })
    const { body, colliders } = characterBody(R, 0)
    const col = world.createCollider(colliders[0]!, world.createRigidBody(body))
    assert.equal(col.shape.type, R.ShapeType.Capsule)
    assert.ok(Math.abs(col.halfHeight() - CAPSULE.halfHeight) < 1e-6)
    assert.ok(Math.abs(col.radius() - CAPSULE.radius) < 1e-6)
    world.free()
  })

  it('follows a resized capsule', () => {
    const c = parseCharacterCapsule(withCollision([{ ...CAP, radius: 0.35, halfHeight: 0.6 }]), 'penguin')
    assert.deepEqual({ ...c }, { radius: 0.35, halfHeight: 0.6, stand: 0.95 })
  })

  it('refuses a character that is not one upright capsule at the origin', () => {
    refusedAt(withCollision([]), 'penguin/collision')
    refusedAt(withCollision([CAP, CAP]), 'penguin/collision')
    refusedAt(withCollision([{ shape: 'ball', t: [0, 0, 0], r: [0, 0, 0, 1], radius: 0.5 }]), 'penguin/collision/0')
    refusedAt(withCollision([{ shape: 'cuboid', t: [0, 0, 0], r: [0, 0, 0, 1], halfExtents: [0.4, 0.85, 0.4] }]), 'penguin/collision/0')
    refusedAt(withCollision([{ ...CAP, t: [0, 0.2, 0] }]), 'penguin/collision/0/t')
    refusedAt(withCollision([{ ...CAP, r: [0, 0, 0.7071068, 0.7071068] }]), 'penguin/collision/0/r')
    refusedAt(withCollision([{ ...CAP, radius: 0 }]), 'penguin/collision/0/radius')
    refusedAt(withCollision([{ ...CAP, halfHeight: -1 }]), 'penguin/collision/0/halfHeight')
    refusedAt(withCollision(undefined), 'penguin/collision')
    refusedAt({ ...saved, category: 'prop' }, 'penguin/category')
  })
})
