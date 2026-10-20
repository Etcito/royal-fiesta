// FiestaWorld: the game's Simulation<TInput>. It is the 6-line wrapper of gamesaloon-rollback
// docs/RAPIER.md ("Wrapping as a core Simulation<TInput>"), copied and adapted, never forked.
// Adaptations: ordered SimSystems around physics.step(), and the u32-word blob, because
// SnapWriter has no blob method. hash() is deliberately absent: the session hashes the snapshot.
import type { SimView, RegionHints, Simulation } from '@gamesaloon/rollback'
import { SnapReader, SnapWriter, fnv1a32 } from '@gamesaloon/rollback'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import { RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { refuse } from './refusal.ts'

export const GRAVITY_Y = -20
export const WORLD_MAGIC = 0x52465731
export const WORLD_VERSION = 1
export const MAX_PLAYERS = 8

export interface WorldCtx<TInput> {
  readonly R: RapierModule
  readonly physics: RapierWorldSim
  readonly tick: number
  readonly dt: number
  readonly playerCount: number
  readonly resimulating: boolean
  system<S extends SimSystem<TInput>>(name: string): S
  hasSystem(name: string): boolean
}

export interface SimSystem<TInput> {
  readonly name: string
  init(ctx: WorldCtx<TInput>): void
  preStep(ctx: WorldCtx<TInput>, inputs: readonly TInput[]): void
  postStep(ctx: WorldCtx<TInput>): void
  snapshot(w: SnapWriter): void
  restore(r: SnapReader, ctx: WorldCtx<TInput>): void
  playerDropped?(ctx: WorldCtx<TInput>, player: number): void
}

export interface FiestaWorldOptions<TInput> {
  playerCount: number
  systems: SimSystem<TInput>[]
  gravityY?: number
  view?: SimView
  regions?: RegionHints
}

export class FiestaWorld<TInput> implements Simulation<TInput> {
  readonly R: RapierModule
  readonly physics: RapierWorldSim
  readonly playerCount: number
  readonly view?: SimView
  readonly regions?: RegionHints
  readonly #systems: SimSystem<TInput>[]
  readonly #ctx: WorldCtx<TInput>
  readonly #writer = new SnapWriter()
  #resimulating = false
  // The tick being run while a step is in progress, -1 otherwise.
  #stepTick = -1

  constructor(R: RapierModule, opts: FiestaWorldOptions<TInput>) {
    const pc = opts.playerCount
    if (!Number.isInteger(pc) || pc < 1 || pc > MAX_PLAYERS) {
      refuse('world', 'playerCount', `got ${pc}, must be an integer in 1..${MAX_PLAYERS}; pass a valid player count`)
    }
    const systems = opts.systems.slice()
    const byName = new Map<string, SimSystem<TInput>>()
    for (let i = 0; i < systems.length; i++) {
      const name = systems[i].name
      if (byName.has(name)) refuse('world', `systems/${i}`, `duplicate system name '${name}'; give each system a unique name`)
      byName.set(name, systems[i])
    }
    this.R = R
    this.playerCount = pc
    this.view = opts.view
    this.regions = opts.regions
    this.#systems = systems
    this.physics = new RapierWorldSim(R, { gravity: { x: 0, y: opts.gravityY ?? GRAVITY_Y, z: 0 } })
    const world = this
    this.#ctx = {
      R,
      get physics() { return world.physics },
      get tick() { return world.#stepTick >= 0 ? world.#stepTick : world.physics.tick },
      get dt() { return world.physics.dt },
      playerCount: pc,
      get resimulating() { return world.#resimulating },
      system<S extends SimSystem<TInput>>(name: string): S {
        const s = byName.get(name)
        if (s === undefined) refuse('world', `system(${name})`, 'unknown system name; register it in FiestaWorldOptions.systems')
        return s as S
      },
      hasSystem(name: string): boolean { return byName.has(name) },
    }
    for (let i = 0; i < systems.length; i++) systems[i].init(this.#ctx)
  }

  get tick(): number { return this.physics.tick }

  get ctx(): WorldCtx<TInput> { return this.#ctx }

  step(inputs: readonly TInput[]): void {
    if (inputs.length !== this.playerCount) {
      refuse('world', 'step(inputs)', `got ${inputs.length} inputs, expected ${this.playerCount}; pass one input per player`)
    }
    const systems = this.#systems
    const ctx = this.#ctx
    this.#stepTick = this.physics.tick
    try {
      for (let i = 0; i < systems.length; i++) systems[i].preStep(ctx, inputs)
      this.physics.step()
      for (let i = 0; i < systems.length; i++) systems[i].postStep(ctx)
    } finally {
      this.#stepTick = -1
    }
  }

  // S5 layout: magic | version | playerCount | systemCount | system sections | blob(physics)
  snapshot(w: SnapWriter): void {
    const systems = this.#systems
    w.u32(WORLD_MAGIC)
    w.u32(WORLD_VERSION)
    w.u32(this.playerCount)
    w.u32(systems.length)
    for (let i = 0; i < systems.length; i++) systems[i].snapshot(w)
    writeBlob(w, this.physics.takeSnapshot())
  }

  /**
   * Restore contract: systems restore in registration order first, then the Rapier world is
   * replaced last. Body handles and RigidBody/Collider objects from before the restore are
   * invalid, so a system must re-derive them lazily (next preStep or first query), never in restore.
   */
  restore(r: SnapReader): void {
    const systems = this.#systems
    const magic = r.u32()
    if (magic !== WORLD_MAGIC) refuse('world', 'snapshot/magic', `expected 0x${hex(WORLD_MAGIC)}, got 0x${hex(magic)}; restore a FiestaWorld snapshot`)
    const version = r.u32()
    if (version !== WORLD_VERSION) refuse('world', 'snapshot/version', `expected ${WORLD_VERSION}, got ${version}; restore a snapshot of the same version`)
    const pc = r.u32()
    if (pc !== this.playerCount) refuse('world', 'snapshot/playerCount', `expected ${this.playerCount}, got ${pc}; restore into a world with the same player count`)
    const sc = r.u32()
    if (sc !== systems.length) refuse('world', 'snapshot/systemCount', `expected ${systems.length}, got ${sc}; restore into a world with the same systems`)
    for (let i = 0; i < systems.length; i++) systems[i].restore(r, this.#ctx)
    this.physics.restoreSnapshot(readBlob(r))
  }

  playerDropped(player: number): void {
    const systems = this.#systems
    for (let i = 0; i < systems.length; i++) {
      const s = systems[i]
      if (s.playerDropped !== undefined) s.playerDropped(this.#ctx, player)
    }
  }

  beginResim(): void { this.#resimulating = true }

  endResim(): void { this.#resimulating = false }

  takeSnapshotBytes(): Uint8Array {
    const w = this.#writer
    w.reset()
    this.snapshot(w)
    return w.bytes().slice()
  }

  restoreSnapshotBytes(bytes: Uint8Array): void {
    this.restore(new SnapReader(bytes))
  }

  stateHash(): number {
    return fnv1a32(this.takeSnapshotBytes())
  }

  free(): void {
    this.physics.free()
  }
}

function hex(v: number): string {
  return (v >>> 0).toString(16).padStart(8, '0')
}

// u32 byteLength, then ceil(len/4) u32 little-endian words; the last word is zero-padded.
export function writeBlob(w: SnapWriter, bytes: Uint8Array): void {
  const len = bytes.length
  w.u32(len)
  const full = len >>> 2
  for (let i = 0; i < full; i++) {
    const o = i << 2
    w.u32((bytes[o] | bytes[o + 1] << 8 | bytes[o + 2] << 16 | bytes[o + 3] << 24) >>> 0)
  }
  const rest = len & 3
  if (rest > 0) {
    const o = full << 2
    let word = 0
    for (let k = 0; k < rest; k++) word |= bytes[o + k] << (k << 3)
    w.u32(word >>> 0)
  }
}

export function readBlob(r: SnapReader): Uint8Array {
  const len = r.u32()
  const out = new Uint8Array(len)
  const words = (len + 3) >>> 2
  for (let i = 0; i < words; i++) {
    const word = r.u32()
    const o = i << 2
    for (let k = 0; k < 4 && o + k < len; k++) out[o + k] = (word >>> (k << 3)) & 0xff
  }
  return out
}
