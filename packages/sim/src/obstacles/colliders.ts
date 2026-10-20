import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ColliderSpec } from '../course.ts'
import { refuse } from '../refusal.ts'

// Shape and local pose only: groups, friction and restitution belong to the obstacle system.
export function colliderDesc(R: RapierModule, c: ColliderSpec): InstanceType<RapierModule['ColliderDesc']> {
  let d: InstanceType<RapierModule['ColliderDesc']>
  switch (c.shape) {
    case 'cuboid':
      d = R.ColliderDesc.cuboid(c.half.x, c.half.y, c.half.z)
      break
    case 'roundCuboid':
      d = R.ColliderDesc.roundCuboid(c.half.x, c.half.y, c.half.z, c.border)
      break
    case 'ball':
      d = R.ColliderDesc.ball(c.radius)
      break
    case 'capsule':
      d = R.ColliderDesc.capsule(c.halfHeight, c.radius)
      break
    case 'cylinder':
      d = R.ColliderDesc.cylinder(c.halfHeight, c.radius)
      break
    case 'cone':
      d = R.ColliderDesc.cone(c.halfHeight, c.radius)
      break
    default: {
      const bad: never = c
      return refuse('obstacles', 'collider/shape', `unknown shape '${(bad as { shape: unknown }).shape}'; primitive colliders only`)
    }
  }
  return d.setTranslation(c.t.x, c.t.y, c.t.z).setRotation(c.r)
}
