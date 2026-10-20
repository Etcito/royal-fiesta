import assert from 'node:assert/strict'
import test from 'node:test'
import { CorrectionSmoother } from '@gamesaloon/rollback'
import type { RollbackSession, SimView } from '@gamesaloon/rollback'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import type { CharacterView, MatchSim } from '@royal-fiesta/sim/match/matchSim'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { CostStats, ConfirmedHashLog, DisplayJumpMeter, compareHashLogs } from '../src/net/metrics.ts'

// Structural fake of the session: a 128-entry ring over a Map of hashes.
class FakeSession {
  readonly stats = { confirmedTick: -1 }
  readonly hashes = new Map<number, number>()

  confirm(upTo: number, hashOf: (t: number) => number = (t) => (t * 2654435761) >>> 0): void {
    for (let t = this.stats.confirmedTick + 1; t <= upTo; t++) this.hashes.set(t, hashOf(t))
    this.stats.confirmedTick = upTo
  }

  confirmedHash(tick: number): number | undefined {
    if (tick < 0 || tick <= this.stats.confirmedTick - 128) return undefined
    return this.hashes.get(tick)
  }

  get session(): RollbackSession<PlayerInput> {
    return this as unknown as RollbackSession<PlayerInput>
  }
}

test('ConfirmedHashLog records every confirmed tick in steps of 30', () => {
  const s = new FakeSession()
  const log = new ConfirmedHashLog()
  log.record(s.session)
  assert.equal(log.count, 0)
  for (let t = 29; t <= 600; t += 30) {
    s.confirm(t)
    log.record(s.session)
  }
  assert.equal(s.stats.confirmedTick, 599)
  assert.equal(log.count, s.stats.confirmedTick + 1)
  assert.equal(log.get(0), s.hashes.get(0))
  assert.equal(log.get(599), s.hashes.get(599))
  assert.equal(log.get(600), undefined)
  assert.equal(log.get(-1), undefined)
})

test('ConfirmedHashLog keeps a tick with no hash as missing', () => {
  const s = new FakeSession()
  s.confirm(50)
  s.hashes.delete(10)
  const log = new ConfirmedHashLog()
  log.record(s.session)
  assert.equal(log.count, 50)
  assert.equal(log.get(10), undefined)
})

test('ConfirmedHashLog refuses a gap larger than the hash ring', () => {
  const s = new FakeSession()
  const log = new ConfirmedHashLog()
  s.confirm(99)
  log.record(s.session)
  s.confirm(99 + 129)
  assert.throws(() => log.record(s.session), (e: unknown) => {
    assert.ok(isRefusal(e))
    assert.match(e.message, /^\[net\] ConfirmedHashLog\.record: 129 ticks confirmed since the last call \(> 128 hash ring\); call record at least every 100 ticks$/)
    return true
  })
  assert.equal(log.count, 100)
})

test('compareHashLogs counts common ticks and finds the first mismatch', () => {
  const logs: ConfirmedHashLog[] = []
  for (let k = 0; k < 3; k++) {
    const s = new FakeSession()
    // Log 1 differs at tick 42; log 2 confirmed fewer ticks and misses tick 7.
    s.confirm(k === 2 ? 80 : 100, (t) => (k === 1 && t === 42 ? 999 : t + 1))
    if (k === 2) s.hashes.delete(7)
    const log = new ConfirmedHashLog()
    log.record(s.session)
    logs.push(log)
  }
  assert.deepEqual(compareHashLogs(logs), { ticksCompared: 80, mismatches: 1, firstMismatch: 42 })
  assert.deepEqual(compareHashLogs([logs[0], logs[2]]), { ticksCompared: 80, mismatches: 0, firstMismatch: -1 })
  assert.throws(() => compareHashLogs([logs[0]]), isRefusal)
  assert.throws(() => compareHashLogs([]), isRefusal)
})

// Structural fake of the sim: tick plus per-player character state.
class FakeSim {
  tick = 100
  readonly chars: { x: number; y: number; z: number; parked: boolean; teleportTick: number }[] = []

  constructor(players: number) {
    for (let p = 0; p < players; p++) this.chars.push({ x: p * 2, y: 1, z: 0, parked: false, teleportTick: -1 })
  }

  character(p: number, out: CharacterView): CharacterView {
    const c = this.chars[p]
    out.pos.x = c.x
    out.pos.y = c.y
    out.pos.z = c.z
    out.parked = c.parked
    out.teleportTick = c.teleportTick
    return out
  }

  get sim(): MatchSim {
    return this as unknown as MatchSim
  }

  readonly view: SimView = {
    entities: 2,
    stride: 3,
    read: (out: Float64Array) => {
      for (let p = 0; p < 2; p++) {
        out[p * 3] = this.chars[p].x
        out[p * 3 + 1] = this.chars[p].y
        out[p * 3 + 2] = this.chars[p].z
      }
    },
  }
}

test('DisplayJumpMeter: steady 0.2 m per frame is no snap', () => {
  const f = new FakeSim(2)
  const sm = new CorrectionSmoother(2, 3)
  const m = new DisplayJumpMeter(2)
  for (let i = 0; i < 30; i++) {
    m.sample(f.sim, sm)
    f.tick++
    f.chars[0].z += 0.2
  }
  assert.ok(Math.abs(m.maxJump - 0.2) < 1e-9, `maxJump ${m.maxJump}`)
  assert.equal(m.visibleSnaps, 0)
  assert.equal(m.worst.player, 0)
})

test('DisplayJumpMeter: a 1 m step is one visible snap, unless it is a teleport', () => {
  for (const teleport of [false, true]) {
    const f = new FakeSim(2)
    const m = new DisplayJumpMeter(2)
    m.sample(f.sim, new CorrectionSmoother(2, 3))
    f.tick++
    f.chars[1].x += 1
    if (teleport) f.chars[1].teleportTick = f.tick
    m.sample(f.sim, null)
    for (let i = 0; i < 5; i++) {
      f.tick++
      m.sample(f.sim, null)
    }
    assert.equal(m.visibleSnaps, teleport ? 0 : 1)
    if (!teleport) assert.deepEqual(m.worst, { player: 1, tick: 101, jump: 1 })
  }
})

test('DisplayJumpMeter: a smoothed 1 m correction is no snap', () => {
  const f = new FakeSim(2)
  const sm = new CorrectionSmoother(2, 3)
  const m = new DisplayJumpMeter(2)
  m.sample(f.sim, sm)
  // A rollback moves player 0 by 1 m: the smoother keeps the displayed pose, then decays toward the new one.
  sm.capture(f.view)
  f.chars[0].x += 1
  sm.settle(f.view)
  for (let i = 0; i < 60; i++) {
    f.tick++
    m.sample(f.sim, sm)
    sm.decay(1 / 60)
  }
  assert.equal(m.visibleSnaps, 0)
  assert.ok(m.maxJump > 0 && m.maxJump < 0.5, `maxJump ${m.maxJump}`)
})

test('DisplayJumpMeter: a parked player is ignored', () => {
  const f = new FakeSim(2)
  const m = new DisplayJumpMeter(2)
  f.chars[0].parked = true
  for (let i = 0; i < 5; i++) {
    m.sample(f.sim, null)
    f.tick++
    f.chars[0].z += 10
  }
  assert.equal(m.visibleSnaps, 0)
  assert.equal(m.maxJump, 0)
})

test('CostStats on 1..100 and empty refusal', () => {
  const s = new CostStats()
  for (const k of ['mean', 'p50', 'p99', 'max'] as const) assert.throws(() => s[k](), isRefusal)
  for (let i = 100; i >= 1; i--) s.add(i)
  assert.equal(s.n, 100)
  assert.equal(s.mean(), 50.5)
  assert.equal(s.p50(), 50)
  assert.equal(s.p99(), 99)
  assert.equal(s.max(), 100)
})
