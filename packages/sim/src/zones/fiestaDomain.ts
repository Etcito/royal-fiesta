import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { DomainSim, ShadowView, SleepEvent } from '@gamesaloon/rollback/zones'
import { mergeEntityStreams } from '@gamesaloon/rollback-rapier'
import type { BodyId, RapierDomainSim } from '@gamesaloon/rollback-rapier'
import { CharacterSystem } from '../character/system.ts'
import type { CharState } from '../character/system.ts'
import { inBox } from '../course.ts'
import type { ResolvedCourse } from '../course.ts'
import type { PlayerInput } from '../input.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import type { PlayerStatusValue } from '../match/roundSystem.ts'
import { ObstacleSystem } from '../obstacles/system.ts'
import { refuse } from '../refusal.ts'
import { writeBlob } from '../world.ts'
import type { SimSystem, WorldCtx } from '../world.ts'
import { cellOf } from './cells.ts'
import { encodeFar } from './farState.ts'
import { encodeFiestaEvents } from './ledger.ts'
import type { FiestaEvent, MatchLedgerConfig } from './ledger.ts'
import { partMode } from './zonesFile.ts'
import type { ZonesFile } from './zonesFile.ts'

export interface FiestaDomainConfig {
  readonly course: ResolvedCourse
  readonly zones: ZonesFile
  readonly schedule: MatchLedgerConfig
  /** Roster-indexed spawn assignments; defaults to seat modulo course spawn count. */
  readonly spawnIndices?: readonly number[]
  /** Rebuilds retain the imported body poses and then read the character trailer. */
  readonly placeSeats?: boolean
}

type SeatState = CharState & { seat: number; status: number }

/** The inner recipes own seat entities; applyInput and kinematicParts must be empty hooks.
 * Obstacles are created here as unregistered level bodies, never exported as entities.
 */
export class FiestaDomain implements DomainSim<PlayerInput> {
  readonly inner: RapierDomainSim<PlayerInput>
  readonly characters: CharacterSystem
  readonly obstacles: ObstacleSystem
  readonly ctx: WorldCtx<PlayerInput>
  readonly #config: FiestaDomainConfig
  readonly #seats: readonly number[]
  readonly #entities: number[] = []
  readonly #bodies: BodyId[] = []
  readonly #status: Uint8Array
  readonly #checkpoint: Int16Array
  readonly #states: SeatState[] = []
  readonly #eventPool: FiestaEvent[] = []
  readonly #events: FiestaEvent[] = []
  readonly #seesaws: number[] = []
  readonly #seesaw = { angle: 0, prevAngle: 0, angVel: 0 }
  readonly #writer = new SnapWriter()
  #stepTick = -1

  constructor(inner: RapierDomainSim<PlayerInput>, config: FiestaDomainConfig) {
    this.inner = inner
    this.#config = config
    this.#seats = inner.spec.seats.slice()
    const n = this.#seats.length
    this.#status = new Uint8Array(n).fill(PlayerStatus.alive)
    this.#checkpoint = new Int16Array(n)
    this.characters = new CharacterSystem({ playerCount: n, externalBodies: true })
    this.obstacles = new ObstacleSystem([config.course])
    const domain = this
    this.ctx = {
      R: inner.world.sim.R,
      get physics() { return inner.world.sim },
      get tick() { return domain.#stepTick >= 0 ? domain.#stepTick : inner.tick },
      get dt() { return inner.world.sim.dt },
      playerCount: n,
      get resimulating() { return inner.resimulating },
      system<S extends SimSystem<PlayerInput>>(name: string): S {
        const system: SimSystem<PlayerInput> | undefined = name === 'obstacles'
          ? domain.obstacles : name === 'characters' ? domain.characters : undefined
        if (system === undefined) refuse('fiestaDomain', `system/${name}`, 'unknown system; use obstacles or characters')
        return system as S
      },
      hasSystem(name: string): boolean { return name === 'obstacles' || name === 'characters' },
    }
    this.#indexSeats()
    this.#bindBodies()
    this.obstacles.init(this.ctx)
    // All domain-local obstacle clocks have the same origin, including rebuilt worlds.
    this.#stepTick = 0
    this.obstacles.load(this.ctx, 0)
    this.#stepTick = -1
    this.obstacles.placeKinematic(this.ctx, this.tick)
    this.characters.init(this.ctx)
    for (let p = 0; p < n; p++) {
      const seat = this.#seats[p]
      const spawn = config.spawnIndices?.[seat] ?? seat % config.course.spawns.length
      if (!Number.isInteger(spawn) || spawn < 0 || spawn >= config.course.spawns.length) {
        refuse('fiestaDomain', `spawns/${seat}`, 'missing spawn; provide a course spawn for every seat')
      }
      this.#checkpoint[p] = -1 - spawn
      if (config.placeSeats !== false) this.characters.place(this.ctx, p, config.course.spawns[spawn])
      this.#states.push({ seat, status: PlayerStatus.alive, pos: { x: 0, y: 0, z: 0 },
        vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 0 }, mode: 0,
        grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0 })
      this.#eventPool.push({ kind: 'fall', seat, tick: 0 })
    }
    for (let i = 0; i < config.course.obstacles.length; i++) {
      const o = config.course.obstacles[i]
      if (o.motion.kind === 'seesaw' && partMode(config.zones, o) === 'physics' &&
          inner.spec.cells.includes(cellOf(config.zones.grid, o.t.x, o.t.z))) this.#seesaws.push(i)
    }
  }

  get tick(): number { return this.inner.tick }
  set tick(tick: number) { this.inner.tick = tick }
  get seats(): readonly number[] { return this.#seats }
  get host(): Int16Array { return this.inner.host }
  get bot(): Uint8Array { return this.inner.bot }

  #indexSeats(): void {
    this.#writer.reset()
    this.inner.exportEntities(this.#writer)
    const records = mergeEntityStreams([new SnapReader(this.#writer.bytes())]).entities
    this.#entities.length = 0
    for (const seat of this.#seats) {
      const entity = records.find(record => record.owner === seat)
      if (entity === undefined) refuse('fiestaDomain', `seats/${seat}`, 'missing entity; spawn the seat in the inner world')
      this.#entities.push(entity.id)
    }
  }

  #bindBodies(): void {
    for (let p = 0; p < this.#entities.length; p++) this.#bodies[p] = this.inner.world.bodyOf(this.#entities[p])
    this.characters.bindBodies(this.#bodies)
  }

  #player(seat: number): number {
    const p = this.#seats.indexOf(seat)
    if (p < 0) refuse('fiestaDomain', `seats/${seat}`, 'seat is not in this domain; query its owning domain')
    return p
  }

  /** Without out, returns borrowed scratch, valid until the next query or step. */
  state(seat: number, out?: CharState): CharState {
    const p = this.#player(seat)
    this.#bindBodies()
    return this.characters.state(this.ctx, p, out ?? this.#states[p])
  }

  status(seat: number): PlayerStatusValue { return this.#status[this.#player(seat)] as PlayerStatusValue }

  step(inputs: readonly PlayerInput[], shadows: ShadowView): void {
    if (inputs.length !== this.#seats.length) refuse('fiestaDomain', 'inputs', 'wrong count; pass inputs in spec.seats order')
    this.#events.length = 0
    this.#stepTick = this.tick
    try {
      this.#bindBodies()
      this.obstacles.preStep(this.ctx, inputs)
      const schedule = this.#config.schedule
      const frozen = this.#stepTick < schedule.introTicks || this.#stepTick > schedule.introTicks + schedule.roundTicks
      for (let p = 0; p < this.#seats.length; p++) this.characters.freeze(p, frozen)
      this.characters.preStep(this.ctx, inputs)
      this.inner.step(inputs, shadows)
      this.characters.postStep(this.ctx)
      if (!frozen) this.#seatRules()
    } finally {
      this.#stepTick = -1
    }
  }

  #seatRules(): void {
    const course = this.#config.course
    for (let p = 0; p < this.#seats.length; p++) {
      if (this.#status[p] !== PlayerStatus.alive) continue
      const pos = this.characters.state(this.ctx, p, this.#states[p]).pos
      if (this.#config.schedule.kind === 'race') {
        for (let c = course.checkpoints.length - 1; c > Math.max(-1, this.#checkpoint[p]); c--) {
          if (inBox(course.checkpoints[c].box, pos)) {
            this.#checkpoint[p] = c
            break
          }
        }
      }
      if (course.finish !== null && inBox(course.finish, pos)) {
        this.#status[p] = PlayerStatus.qualified
        this.#emit(p, 'finish')
        this.characters.park(this.ctx, p)
      } else if (pos.y < course.killPlaneY) {
        if (this.#config.schedule.kind === 'race') {
          const c = this.#checkpoint[p]
          this.characters.place(this.ctx, p, c >= 0 ? course.checkpoints[c].respawn : course.spawns[-1 - c])
          this.#emit(p, 'fall')
        } else {
          this.#status[p] = PlayerStatus.eliminated
          this.#emit(p, 'eliminate')
          this.characters.park(this.ctx, p)
        }
      }
    }
  }

  #emit(p: number, kind: FiestaEvent['kind']): void {
    const event = this.#eventPool[p]
    event.kind = kind
    event.tick = this.#stepTick
    this.#events.push(event)
  }

  snapshot(w: SnapWriter): void {
    this.inner.snapshot(w)
    this.obstacles.snapshot(w)
    this.characters.snapshot(w)
    for (let p = 0; p < this.#seats.length; p++) this.#writeStatus(w, p)
  }

  restore(r: SnapReader): void {
    this.inner.restore(r)
    this.obstacles.restore(r, this.ctx)
    this.characters.restore(r, this.ctx)
    for (let p = 0; p < this.#seats.length; p++) this.#readStatus(r, p)
    this.#indexSeats()
    this.#bindBodies()
    this.#events.length = 0
  }

  hash(): number { return this.inner.hash() }

  /** Blob(inner export), u16 seats, (u16 seat, player, u8 status, i16 checkpoint),
   * u16 seesaws, (u16 obstacle index, f64 angle, f64 prevAngle, f64 angVel).
   * A negative checkpoint encodes the original spawn as -1 - spawnIndex.
   */
  exportEntities(w: SnapWriter): void {
    this.#writer.reset()
    this.inner.exportEntities(this.#writer)
    writeBlob(w, this.#writer.bytes())
    w.u16(this.#seats.length)
    for (let p = 0; p < this.#seats.length; p++) {
      w.u16(this.#seats[p])
      this.characters.writePlayer(w, p)
      this.#writeStatus(w, p)
    }
    w.u16(this.#seesaws.length)
    for (let s = 0; s < this.#seesaws.length; s++) {
      const i = this.#seesaws[s]
      const state = this.obstacles.seesawState(i, this.#seesaw)
      w.u16(i)
      w.f64(state.angle)
      w.f64(state.prevAngle)
      w.f64(state.angVel)
    }
  }

  #writeStatus(w: SnapWriter, p: number): void {
    w.u8(this.#status[p])
    w.i16(this.#checkpoint[p])
  }

  #readStatus(r: SnapReader, p: number): void {
    this.#status[p] = r.u8()
    this.#checkpoint[p] = r.i16()
  }

  /** Factory handoffs read the seat id first, then restore this seat's trailer block. */
  readSeat(r: SnapReader, seat: number): void {
    const p = this.#player(seat)
    this.characters.readPlayer(r, p)
    this.#readStatus(r, p)
  }

  shadowOut(w: SnapWriter, to: number): void { this.inner.shadowOut(w, to) }
  events(w: SnapWriter): void { encodeFiestaEvents(w, this.#events) }

  far(w: SnapWriter, _stride: number): void {
    this.#bindBodies()
    for (let p = 0; p < this.#seats.length; p++) {
      this.characters.state(this.ctx, p, this.#states[p])
      this.#states[p].status = this.#status[p]
    }
    encodeFar(w, this.#states)
  }

  seatHost(seat: number, peer: number, bot: boolean): void { this.inner.seatHost(seat, peer, bot) }
  sleepEvents(out: SleepEvent[]): void { this.inner.sleepEvents(out) }
  sleepPose(id: number, w: SnapWriter): boolean { return this.inner.sleepPose(id, w) }
  beginResim(): void { this.inner.beginResim() }
  endResim(): void { this.inner.endResim() }
}
