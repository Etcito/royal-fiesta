import type { BodyId } from '@gamesaloon/rollback-rapier'
import type { ColliderSpec } from '../course.ts'
import { PI } from '../detmath.ts'
import { G, groups } from '../groups.ts'
import type { BodySpec, MechItem } from '../mechanismSpec.ts'
import { colliderDesc } from '../obstacles/colliders.ts'
import { refuse } from '../refusal.ts'
import { add3, pose as newPose, quatMul, quatNormalize, quatRotate } from '../vec.ts'
import type { Pose } from '../vec.ts'
import type { WorldCtx } from '../world.ts'

const COLLIDE_WITH = G.CHAR | G.DEBRIS | G.PROBE | G.MOVING | G.STATIC

// Scratch pose for createBody; never part of sim state.
const scratchPose: Pose = newPose()

// Volume in m3, so mass = density * sum of the body's collider volumes.
export function colliderVolume(c: ColliderSpec): number {
  switch (c.shape) {
    case 'cuboid':
      return 8 * c.half.x * c.half.y * c.half.z
    case 'roundCuboid': {
      // Minkowski sum of the inner box and a ball of radius `border`:
      // box + face slabs + quarter-cylinder edges + eighth-ball corners.
      const a = c.half.x, b = c.half.y, d = c.half.z, r = c.border
      return 8 * a * b * d + 8 * r * (a * b + b * d + d * a) + 2 * PI * r * r * (a + b + d) + (4 / 3) * PI * r * r * r
    }
    case 'ball':
      return (4 / 3) * PI * c.radius * c.radius * c.radius
    case 'capsule':
      return PI * c.radius * c.radius * (2 * c.halfHeight) + (4 / 3) * PI * c.radius * c.radius * c.radius
    case 'cylinder':
      return PI * c.radius * c.radius * (2 * c.halfHeight)
    case 'cone':
      return (PI * c.radius * c.radius * (2 * c.halfHeight)) / 3
    default: {
      const bad: never = c
      return refuse('mechanisms', 'collider/shape', `unknown shape '${(bad as { shape: unknown }).shape}'; primitive colliders only`)
    }
  }
}

// One Rapier body for a mechanism body, posed at itemPose ∘ rest.
// `rest` is item-local: the S12 body pose relative to the asset origin, with
// the item scale already baked into it and into the colliders by the loader.
// `itemPose` is the item's course placement (item.t, item.r), so the composed
// pose is in course space. `type` is fixed here and never changed later: a
// kinematic body is kinematicPositionBased for its whole life.
export function createBody(ctx: WorldCtx<unknown>, item: MechItem, b: BodySpec, itemPose: Pose): BodyId {
  const where = `mechanisms/items/${item.id}/bodies/${b.id}`
  if (!(b.density > 0) || !Number.isFinite(b.density)) {
    refuse('mechanisms', where, `density ${b.density} is not a positive finite kg/m3; pass density > 0`)
  }
  const R = ctx.R
  let desc: InstanceType<typeof R.RigidBodyDesc>
  switch (b.type) {
    case 'dynamic':
      desc = R.RigidBodyDesc.dynamic()
      break
    case 'kinematic':
      desc = R.RigidBodyDesc.kinematicPositionBased()
      break
    case 'fixed':
      desc = R.RigidBodyDesc.fixed()
      break
    default: {
      const bad: never = b.type
      return refuse('mechanisms', where, `unknown body type '${bad as string}'; use dynamic, kinematic or fixed`)
    }
  }
  const p = scratchPose
  quatRotate(itemPose.r, b.rest.t, p.t)
  add3(itemPose.t, p.t, p.t)
  quatNormalize(quatMul(itemPose.r, b.rest.r, p.r), p.r)
  desc.setTranslation(p.t.x, p.t.y, p.t.z)
  desc.setRotation({ x: p.r.x, y: p.r.y, z: p.r.z, w: p.r.w })
  desc.setLinearDamping(b.linearDamping)
  desc.setAngularDamping(b.angularDamping)
  desc.setGravityScale(b.gravityScale)
  desc.setCcdEnabled(b.ccd)
  const word = groups(b.type === 'fixed' ? G.STATIC : G.MOVING, COLLIDE_WITH)
  const cols = []
  for (let k = 0; k < b.colliders.length; k++) {
    // setDensity, never setMass: the mass follows the shapes (density * volume).
    cols.push(colliderDesc(R, b.colliders[k])
      .setDensity(b.density)
      .setFriction(b.friction)
      .setRestitution(b.restitution)
      .setCollisionGroups(word))
  }
  return ctx.physics.createBody(desc, cols)
}
