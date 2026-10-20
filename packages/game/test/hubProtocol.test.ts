import assert from 'node:assert/strict'
import { test } from 'node:test'
import { EMOTE_MS, HUB_HELLO_EVERY_MS, HUB_MATCH_RATE_HZ, HUB_MAX_ACTS_PER_MIN, HUB_RATE_HZ, decodeHubAct, encodeState, stateToPose } from '@royal-fiesta/game/hub/protocol'
import type { HubState } from '@royal-fiesta/game/hub/protocol'

const TAU = Math.PI * 2

test('state round trip within 5 mm and one facing step', () => {
  const pos = { x: 12.3456, y: -0.7891, z: 99.9949 }
  const facing = { x: Math.sin(2.1), z: Math.cos(2.1) }
  const st = encodeState(pos, facing, 3, 2, true, false, 77)
  const dec = decodeHubAct(JSON.parse(JSON.stringify(st)))
  assert.ok(dec && dec.k === 'st')
  const out = stateToPose(dec, { pos: { x: 0, y: 0, z: 0 }, yaw: 0 })
  assert.ok(Math.abs(out.pos.x - pos.x) <= 0.005)
  assert.ok(Math.abs(out.pos.y - pos.y) <= 0.005)
  assert.ok(Math.abs(out.pos.z - pos.z) <= 0.005)
  let d = Math.abs(out.yaw - Math.atan2(facing.x, facing.z) + TAU) % TAU
  d = Math.min(d, TAU - d)
  assert.ok(d <= TAU / 256 / 2 + 1e-9)
  assert.equal(dec.q, 1)
  assert.equal(dec.x, 0)
  assert.equal(dec.s, 77)
})

test('facing bytes', () => {
  const f = (x: number, z: number) => encodeState({ x: 0, y: 0, z: 0 }, { x, z }, 0, 0, false, false, 0).f
  assert.equal(f(0, 1), 0)
  assert.equal(f(1, 0), 64)
  assert.equal(f(0, -1), 128)
  assert.equal(f(-1, 0), 192)
})

test('malformed inputs return null', () => {
  const good: HubState = encodeState({ x: 1, y: 0, z: 1 }, { x: 0, z: 1 }, 1, 1, false, false, 1)
  const bad: unknown[] = [
    null, undefined, 5, 'hi', [], [good],
    { k: 'zz' },
    { k: 'hi', v: 1, name: 'A' },
    { k: 'hi', v: 1, name: 'A', c: 1, extra: 1 },
    { k: 'hi', v: 2, name: 'A', c: 1 },
    { k: 'hi', v: 1, name: '', c: 1 },
    { k: 'hi', v: 1, name: 'x'.repeat(25), c: 1 },
    { k: 'hi', v: 1, name: 'A', c: 8 },
    { k: 'hi', v: 1, name: 'A', c: 1.5 },
    { ...good, p: [1, 2] },
    { ...good, p: [1.5, 2, 3] },
    { ...good, p: [2e6, 0, 0] },
    { ...good, f: 256 },
    { ...good, m: 8 },
    { ...good, e: 5 },
    { ...good, q: 2 },
    { ...good, x: true },
    { ...good, s: -1 },
    { ...good, s: 2 ** 31 },
    { ...good, extra: 1 },
  ]
  for (const b of bad) assert.equal(decodeHubAct(b), null)
  assert.ok(bad.length >= 10)
  assert.deepEqual(decodeHubAct(good), good)
})

test('hello round trip', () => {
  const h = { k: 'hi', v: 1, name: 'Bean', c: 2 }
  assert.deepEqual(decodeHubAct(JSON.parse(JSON.stringify(h))), h)
})

test('rate constants', () => {
  assert.equal(HUB_RATE_HZ, 5)
  assert.equal(HUB_MATCH_RATE_HZ, 1)
  assert.equal(HUB_HELLO_EVERY_MS, 5000)
  assert.equal(HUB_MAX_ACTS_PER_MIN, 360)
  assert.equal(EMOTE_MS, 2000)
})
