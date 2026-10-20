// Flat-floor scenario: N capsules on a ground cuboid, driven by S1-style u32 codes.
// It drives the M1 determinism proof and the smoke.
import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { BodyId, RapierModule } from '@gamesaloon/rollback-rapier'
import { FiestaWorld } from '../world.ts'
import type { SimSystem, WorldCtx } from '../world.ts'
import { G, groups } from '../groups.ts'
import { refuse } from '../refusal.ts'

export interface FlatFloorOptions { players: number; seed: number }

const MOVE_SPEED = 8
const JUMP_VY = 7.5
const JUMP_BIT = 1 << 16

export function createFlatFloorSystem(opts: FlatFloorOptions): SimSystem<number> {
  const players = opts.players
  // Ids are deterministic because bodies are only created in init; RigidBody objects are never kept.
  const bodies: BodyId[] = []
  return {
    name: 'flatFloor',
    init(ctx: WorldCtx<number>): void {
      const R = ctx.R
      const physics = ctx.physics
      physics.createBody(R.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0), [
        R.ColliderDesc.cuboid(50, 0.5, 50).setCollisionGroups(groups(G.STATIC, G.CHAR)),
      ])
      for (let i = 0; i < players; i++) {
        const desc = R.RigidBodyDesc.dynamic()
          .setTranslation((i - (players - 1) / 2) * 2, 0.86, 0)
          .setAdditionalMass(60)
          .enabledRotations(false, false, false)
          .setCanSleep(false)
        const col = R.ColliderDesc.capsule(0.45, 0.4)
          .setFriction(0)
          .setRestitution(0)
          .setCollisionGroups(groups(G.CHAR, G.STATIC | G.CHAR))
        bodies.push(physics.createBody(desc, [col]))
      }
    },
    preStep(ctx: WorldCtx<number>, inputs: readonly number[]): void {
      for (let i = 0; i < players; i++) {
        const code = inputs[i] >>> 0
        const qx = Math.min(code & 255, 254)
        const qz = Math.min((code >>> 8) & 255, 254)
        const rb = ctx.physics.body(bodies[i])
        const v = rb.linvel()
        let vy = v.y
        if ((code & JUMP_BIT) !== 0 && rb.translation().y < 0.9 && Math.abs(v.y) <= 0.1) vy = JUMP_VY
        rb.setLinvel({ x: (qx - 127) / 127 * MOVE_SPEED, y: vy, z: (qz - 127) / 127 * MOVE_SPEED }, true)
      }
    },
    postStep(): void {},
    snapshot(w: SnapWriter): void {
      w.u32(players)
    },
    restore(r: SnapReader): void {
      const got = r.u32()
      if (got !== players) refuse('flatFloor', 'snapshot/players', `expected ${players}, got ${got}; restore into a flat-floor world with the same player count`)
    },
  }
}

function mix32(h: number): number {
  h ^= h >>> 16
  h = Math.imul(h, 0x85ebca6b)
  h ^= h >>> 13
  h = Math.imul(h, 0xc2b2ae35)
  h ^= h >>> 16
  return h >>> 0
}

// Scripted input code for a player; constant within each 30-tick window.
export function flatFloorScript(seed: number, player: number, tick: number): number {
  const h = mix32(seed ^ Math.imul(player + 1, 0x9e3779b1) ^ Math.imul(Math.floor(tick / 30) + 1, 0x85ebca6b))
  const qx = Math.min(h & 255, 254)
  const qz = Math.min((h >>> 8) & 255, 254)
  const jump = ((h >>> 16) & 7) === 0 ? JUMP_BIT : 0
  return (qx | qz << 8 | jump) >>> 0
}

export function createFlatFloorWorld(R: RapierModule, opts: FlatFloorOptions): FiestaWorld<number> {
  return new FiestaWorld<number>(R, { playerCount: opts.players, systems: [createFlatFloorSystem(opts)] })
}
