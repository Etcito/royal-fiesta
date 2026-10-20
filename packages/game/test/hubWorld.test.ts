import assert from 'node:assert/strict'
import { test } from 'node:test'
import { encodeState } from '@royal-fiesta/game/hub/protocol'
import type { HubState } from '@royal-fiesta/game/hub/protocol'
import { RemoteBuffer } from '@royal-fiesta/game/hub/remotes'
import { QueuePad } from '@royal-fiesta/game/hub/queuePad'
import { readFileSync } from 'node:fs'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { CharState } from '@royal-fiesta/sim/character/system'
import { neutralInput } from '@royal-fiesta/sim/input'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { fixtureResolver } from '@royal-fiesta/game/assets'
import { loadCourse } from '@royal-fiesta/game/course'
import { HubWorld } from '@royal-fiesta/game/hub/hubWorld'

const TAU = Math.PI * 2

function st(seq: number, x: number, z: number, opts: { fx?: number; fz?: number; m?: number; e?: number; q?: boolean; inMatch?: boolean } = {}): HubState {
  return encodeState({ x, y: 0, z }, { x: opts.fx ?? 0, z: opts.fz ?? 1 }, opts.m ?? 0, opts.e ?? 0, opts.q ?? false, opts.inMatch ?? false, seq)
}

test('remote interpolation midpoint is exact for states 200 ms apart', () => {
  const rb = new RemoteBuffer()
  rb.push(0, st(1, 0, 0, { m: 1 }), 1000)
  rb.push(0, st(2, 2, 4, { m: 2, e: 3, q: true }), 1200)
  const [v] = rb.sample(1100 + 300)
  assert.equal(v.pos.x, 1)
  assert.equal(v.pos.z, 2)
  assert.equal(v.mode, 2)
  assert.equal(v.emote, 3)
  assert.equal(v.queued, true)
  assert.equal(v.stale, false)
})

test('remote yaw interpolates along the shortest arc', () => {
  const rb = new RemoteBuffer()
  // facing bytes 250 and 6: the short way crosses 0
  rb.push(0, { ...st(1, 0, 0), f: 250 }, 0)
  rb.push(0, { ...st(2, 0, 0), f: 6 }, 200)
  const [v] = rb.sample(100 + 300)
  assert.ok(Math.abs(v.yaw) < 1e-9 || Math.abs(v.yaw - TAU) < 1e-9)
})

test('out-of-order and duplicate states are ignored', () => {
  const rb = new RemoteBuffer()
  rb.push(0, st(5, 0, 0), 1000)
  rb.push(0, st(6, 1, 0), 1200)
  rb.push(0, st(4, 50, 0), 1250)
  rb.push(0, st(6, 60, 0), 1260)
  const [v] = rb.sample(1200 + 300)
  assert.equal(v.pos.x, 1)
  const [w] = rb.sample(1100 + 300)
  assert.equal(w.pos.x, 0.5)
})

test('extrapolation is capped at 200 ms then stale', () => {
  const rb = new RemoteBuffer()
  rb.push(0, st(1, 0, 0), 1000)
  rb.push(0, st(2, 2, 0), 1200) // 10 m/s along x
  const a = rb.sample(1200 + 300 + 100)[0]
  assert.ok(Math.abs(a.pos.x - 3) < 1e-9)
  assert.equal(a.stale, false)
  const b = rb.sample(1200 + 300 + 200)[0]
  assert.ok(Math.abs(b.pos.x - 4) < 1e-9)
  assert.equal(b.stale, false)
  const c = rb.sample(1200 + 300 + 1000)[0]
  assert.ok(Math.abs(c.pos.x - 4) < 1e-9)
  assert.equal(c.stale, true)
})

test('a single state holds its pose and goes stale after 200 ms', () => {
  const rb = new RemoteBuffer()
  rb.push(0, st(1, 3, 4), 1000)
  const a = rb.sample(1000 + 300 + 150)[0]
  assert.equal(a.pos.x, 3)
  assert.equal(a.stale, false)
  const b = rb.sample(1000 + 300 + 201)[0]
  assert.equal(b.pos.z, 4)
  assert.equal(b.stale, true)
})

test('remotes in a match are hidden', () => {
  const rb = new RemoteBuffer()
  rb.push(0, st(1, 0, 0), 1000)
  rb.push(1, st(1, 0, 0), 1000)
  rb.push(1, st(2, 0, 0, { inMatch: true }), 1200)
  const views = rb.sample(1300)
  assert.deepEqual(views.map(v => v.seat), [0])
  rb.push(1, st(3, 0, 0), 2000)
  assert.deepEqual(rb.sample(2200).map(v => v.seat), [0, 1])
})

test('results are sorted by seat and remove forgets a seat', () => {
  const rb = new RemoteBuffer()
  for (const seat of [3, 0, 2, 1]) rb.push(seat, st(1, seat, 0), 1000)
  assert.deepEqual(rb.sample(1200).map(v => v.seat), [0, 1, 2, 3])
  rb.remove(2)
  assert.deepEqual(rb.sample(1200).map(v => v.seat), [0, 1, 3])
})

test('hello sets name and colour, defaults before it', () => {
  const rb = new RemoteBuffer()
  rb.push(2, st(1, 0, 0), 1000)
  rb.push(9, st(1, 0, 0), 1000)
  let views = rb.sample(1200)
  assert.equal(views[0].name, 'Bean 3')
  assert.equal(views[0].colour, 2)
  assert.equal(views[1].name, 'Bean 10')
  assert.equal(views[1].colour, 1)
  rb.push(2, { k: 'hi', v: 1, name: 'Kev', c: 5 }, 1100)
  views = rb.sample(1200)
  assert.equal(views[0].name, 'Kev')
  assert.equal(views[0].colour, 5)
})

test('queue pad arms exactly at frame 90, once', () => {
  const pad = new QueuePad()
  for (let f = 1; f < 90; f++) assert.equal(pad.update(true), 'arming', `frame ${f}`)
  assert.equal(pad.update(true), 'armed')
  for (let f = 0; f < 200; f++) assert.equal(pad.update(true), 'idle')
  assert.equal(pad.update(false), 'cancel')
})

test('queue pad cancels once after leaving, then resets', () => {
  const pad = new QueuePad(3)
  assert.equal(pad.update(false), 'idle')
  pad.update(true)
  pad.update(true)
  assert.equal(pad.update(true), 'armed')
  assert.equal(pad.update(false), 'cancel')
  assert.equal(pad.update(false), 'idle')
  assert.equal(pad.update(true), 'arming')
  assert.equal(pad.update(true), 'arming')
  assert.equal(pad.update(true), 'armed')
})

test('queue pad resets its count on an early leave', () => {
  const pad = new QueuePad()
  for (let f = 0; f < 60; f++) pad.update(true)
  assert.equal(pad.update(false), 'idle')
  for (let f = 1; f < 90; f++) assert.equal(pad.update(true), 'arming')
  assert.equal(pad.update(true), 'armed')
})

// ---- HubWorld ----

const ROOT = new URL('../../../', import.meta.url)
const read = async (rel: string) => readFileSync(new URL(rel, ROOT), 'utf8')
const resolver = fixtureResolver(read)
const R: RapierModule = await initRapier()
const PLAZA_PATH = 'fixtures/courses/hub-plaza.course.json'
const plaza = await loadCourse(JSON.parse(await read(PLAZA_PATH)) as unknown, PLAZA_PATH, resolver)

function move(x: number, z: number): PlayerInput {
  const i = neutralInput()
  i.moveX = x
  i.moveZ = z
  return i
}

function newState(): CharState {
  return { pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 1 }, mode: 0, grounded: false, groundObstacle: -1, knockbacks: 0, teleportTick: 0 }
}

test('hub world settles grounded at spawn 0 after 60 neutral ticks', () => {
  const hw = new HubWorld(R, plaza, 0)
  try {
    for (let i = 0; i < 60; i++) hw.step(neutralInput())
    assert.equal(hw.tick, 60)
    const s = hw.state(newState())
    const sp = plaza.spawns[0].t
    assert.equal(s.grounded, true)
    assert.ok(Math.hypot(s.pos.x - sp.x, s.pos.z - sp.z) < 0.5, `xz ${s.pos.x},${s.pos.z}`)
  } finally {
    hw.free()
  }
})

test('hub world: holding moveZ = 1 increases z', () => {
  const hw = new HubWorld(R, plaza, 0)
  try {
    const z0 = hw.state(newState()).pos.z
    for (let i = 0; i < 60; i++) hw.step(move(0, 1))
    assert.ok(hw.state(newState()).pos.z > z0 + 1)
  } finally {
    hw.free()
  }
})

test('hub world: every spawn reaches the queue pad within 600 ticks', () => {
  const c = plaza.queuePad!.center
  for (let sp = 0; sp < plaza.spawns.length; sp++) {
    const hw = new HubWorld(R, plaza, sp)
    try {
      const s = newState()
      let reached = -1
      for (let t = 0; t < 600 && reached < 0; t++) {
        hw.state(s)
        const dx = c.x - s.pos.x
        const dz = c.z - s.pos.z
        const len = Math.hypot(dx, dz)
        hw.step(len > 1e-6 ? move(dx / len, dz / len) : neutralInput())
        if (hw.onQueuePad()) reached = t
      }
      assert.ok(reached >= 0, `spawn ${sp} never reached the pad, ended at ${s.pos.x},${s.pos.y},${s.pos.z}`)
    } finally {
      hw.free()
    }
  }
})

test('hub world: falling below the kill plane respawns at the spawn', async () => {
  const json = {
    format: 'royal-fiesta.course', version: 0, id: 'hub-tiny', name: 'Tiny Hub', kind: 'hub', profiles: [],
    assetsManifest: null, timeLimitS: 60, killPlaneY: -10,
    spawns: [{ t: [0, 0, 0], yawDeg: 0 }], checkpoints: [], finish: null, path: [],
    regions: [{ id: 0, center: [0, 0, 0], half: [6, 5, 6], adjacent: [] }],
    queuePad: { center: [0, 1, 4], half: [1, 1, 1] },
    obstacles: [{
      id: 'floor', asset: 'floor-disc', t: [0, -0.5, 0], r: [0, 0, 0, 1], s: [1, 1, 1],
      friction: 0, motion: { kind: 'static' }, colliders: null,
    }],
  }
  const tiny = await loadCourse(json, 'test/hub-tiny.course.json', resolver)
  const hw = new HubWorld(R, tiny, 0)
  try {
    let respawned = false
    for (let t = 0; t < 600 && !respawned; t++) {
      hw.step(move(1, 0))
      if (hw.state(newState()).teleportTick > 0) respawned = true
    }
    assert.ok(respawned, 'the bean never respawned')
    const s = hw.state(newState())
    assert.ok(Math.hypot(s.pos.x, s.pos.z) < 0.5 && Math.abs(s.pos.y) < 2, `pos ${s.pos.x},${s.pos.y},${s.pos.z}`)
  } finally {
    hw.free()
  }
})

test('hub world: emote lasts EMOTE_MS and ids outside EMOTES are refused', () => {
  const hw = new HubWorld(R, plaza, 0)
  try {
    assert.equal(hw.emote(0), 0)
    hw.setEmote(2, 1000)
    assert.equal(hw.emote(2999), 2)
    assert.equal(hw.emote(3000), 0)
    assert.throws(() => hw.setEmote(5, 0), RefusalError)
    assert.throws(() => hw.setEmote(-1, 0), RefusalError)
  } finally {
    hw.free()
  }
})

test('hub world refuses a non-hub course, a missing pad and a bad spawn', () => {
  assert.throws(() => new HubWorld(R, { ...plaza, kind: 'race' }, 0), RefusalError)
  assert.throws(() => new HubWorld(R, { ...plaza, queuePad: null }, 0), RefusalError)
  assert.throws(() => new HubWorld(R, plaza, plaza.spawns.length), RefusalError)
  assert.throws(() => new HubWorld(R, plaza, -1), RefusalError)
})
