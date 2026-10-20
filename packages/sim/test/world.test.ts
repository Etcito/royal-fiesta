import assert from 'node:assert/strict'
import test from 'node:test'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { BodyId, RapierModule } from '@gamesaloon/rollback-rapier'
import { G, groups } from '../src/groups.ts'
import { RefusalError, isRefusal } from '../src/refusal.ts'
import { FiestaWorld, WORLD_MAGIC, readBlob, writeBlob } from '../src/world.ts'
import type { SimSystem, WorldCtx } from '../src/world.ts'

const R: RapierModule = await initRapier()

type Log = string[]

// Records every call; snapshots a u32 counter it increments in postStep.
class Recorder implements SimSystem<number> {
  readonly name: string
  readonly log: Log
  count = 0
  ticks: number[] = []
  inputs: number[][] = []
  resim: boolean[] = []
  constructor(name: string, log: Log) {
    this.name = name
    this.log = log
  }
  init(_ctx: WorldCtx<number>): void { this.log.push(`init:${this.name}`) }
  preStep(ctx: WorldCtx<number>, inputs: readonly number[]): void {
    this.log.push(`pre:${this.name}`)
    this.ticks.push(ctx.tick)
    this.inputs.push(inputs.slice())
    this.resim.push(ctx.resimulating)
  }
  postStep(_ctx: WorldCtx<number>): void {
    this.log.push(`post:${this.name}`)
    this.count++
  }
  snapshot(w: SnapWriter): void { w.u32(this.count) }
  restore(r: SnapReader, _ctx: WorldCtx<number>): void { this.count = r.u32() }
}

class Dropper extends Recorder {
  dropped: number[] = []
  playerDropped(_ctx: WorldCtx<number>, player: number): void { this.dropped.push(player) }
}

// One fixed floor and one dynamic ball created in init; the ball is pushed by input 0.
class Ball implements SimSystem<number> {
  readonly name = 'ball'
  id: BodyId = 0
  init(ctx: WorldCtx<number>): void {
    const { R, physics } = ctx
    physics.createBody(R.RigidBodyDesc.fixed(), [R.ColliderDesc.cuboid(20, 0.5, 20).setTranslation(0, -0.5, 0)])
    this.id = physics.createBody(
      R.RigidBodyDesc.dynamic().setTranslation(0, 3, 0).setLinvel(1.5, 2, -0.75),
      [R.ColliderDesc.ball(0.5).setRestitution(0.4)],
    )
  }
  preStep(ctx: WorldCtx<number>, inputs: readonly number[]): void {
    ctx.physics.body(this.id).applyImpulse({ x: inputs[0] * 0.01, y: 0, z: 0 }, true)
  }
  postStep(_ctx: WorldCtx<number>): void {}
  snapshot(w: SnapWriter): void { w.u32(this.id) }
  restore(r: SnapReader, _ctx: WorldCtx<number>): void { this.id = r.u32() }
}

function ballWorld(playerCount = 2, extra: SimSystem<number>[] = []): FiestaWorld<number> {
  return new FiestaWorld<number>(R, { playerCount, systems: [new Ball(), new Recorder('a', []), ...extra] })
}

function run(world: FiestaWorld<number>, from: number, n: number): void {
  for (let t = from; t < from + n; t++) world.step([(t * 7) % 5 - 2, t % 3])
}

test('writeBlob/readBlob round-trip with u32-word padding', () => {
  for (const len of [0, 1, 3, 4, 5, 1001]) {
    const bytes = new Uint8Array(len)
    for (let i = 0; i < len; i++) bytes[i] = (i * 37 + 11) & 0xff
    const w = new SnapWriter()
    writeBlob(w, bytes)
    const written = w.bytes().slice()
    assert.equal(written.length, 4 + 4 * Math.ceil(len / 4), `size for len ${len}`)
    const r = new SnapReader(written)
    const back = readBlob(r)
    assert.equal(back.length, len)
    assert.deepEqual(back, bytes)
  }
})

test('groups packs membership and filter', () => {
  assert.equal(groups(G.CHAR, G.STATIC | G.CHAR), 0x00040005)
})

test('systems run in order with the tick being run and the inputs passed through', () => {
  const log: Log = []
  const a = new Recorder('a', log)
  const b = new Recorder('b', log)
  const world = new FiestaWorld<number>(R, { playerCount: 2, systems: [a, b] })
  assert.deepEqual(log, ['init:a', 'init:b'])
  log.length = 0
  world.step([3, 9])
  assert.deepEqual(log, ['pre:a', 'pre:b', 'post:a', 'post:b'])
  assert.deepEqual(a.ticks, [0])
  assert.deepEqual(b.ticks, [0])
  assert.equal(world.tick, 1)
  assert.deepEqual(a.inputs, [[3, 9]])
  assert.deepEqual(b.inputs, [[3, 9]])
  assert.equal(a.count, 1)
  world.step([4, 5])
  assert.deepEqual(a.ticks, [0, 1])
  assert.equal(world.tick, 2)
  world.free()
})

test('duplicate system name and wrong inputs length are refused', () => {
  assert.throws(
    () => new FiestaWorld<number>(R, { playerCount: 1, systems: [new Recorder('a', []), new Recorder('a', [])] }),
    (e: unknown) => isRefusal(e) && /duplicate/.test(e.message),
  )
  const world = new FiestaWorld<number>(R, { playerCount: 2, systems: [new Recorder('a', [])] })
  assert.throws(() => world.step([1]), (e: unknown) => isRefusal(e))
  assert.throws(() => world.step([1, 2, 3]), (e: unknown) => isRefusal(e))
  world.free()
})

test('snapshot header is magic, version, playerCount, systemCount (LE)', () => {
  const world = new FiestaWorld<number>(R, { playerCount: 3, systems: [new Recorder('a', []), new Recorder('b', [])] })
  const bytes = world.takeSnapshotBytes()
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  assert.equal(dv.getUint32(0, true), WORLD_MAGIC)
  assert.equal(dv.getUint32(0, true), 0x52465731)
  assert.equal(dv.getUint32(4, true), 1)
  assert.equal(dv.getUint32(8, true), 3)
  assert.equal(dv.getUint32(12, true), 2)
  world.free()
})

test('restore + resimulation equals the uninterrupted run', () => {
  const world = ballWorld()
  run(world, 0, 30)
  const snap = world.takeSnapshotBytes()
  run(world, 30, 30)
  const expected = world.stateHash()
  assert.equal(world.tick, 60)

  world.restoreSnapshotBytes(snap)
  assert.equal(world.tick, 30)
  run(world, 30, 30)
  assert.equal(world.stateHash(), expected)

  const fresh = ballWorld()
  fresh.restoreSnapshotBytes(snap)
  run(fresh, 30, 30)
  assert.equal(fresh.stateHash(), expected)

  fresh.restoreSnapshotBytes(snap)
  assert.deepEqual(fresh.takeSnapshotBytes(), snap)
  world.free()
  fresh.free()
})

test('restore into a different playerCount or system count names the field', () => {
  const world = ballWorld(2)
  const snap = world.takeSnapshotBytes()
  const other = ballWorld(3)
  assert.throws(
    () => other.restoreSnapshotBytes(snap),
    (e: unknown) => e instanceof RefusalError && /playerCount/.test(e.message),
  )
  const more = ballWorld(2, [new Recorder('b', [])])
  assert.throws(
    () => more.restoreSnapshotBytes(snap),
    (e: unknown) => e instanceof RefusalError && /systemCount/.test(e.message),
  )
  world.free()
  other.free()
  more.free()
})

test('beginResim/endResim toggle ctx.resimulating; playerDropped reaches only implementers', () => {
  const a = new Recorder('a', [])
  const d = new Dropper('d', [])
  const world = new FiestaWorld<number>(R, { playerCount: 1, systems: [a, d] })
  assert.equal(world.ctx.resimulating, false)
  world.beginResim()
  assert.equal(world.ctx.resimulating, true)
  world.step([0])
  world.endResim()
  assert.equal(world.ctx.resimulating, false)
  world.step([0])
  assert.deepEqual(a.resim, [true, false])
  world.playerDropped(0)
  assert.deepEqual(d.dropped, [0])
  assert.equal('playerDropped' in a, false)
  world.free()
})

test('FiestaWorld has no hash property', () => {
  const world = new FiestaWorld<number>(R, { playerCount: 1, systems: [] })
  assert.equal('hash' in world, false)
  assert.equal((world as unknown as Record<string, unknown>).hash, undefined)
  world.free()
})
