import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyControls } from '../src/client/inputMap.ts'
import type { RawControls } from '../src/client/inputMap.ts'
import {
  DEFAULT_PAD_MAP,
  localPadMapStore,
  padControls,
  padMapKey,
  parsePadMap
} from '../src/client/padMap.ts'
import type { PadLike, PadMap } from '../src/client/padMap.ts'

const sample = (): PadMap => ({
  v: 1,
  buttons: { jump: 3, dive: 4, grab: 5, pause: 8, join: 6 },
  axes: { x: 2, y: 3 },
  invertY: true,
  dead: 0.2
})

const pad = (axes: number[], pressed: number[] = []): PadLike => ({
  buttons: Array.from({ length: 16 }, (_, i) => ({ pressed: pressed.includes(i) })),
  axes
})

const close = (a: number, b: number, what: string) => assert.ok(Math.abs(a - b) < 1e-12, `${what}: ${a} ~ ${b}`)

test('parsePadMap round trips a custom map through JSON.stringify', () => {
  const custom = sample()
  const text = JSON.stringify(custom)
  const fromString = parsePadMap(text)
  assert.equal(fromString.problem, null)
  assert.deepEqual(fromString.map, custom)
  const fromObject = parsePadMap(JSON.parse(text))
  assert.equal(fromObject.problem, null)
  assert.deepEqual(fromObject.map, custom)
})

test('parsePadMap accepts the default map and returns problem null', () => {
  const { map, problem } = parsePadMap(JSON.parse(JSON.stringify(DEFAULT_PAD_MAP)))
  assert.equal(problem, null)
  assert.deepEqual(map, DEFAULT_PAD_MAP)
  assert.notEqual(map, DEFAULT_PAD_MAP)
})

test('parsePadMap refuses v: 2 and names the field', () => {
  const bad = { ...sample(), v: 2 }
  const { map, problem } = parsePadMap(bad)
  assert.ok(problem !== null)
  assert.match(problem, /(^|\W)v\b/)
  assert.match(problem, /fix:/)
  assert.deepEqual(map, DEFAULT_PAD_MAP)
  assert.notEqual(map, DEFAULT_PAD_MAP)
})

test('parsePadMap refuses a button of -1 and names the field path', () => {
  const bad = sample()
  bad.buttons.jump = -1
  const { map, problem } = parsePadMap(bad)
  assert.ok(problem !== null)
  assert.match(problem, /buttons\.jump/)
  assert.match(problem, /fix:/)
  assert.deepEqual(map, DEFAULT_PAD_MAP)
})

test("parsePadMap refuses dead: 'x' and names the field", () => {
  const bad = { ...sample(), dead: 'x' }
  const { map, problem } = parsePadMap(bad)
  assert.ok(problem !== null)
  assert.match(problem, /\bdead\b/)
  assert.match(problem, /fix:/)
  assert.deepEqual(map, DEFAULT_PAD_MAP)
})

test('parsePadMap refuses unknown keys and out-of-range axes', () => {
  const unknown = { ...sample(), turbo: true }
  assert.match(parsePadMap(unknown).problem ?? '', /turbo/)
  const axis = sample()
  axis.axes.x = 8
  assert.match(parsePadMap(axis).problem ?? '', /axes\.x/)
  const inversion = { ...sample(), invertY: 'yes' }
  assert.match(parsePadMap(inversion).problem ?? '', /invertY/)
})

test('padControls: invertY flips stickY', () => {
  const normal = padControls(pad([0, 0.5]), DEFAULT_PAD_MAP, emptyControls())
  const inverted = padControls(pad([0, 0.5]), { ...DEFAULT_PAD_MAP, invertY: true }, emptyControls())
  assert.ok(normal.stickY < 0, `normal stickY ${normal.stickY}`)
  assert.ok(inverted.stickY > 0, `inverted stickY ${inverted.stickY}`)
  close(Math.abs(normal.stickY), Math.abs(inverted.stickY), 'flip keeps the magnitude')
})

test('padControls: the dead zone is radial', () => {
  const inside = padControls(pad([0.1, 0.1]), DEFAULT_PAD_MAP, emptyControls())
  assert.equal(inside.stickX, 0)
  assert.equal(inside.stickY, 0)
  const outside = padControls(pad([0.6, 0]), DEFAULT_PAD_MAP, emptyControls())
  close(outside.stickX, (0.6 - 0.15) / 0.85, 'stickX rescale')
  close(outside.stickY, 0, 'stickY')
  // The same 0.6 on both axes stays along the diagonal.
  const diagonal = padControls(pad([0.6, -0.6]), DEFAULT_PAD_MAP, emptyControls())
  close(diagonal.stickX, diagonal.stickY, 'diagonal stays diagonal')
  close(Math.hypot(diagonal.stickX, diagonal.stickY), (Math.hypot(0.6, 0.6) - 0.15) / 0.85, 'radial rescale')
})

test('padControls reads the mapped buttons, the mapped axes and leaves the keys false', () => {
  const map = sample()
  const out: RawControls = { left: true, right: true, forward: true, back: true, stickX: 0, stickY: 0, jump: false, dive: false, grab: false }
  const result = padControls(pad([0.5, 0.5, 0.9, -0.4], [3, 4, 5]), map, out)
  assert.equal(result, out)
  assert.equal(out.left, false)
  assert.equal(out.right, false)
  assert.equal(out.forward, false)
  assert.equal(out.back, false)
  const magnitude = Math.hypot(0.9, -0.4)
  const scaled = (magnitude - 0.2) / 0.8
  close(out.stickX, (0.9 / magnitude) * scaled, 'axes.x 2')
  close(out.stickY, (-0.4 / magnitude) * scaled, 'axes.y 3 with invertY')
  assert.equal(out.jump, true)
  assert.equal(out.dive, true)
  assert.equal(out.grab, true)
})

test('padControls treats non-finite axes as 0', () => {
  const out = padControls(pad([Number.NaN, Number.POSITIVE_INFINITY]), DEFAULT_PAD_MAP, emptyControls())
  assert.equal(out.stickX, 0)
  assert.equal(out.stickY, 0)
})

test('localPadMapStore uses rf.padmap.<id>, reset restores the default', () => {
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) }
  }
  const store = localPadMapStore(storage)
  const custom = sample()
  store.set('pad-a', custom)
  assert.equal(data.get('rf.padmap.pad-a'), JSON.stringify(custom))
  assert.equal(padMapKey('pad-a'), 'rf.padmap.pad-a')
  assert.deepEqual(store.get('pad-a'), custom)
  store.reset('pad-a')
  assert.equal(data.has('rf.padmap.pad-a'), false)
  assert.deepEqual(store.get('pad-a'), DEFAULT_PAD_MAP)
})

test('localPadMapStore warns once on a corrupt stored value and loads the default', (t) => {
  const warnings: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')) })
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value) },
    removeItem: (key: string) => { data.delete(key) }
  }
  const store = localPadMapStore(storage)
  data.set('rf.padmap.bad', '{not json')
  assert.deepEqual(store.get('bad'), DEFAULT_PAD_MAP)
  assert.deepEqual(store.get('bad'), DEFAULT_PAD_MAP)
  assert.equal(warnings.length, 1, warnings.join(' | '))
  assert.match(warnings[0]!, /rf\.padmap\.bad/)
  assert.match(warnings[0]!, /padMap/)
  data.set('rf.padmap.wrong', JSON.stringify({ ...sample(), v: 2 }))
  assert.deepEqual(store.get('wrong'), DEFAULT_PAD_MAP)
  assert.equal(warnings.length, 2, warnings.join(' | '))
  assert.match(warnings[1]!, /rf\.padmap\.wrong/)
  assert.match(warnings[1]!, /\bv\b/)
})

test('localPadMapStore keeps maps in memory without storage', () => {
  const store = localPadMapStore(null)
  assert.deepEqual(store.get('none'), DEFAULT_PAD_MAP)
  const custom = sample()
  store.set('none', custom)
  assert.deepEqual(store.get('none'), custom)
  store.reset('none')
  assert.deepEqual(store.get('none'), DEFAULT_PAD_MAP)
})

test('a throwing storage falls back to memory with one warning', (t) => {
  const warnings: string[] = []
  t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.join(' ')) })
  let quota = false
  const data = new Map<string, string>()
  const storage = {
    getItem: (key: string) => { if (quota) throw new Error('denied'); return data.get(key) ?? null },
    setItem: (key: string, value: string) => {
      if (quota) throw new Error('quota')
      data.set(key, value)
    },
    removeItem: (key: string) => { if (quota) throw new Error('denied'); data.delete(key) }
  }
  const store = localPadMapStore(storage)
  quota = true
  const custom = sample()
  store.set('pad', custom)
  assert.deepEqual(store.get('pad'), custom)
  store.set('pad2', custom)
  assert.equal(warnings.length, 1, warnings.join(' | '))
  assert.match(warnings[0]!, /storage failed/)
  assert.match(warnings[0]!, /quota/)
})
