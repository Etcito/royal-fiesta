import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { BodyId, RapierModule } from '@gamesaloon/rollback-rapier'
import type { Motion, SpawnPoint } from '../course.ts'
import { G, groups } from '../groups.ts'
import { BTN, decodeInput, encodeInput, neutralInput } from '../input.ts'
import type { PlayerInput } from '../input.ts'
import { isKinematic } from '../obstacles/motion.ts'
import type { ObstacleSystem } from '../obstacles/system.ts'
import { refuse } from '../refusal.ts'
import type { Vec3 } from '../vec.ts'
import type { SimSystem, WorldCtx } from '../world.ts'
import { CHAR, CharMode } from './constants.ts'
import { approach2, turnFacing } from './controller.ts'

export interface CharacterOptions {
  playerCount: number
  // Domain worlds spawn the seat bodies themselves; init then only resets the players.
  externalBodies?: boolean
}

export interface CharacterBodyDescs {
  body: InstanceType<RapierModule['RigidBodyDesc']>
  colliders: InstanceType<RapierModule['ColliderDesc']>[]
}

export interface CharState {
  pos: Vec3
  vel: Vec3
  facing: { x: number; z: number }
  mode: number
  grounded: boolean
  groundObstacle: number
  knockbacks: number
  teleportTick: number
}

const CHAR_GROUPS = groups(G.CHAR, G.STATIC | G.MOVING | G.CHAR)
const PROBE_GROUPS = groups(G.PROBE, G.STATIC | G.MOVING)
const STAND = CHAR.halfHeight + CHAR.radius
const NO_OVERRIDE = -1
const JUMP_BIT = BTN.JUMP >>> 16
const DIVE_BIT = BTN.DIVE >>> 16
const GRAB_BIT = BTN.GRAB >>> 16

type Collider = InstanceType<RapierModule['Collider']>
type Manifold = InstanceType<RapierModule['TempContactManifold']>

// Scratch only; never part of sim state.
const scratchIn: PlayerInput = neutralInput()
const scratchH = { x: 0, z: 0 }
const scratchV = { x: 0, y: 0, z: 0 }
const scratchBase = { x: 0, y: 0, z: 0 }
const scratchHit = { x: 0, y: 0, z: 0 }
const scratchN = { x: 0, y: 0, z: 0 }
const scratchPt = { x: 0, y: 0, z: 0 }
const scratchObsV = { x: 0, y: 0, z: 0 }
let scratchRay: InstanceType<RapierModule['Ray']> | null = null

// The one character body: FiestaWorld's init and a domain entity recipe both call this, so a
// domain seat is byte-for-byte the same body as a full-mesh seat.
export function characterBody(R: RapierModule, parkSlot: number): CharacterBodyDescs {
  const body = R.RigidBodyDesc.dynamic()
    .setTranslation(CHAR.parkOrigin.x + parkSlot * CHAR.parkStep, CHAR.parkOrigin.y, CHAR.parkOrigin.z)
    .lockRotations()
    .setCanSleep(false)
    .setCcdEnabled(false)
    .setGravityScale(0)
    .setAdditionalMass(CHAR.mass)
  // Density 0 so the body mass is exactly CHAR.mass.
  const collider = R.ColliderDesc.capsule(CHAR.halfHeight, CHAR.radius)
    .setDensity(0)
    .setFriction(0)
    .setFrictionCombineRule(R.CoefficientCombineRule.Min)
    .setRestitution(0)
    .setCollisionGroups(0)
  return { body, colliders: [collider] }
}

export class CharacterSystem implements SimSystem<PlayerInput> {
  readonly name = 'characters'
  readonly playerCount: number
  readonly #externalBodies: boolean
  // Created once in init, so the ids are the same in every world with the same systems.
  #bodies: BodyId[] = []
  // Per-player SoA state, all of it snapshotted.
  readonly #mode: Uint8Array
  readonly #timer: Int32Array
  readonly #coyote: Uint8Array
  readonly #jumpBuffer: Uint8Array
  readonly #prevButtons: Uint8Array
  readonly #diveUsed: Uint8Array
  readonly #grabTarget: Int8Array
  readonly #grabTicks: Uint16Array
  readonly #grabCooldown: Uint16Array
  readonly #facingX: Float64Array
  readonly #facingZ: Float64Array
  readonly #grounded: Uint8Array
  readonly #groundObstacle: Int16Array
  readonly #knockbacks: Uint16Array
  readonly #teleportTick: Int32Array
  readonly #frozen: Uint8Array
  readonly #parked: Uint8Array
  // Consumed within the tick it is used, so never snapshotted.
  readonly #override: Int32Array
  // Velocity set before the physics step, read by the bumps in the same tick: Rapier's contact
  // solve has already absorbed a hit in linvel by postStep. Never snapshotted.
  readonly #preVel: Float64Array
  readonly #pos: Float64Array
  // postStep contact scratch, valid only inside one postStep.
  #pairCount = 0
  #pairObs: number[] = []
  #pairCol: Collider[] = []
  #postCtx: WorldCtx<PlayerInput> | null = null
  #postObs: ObstacleSystem | null = null
  #bumpP = 0
  #bumpObs = 0
  #bumped = false

  constructor(opts: CharacterOptions) {
    const n = opts.playerCount
    this.playerCount = n
    this.#externalBodies = opts.externalBodies === true
    this.#bodies = new Array<BodyId>(n).fill(-1)
    this.#mode = new Uint8Array(n)
    this.#timer = new Int32Array(n)
    this.#coyote = new Uint8Array(n)
    this.#jumpBuffer = new Uint8Array(n)
    this.#prevButtons = new Uint8Array(n)
    this.#diveUsed = new Uint8Array(n)
    this.#grabTarget = new Int8Array(n)
    this.#grabTicks = new Uint16Array(n)
    this.#grabCooldown = new Uint16Array(n)
    this.#facingX = new Float64Array(n)
    this.#facingZ = new Float64Array(n)
    this.#grounded = new Uint8Array(n)
    this.#groundObstacle = new Int16Array(n)
    this.#knockbacks = new Uint16Array(n)
    this.#teleportTick = new Int32Array(n)
    this.#frozen = new Uint8Array(n)
    this.#parked = new Uint8Array(n)
    this.#override = new Int32Array(n)
    this.#preVel = new Float64Array(n * 3)
    this.#pos = new Float64Array(n * 3)
  }

  init(ctx: WorldCtx<PlayerInput>): void {
    if (ctx.playerCount !== this.playerCount) {
      refuse('characters', 'playerCount', `system has ${this.playerCount}, world has ${ctx.playerCount}; pass the world's player count`)
    }
    const R = ctx.R
    const bodies = this.#bodies
    for (let p = 0; p < this.playerCount; p++) {
      if (!this.#externalBodies) {
        const recipe = characterBody(R, p)
        bodies[p] = ctx.physics.createBody(recipe.body, recipe.colliders)
      }
      this.#resetPlayer(p)
    }
  }

  // The caller owns the bodies (a domain world); this only replaces the ids it will step.
  // The ids are copied in place, so the caller array may be reused and no allocation happens here.
  bindBodies(ids: ArrayLike<BodyId>): void {
    if (ids.length !== this.playerCount) {
      refuse('characters', 'bindBodies', `${ids.length} ids for ${this.playerCount} players; pass one body id per player`)
    }
    const bodies = this.#bodies
    for (let p = 0; p < this.playerCount; p++) {
      const id = ids[p]
      if (!Number.isInteger(id) || id < 0) {
        refuse('characters', `bindBodies[${p}]`, `got ${id}; pass a non-negative integer body id`)
      }
      bodies[p] = id
    }
  }

  #resetPlayer(p: number): void {
    this.#mode[p] = CharMode.parked
    this.#timer[p] = 0
    this.#coyote[p] = 0
    this.#jumpBuffer[p] = 0
    this.#prevButtons[p] = 0
    this.#diveUsed[p] = 0
    this.#grabTarget[p] = -1
    this.#grabTicks[p] = 0
    this.#grabCooldown[p] = 0
    this.#facingX[p] = 0
    this.#facingZ[p] = 1
    this.#grounded[p] = 0
    this.#groundObstacle[p] = -1
    this.#teleportTick[p] = -1
    this.#frozen[p] = 0
    this.#parked[p] = 1
    this.#override[p] = NO_OVERRIDE
  }

  #check(p: number, what: string): void {
    if (!Number.isInteger(p) || p < 0 || p >= this.playerCount) {
      refuse('characters', `${what}(${p})`, `player index out of range 0..${this.playerCount - 1}; pass a valid player index`)
    }
  }

  #teleport(ctx: WorldCtx<PlayerInput>, p: number, x: number, y: number, z: number, live: boolean): void {
    const rb = ctx.physics.body(this.#bodies[p])
    rb.setTranslation({ x, y, z }, true)
    rb.setLinvel({ x: 0, y: 0, z: 0 }, true)
    rb.setGravityScale(live ? 1 : 0, true)
    rb.collider(0).setCollisionGroups(live ? CHAR_GROUPS : 0)
    this.#grounded[p] = 0
    this.#groundObstacle[p] = -1
    this.#coyote[p] = 0
    this.#jumpBuffer[p] = 0
    this.#teleportTick[p] = ctx.tick
  }

  place(ctx: WorldCtx<PlayerInput>, p: number, at: SpawnPoint): void {
    this.#check(p, 'place')
    this.#teleport(ctx, p, at.t.x, at.t.y + STAND + 0.01, at.t.z, true)
    this.#facingX[p] = at.facing.x
    this.#facingZ[p] = at.facing.z
    this.#mode[p] = CharMode.air
    this.#parked[p] = 0
  }

  park(ctx: WorldCtx<PlayerInput>, p: number): void {
    this.#check(p, 'park')
    const o = CHAR.parkOrigin
    this.#teleport(ctx, p, o.x + p * CHAR.parkStep, o.y, o.z, false)
    this.#mode[p] = CharMode.parked
    this.#parked[p] = 1
  }

  freeze(p: number, frozen: boolean): void {
    this.#check(p, 'freeze')
    this.#frozen[p] = frozen ? 1 : 0
  }

  override(p: number, code: number): void {
    this.#check(p, 'override')
    // Bits 19-31 are ignored on decode, so masking keeps the code non-negative.
    this.#override[p] = code & 0x7ffff
  }

  isParked(p: number): boolean {
    this.#check(p, 'isParked')
    return this.#parked[p] !== 0
  }

  state(ctx: WorldCtx<PlayerInput>, p: number, out: CharState): CharState {
    this.#check(p, 'state')
    const rb = ctx.physics.body(this.#bodies[p])
    const t = rb.translation()
    const v = rb.linvel()
    out.pos.x = t.x
    out.pos.y = t.y
    out.pos.z = t.z
    out.vel.x = v.x
    out.vel.y = v.y
    out.vel.z = v.z
    out.facing.x = this.#facingX[p]
    out.facing.z = this.#facingZ[p]
    out.mode = this.#mode[p]
    out.grounded = this.#grounded[p] !== 0
    out.groundObstacle = this.#groundObstacle[p]
    out.knockbacks = this.#knockbacks[p]
    out.teleportTick = this.#teleportTick[p]
    return out
  }

  resetKnockbacks(p: number): void {
    this.#check(p, 'resetKnockbacks')
    this.#knockbacks[p] = 0
  }

  readPositions(ctx: WorldCtx<PlayerInput>, out: Float64Array): void {
    for (let p = 0; p < this.playerCount; p++) {
      const t = ctx.physics.body(this.#bodies[p]).translation()
      out[p * 3] = t.x
      out[p * 3 + 1] = t.y
      out[p * 3 + 2] = t.z
    }
  }

  preStep(ctx: WorldCtx<PlayerInput>, inputs: readonly PlayerInput[]): void {
    const world = ctx.physics.world
    const dt = ctx.dt
    const obstacles = ctx.hasSystem('obstacles') ? ctx.system<ObstacleSystem>('obstacles') : null
    if (scratchRay === null) scratchRay = new ctx.R.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: -1, z: 0 })
    const ray = scratchRay
    for (let p = 0; p < this.playerCount; p++) {
      if (this.#parked[p] !== 0) {
        this.#override[p] = NO_OVERRIDE
        continue
      }
      const frozen = this.#frozen[p] !== 0
      const ov = this.#override[p]
      this.#override[p] = NO_OVERRIDE
      // Frozen players ignore input entirely, override included.
      const code = frozen ? 0 : ov !== NO_OVERRIDE ? ov : encodeInput(inputs[p])
      const inp = decodeInput(code, scratchIn)
      const buttons = (code >>> 16) & 7
      const pressed = buttons & ~this.#prevButtons[p]
      this.#prevButtons[p] = buttons
      let mx = frozen ? 0 : inp.moveX
      let mz = frozen ? 0 : inp.moveZ
      const mlen = Math.sqrt(mx * mx + mz * mz)
      if (mlen > 1) {
        mx /= mlen
        mz /= mlen
      }

      const rb = ctx.physics.body(this.#bodies[p])
      const t = rb.translation()
      const v = rb.linvel()
      let vy = v.y
      ray.origin.x = t.x
      ray.origin.y = t.y
      ray.origin.z = t.z
      const reach = STAND + CHAR.groundProbe + Math.max(0, -vy) * dt
      const hit = world.castRayAndGetNormal(ray, reach, true, undefined, PROBE_GROUPS)
      const grounded = hit !== null && hit.normal.y >= CHAR.groundMinNy
      // The probe reaches further when falling; a pad fires only on actual contact.
      const touching = grounded && hit.timeOfImpact <= STAND + CHAR.groundProbe
      this.#grounded[p] = grounded ? 1 : 0
      // Riding: a kinematic obstacle or a conveyor carries the character at the hit point.
      const base = scratchBase
      base.x = 0
      base.y = 0
      base.z = 0
      let gi = -1
      let motion: Motion | null = null
      let riding = false
      if (grounded && obstacles !== null) {
        gi = obstacles.obstacleOfCollider(ctx, hit.collider.handle)
        motion = gi >= 0 ? obstacles.spec(gi).motion : null
        if (motion !== null && (isKinematic(motion.kind) || motion.kind === 'conveyor')) {
          riding = isKinematic(motion.kind)
          scratchHit.x = t.x
          scratchHit.y = t.y - hit.timeOfImpact
          scratchHit.z = t.z
          obstacles.pointVelocity(ctx, gi, scratchHit, base)
        }
      }
      this.#groundObstacle[p] = gi

      // Mode machine; ground/air is re-derived each tick from the probe.
      const free: number = grounded ? CharMode.ground : CharMode.air
      let mode: number = this.#mode[p]
      let timer = this.#timer[p]
      if (this.#grabCooldown[p] > 0) this.#grabCooldown[p]--
      if (frozen) {
        mode = CharMode.frozen
        timer = 0
      } else if (mode === CharMode.stunned || mode === CharMode.diveRecover) {
        if (--timer <= 0) {
          timer = 0
          mode = free
        }
      } else if (mode === CharMode.dive) {
        // Only when not rising, so a dive from the ground is not cut on its first tick.
        if (grounded && vy <= 0) {
          mode = CharMode.diveRecover
          timer = CHAR.diveRecoverTicks
        }
      } else if (mode === CharMode.grabbing) {
        if ((buttons & GRAB_BIT) === 0 || ++this.#grabTicks[p] >= CHAR.grabMaxTicks) mode = free
      } else {
        mode = free
      }

      const steer = mode === CharMode.ground || mode === CharMode.air || mode === CharMode.grabbing
      let vx = v.x
      let vz = v.z
      if (frozen) {
        vx = 0
        vz = 0
      } else if (steer) {
        const hasMove = mlen > 0
        const rate = !grounded ? CHAR.airAccel : hasMove ? CHAR.groundAccel : CHAR.groundBrake
        approach2(v.x, v.z, base.x + mx * CHAR.maxRun, base.z + mz * CHAR.maxRun, rate * dt, scratchH)
        vx = scratchH.x
        vz = scratchH.z
        turnFacing(this.#facingX[p], this.#facingZ[p], mx, mz, CHAR.turnRate * dt, scratchH)
        this.#facingX[p] = scratchH.x
        this.#facingZ[p] = scratchH.z
      } else if (mode === CharMode.diveRecover) {
        approach2(v.x, v.z, base.x, base.z, CHAR.diveRecoverBrake * dt, scratchH)
        vx = scratchH.x
        vz = scratchH.z
      }

      // Coyote is checked before it decays, so it grants coyoteTicks airborne ticks.
      if (grounded) this.#coyote[p] = CHAR.coyoteTicks
      if ((pressed & JUMP_BIT) !== 0) this.#jumpBuffer[p] = CHAR.jumpBufferTicks
      else if (this.#jumpBuffer[p] > 0) this.#jumpBuffer[p]--
      if (steer && (grounded || this.#coyote[p] > 0) && this.#jumpBuffer[p] > 0) {
        vy = CHAR.jumpSpeed + base.y
        this.#coyote[p] = 0
        this.#jumpBuffer[p] = 0
        if (mode !== CharMode.grabbing) mode = CharMode.air
      } else {
        if (!grounded && this.#coyote[p] > 0) this.#coyote[p]--
        // Riding a platform that turns downward: follow it so the probe keeps contact.
        if (riding && steer && vy > base.y) vy = base.y
      }

      if ((mode === CharMode.ground || mode === CharMode.air) && (pressed & DIVE_BIT) !== 0 && this.#diveUsed[p] === 0) {
        const s = Math.max(Math.sqrt(vx * vx + vz * vz), CHAR.diveSpeed)
        vx = this.#facingX[p] * s
        vz = this.#facingZ[p] * s
        vy = grounded ? CHAR.diveUp : Math.max(vy, 0.6 * CHAR.diveUp)
        mode = CharMode.dive
        this.#diveUsed[p] = 1
      }
      if (grounded && mode !== CharMode.dive) this.#diveUsed[p] = 0

      if (motion !== null && motion.kind === 'bouncePad' && touching && !frozen && mode !== CharMode.stunned) {
        vy = motion.speed
        mode = CharMode.air
        timer = 0
      }

      if (mode !== CharMode.grabbing && this.#grabTarget[p] >= 0) this.#release(p)
      this.#mode[p] = mode
      this.#timer[p] = timer
      // Stunned: the knockback is left to physics.
      if (mode === CharMode.stunned) {
        vx = v.x
        vy = v.y
        vz = v.z
      } else {
        scratchV.x = vx
        scratchV.y = vy
        scratchV.z = vz
        rb.setLinvel(scratchV, true)
      }
      this.#preVel[p * 3] = vx
      this.#preVel[p * 3 + 1] = vy
      this.#preVel[p * 3 + 2] = vz
    }
    this.#grabPass(ctx)
  }

  #release(p: number): void {
    this.#grabTarget[p] = -1
    this.#grabTicks[p] = 0
    this.#grabCooldown[p] = CHAR.grabCooldownTicks
  }

  // After every player has steered, in index order, so the slow and the cap win over steering.
  #grabPass(ctx: WorldCtx<PlayerInput>): void {
    const pos = this.#pos
    this.readPositions(ctx, pos)
    for (let p = 0; p < this.playerCount; p++) {
      if (this.#parked[p] !== 0) continue
      let q = this.#grabTarget[p]
      if (q >= 0) {
        if (this.#parked[q] !== 0 || this.#dist(p, q) > CHAR.grabRange) {
          this.#release(p)
          this.#mode[p] = this.#grounded[p] !== 0 ? CharMode.ground : CharMode.air
          continue
        }
      } else {
        const mode = this.#mode[p]
        if ((mode !== CharMode.ground && mode !== CharMode.air) || this.#grabCooldown[p] > 0) continue
        if ((this.#prevButtons[p] & GRAB_BIT) === 0) continue
        q = this.#nearestInCone(p)
        if (q < 0) continue
        this.#grabTarget[p] = q
        this.#grabTicks[p] = 0
        this.#mode[p] = CharMode.grabbing
      }
      this.#scaleHorizontal(ctx, q, CHAR.grabSlow)
      const gv = this.#preVel
      const h = Math.sqrt(gv[p * 3] * gv[p * 3] + gv[p * 3 + 2] * gv[p * 3 + 2])
      if (h > CHAR.grabberMaxSpeed) this.#scaleHorizontal(ctx, p, CHAR.grabberMaxSpeed / h)
    }
  }

  #dist(p: number, q: number): number {
    const pos = this.#pos
    const dx = pos[q * 3] - pos[p * 3]
    const dy = pos[q * 3 + 1] - pos[p * 3 + 1]
    const dz = pos[q * 3 + 2] - pos[p * 3 + 2]
    return Math.sqrt(dx * dx + dy * dy + dz * dz)
  }

  // Nearest other non-parked player within grabRange and the facing cone; ties go to the lower index.
  #nearestInCone(p: number): number {
    const pos = this.#pos
    let best = -1
    let bestD: number = CHAR.grabRange
    for (let q = 0; q < this.playerCount; q++) {
      if (q === p || this.#parked[q] !== 0) continue
      const d = this.#dist(p, q)
      if (d > bestD || (best >= 0 && d === bestD)) continue
      const dx = pos[q * 3] - pos[p * 3]
      const dz = pos[q * 3 + 2] - pos[p * 3 + 2]
      const hl = Math.sqrt(dx * dx + dz * dz)
      if (hl === 0 || (this.#facingX[p] * dx + this.#facingZ[p] * dz) / hl < CHAR.grabConeDot) continue
      best = q
      bestD = d
    }
    return best
  }

  // Scales the velocity set this tick (horizontal part only) and sets it again.
  #scaleHorizontal(ctx: WorldCtx<PlayerInput>, p: number, k: number): void {
    const pv = this.#preVel
    pv[p * 3] *= k
    pv[p * 3 + 2] *= k
    scratchV.x = pv[p * 3]
    scratchV.y = pv[p * 3 + 1]
    scratchV.z = pv[p * 3 + 2]
    ctx.physics.body(this.#bodies[p]).setLinvel(scratchV, true)
  }

  postStep(ctx: WorldCtx<PlayerInput>): void {
    if (!ctx.hasSystem('obstacles')) return
    const obstacles = ctx.system<ObstacleSystem>('obstacles')
    const world = ctx.physics.world
    this.#postCtx = ctx
    this.#postObs = obstacles
    const obs = this.#pairObs
    const cols = this.#pairCol
    for (let p = 0; p < this.playerCount; p++) {
      if (this.#parked[p] !== 0) continue
      const rb = ctx.physics.body(this.#bodies[p])
      const col = rb.collider(0)
      this.#pairCount = 0
      world.contactPairsWith(col, this.#collect)
      // Insertion sort by obstacle index, then handle: the order never depends on the narrow phase.
      const n = this.#pairCount
      for (let a = 1; a < n; a++) {
        const oi = obs[a]
        const oc = cols[a]
        let b = a - 1
        while (b >= 0 && (obs[b] > oi || (obs[b] === oi && cols[b].handle > oc.handle))) {
          obs[b + 1] = obs[b]
          cols[b + 1] = cols[b]
          b--
        }
        obs[b + 1] = oi
        cols[b + 1] = oc
      }
      this.#bumpP = p
      this.#bumped = false
      for (let k = 0; k < n && !this.#bumped; k++) {
        this.#bumpObs = obs[k]
        world.contactPair(col, cols[k], this.#onManifold)
      }
      const gi = this.#groundObstacle[p]
      if (this.#grounded[p] !== 0 && gi >= 0 && gi < obstacles.count && obstacles.spec(gi).motion.kind === 'seesaw') {
        obstacles.addLoad(gi, rb.translation(), CHAR.mass)
      }
    }
    this.#postCtx = null
    this.#postObs = null
  }

  // Bound once, so contactPairsWith allocates no closure per tick.
  readonly #collect = (other: Collider): void => {
    const ctx = this.#postCtx
    const obstacles = this.#postObs
    if (ctx === null || obstacles === null || ((other.collisionGroups() >>> 16) & G.MOVING) === 0) return
    const i = obstacles.obstacleOfCollider(ctx, other.handle)
    if (i < 0) return
    this.#pairObs[this.#pairCount] = i
    this.#pairCol[this.#pairCount] = other
    this.#pairCount++
  }

  readonly #onManifold = (m: Manifold, flipped: boolean): void => {
    const ctx = this.#postCtx
    const obstacles = this.#postObs
    if (this.#bumped || ctx === null || obstacles === null) return
    const p = this.#bumpP
    // The manifold normal points out of its first collider: orient it from the obstacle to the character.
    const s = flipped ? 1 : -1
    m.normal(scratchN)
    const nx = scratchN.x * s
    const ny = scratchN.y * s
    const nz = scratchN.z * s
    // A support contact (the floor under the character) never bumps: a rising platform carries.
    if (ny >= CHAR.groundMinNy) return
    const pv = this.#preVel
    const count = m.numSolverContacts()
    for (let k = 0; k < count; k++) {
      if (m.solverContactPoint(k, scratchPt) === null) continue
      const vo = obstacles.pointVelocity(ctx, this.#bumpObs, scratchPt, scratchObsV)
      // dot(v_obs - v_char, n) with v_char's part into the obstacle dropped: running or falling
      // into a slow obstacle is a collision, not a bump.
      const away = Math.max(0, pv[p * 3] * nx + pv[p * 3 + 1] * ny + pv[p * 3 + 2] * nz)
      const rel = vo.x * nx + vo.y * ny + vo.z * nz - away
      if (!(rel > CHAR.bumpMinSpeed)) continue
      const hl = Math.sqrt(nx * nx + nz * nz)
      const k2 = hl > 0 ? CHAR.knockNormal / hl : 0
      scratchV.x = vo.x * CHAR.knockGain + nx * k2
      scratchV.y = vo.y * CHAR.knockGain + CHAR.knockUp
      scratchV.z = vo.z * CHAR.knockGain + nz * k2
      ctx.physics.body(this.#bodies[p]).setLinvel(scratchV, true)
      this.#mode[p] = CharMode.stunned
      this.#timer[p] = CHAR.stunTicks
      this.#knockbacks[p]++
      this.#bumped = true
      return
    }
  }

  // Exactly the per-player fields snapshot() writes, in the same order. A domain world writes and
  // reads one seat's block at a time; the bytes are identical to the full-mesh layout.
  writePlayer(w: SnapWriter, p: number): void {
    this.#check(p, 'writePlayer')
    w.u8(this.#mode[p])
    w.i32(this.#timer[p])
    w.u8(this.#coyote[p])
    w.u8(this.#jumpBuffer[p])
    w.u8(this.#prevButtons[p])
    w.u8(this.#diveUsed[p])
    // SnapWriter has no i8: written as its low byte, sign-extended on read.
    w.u8(this.#grabTarget[p] & 0xff)
    w.u16(this.#grabTicks[p])
    w.u16(this.#grabCooldown[p])
    w.f64(this.#facingX[p])
    w.f64(this.#facingZ[p])
    w.u8(this.#grounded[p])
    w.i16(this.#groundObstacle[p])
    w.u16(this.#knockbacks[p])
    w.i32(this.#teleportTick[p])
    w.u8(this.#frozen[p])
    w.u8(this.#parked[p])
  }

  readPlayer(r: SnapReader, p: number): void {
    this.#check(p, 'readPlayer')
    this.#mode[p] = r.u8()
    this.#timer[p] = r.i32()
    this.#coyote[p] = r.u8()
    this.#jumpBuffer[p] = r.u8()
    this.#prevButtons[p] = r.u8()
    this.#diveUsed[p] = r.u8()
    this.#grabTarget[p] = (r.u8() << 24) >> 24
    this.#grabTicks[p] = r.u16()
    this.#grabCooldown[p] = r.u16()
    this.#facingX[p] = r.f64()
    this.#facingZ[p] = r.f64()
    this.#grounded[p] = r.u8()
    this.#groundObstacle[p] = r.i16()
    this.#knockbacks[p] = r.u16()
    this.#teleportTick[p] = r.i32()
    this.#frozen[p] = r.u8()
    this.#parked[p] = r.u8()
    // Consumed within a tick, so never snapshotted: a restored player has no pending override.
    this.#override[p] = NO_OVERRIDE
  }

  snapshot(w: SnapWriter): void {
    for (let p = 0; p < this.playerCount; p++) this.writePlayer(w, p)
  }

  // Never touches Rapier: the world is replaced after the systems restore. BodyIds are kept:
  // they come from init order, identical in every world with the same systems.
  restore(r: SnapReader, _ctx: WorldCtx<PlayerInput>): void {
    for (let p = 0; p < this.playerCount; p++) this.readPlayer(r, p)
  }
}
