import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  PI, TAU, HALF_PI, dsin, dcos, dsincos, dtan, datan, datan2, dasin, dacos, dexp, dlog, dpow, dhypot, dhypot3,
} from '../src/detmath.ts'
import type { SinCos } from '../src/detmath.ts'

// Goldens were produced by running detmath itself: they pin its bits across engines (QB1), not Math's.
// Regenerate only after a deliberate re-copy of detmath.ts.

const view = new DataView(new ArrayBuffer(8))

function bits(v: number): string {
  view.setFloat64(0, v)
  return view.getBigUint64(0).toString(16).padStart(16, '0')
}

type Fn = (...args: number[]) => number
type Row = [number[], string]

const FNS: Record<string, [Fn, Fn]> = {
  dsin: [dsin, Math.sin],
  dcos: [dcos, Math.cos],
  dtan: [dtan, Math.tan],
  datan: [datan, Math.atan],
  dasin: [dasin, Math.asin],
  dacos: [dacos, Math.acos],
  dexp: [dexp, Math.exp],
  dlog: [dlog, Math.log],
  datan2: [datan2, Math.atan2],
  dpow: [dpow, Math.pow],
  dhypot: [dhypot, Math.hypot],
  dhypot3: [dhypot3, Math.hypot],
}

const GOLDEN: Record<string, Row[]> = {
  dsin: [
    [[0], '0000000000000000'],
    [[-0], '8000000000000000'],
    [[0.5], '3fdeaee8744b05f0'],
    [[-1], 'bfeaed548f090cee'],
    [[HALF_PI], '3ff0000000000000'],
    [[-HALF_PI], 'bff0000000000000'],
    [[PI], '3ca1a62633145c07'],
    [[3 * HALF_PI], 'bff0000000000000'],
    [[TAU], 'bcb1a62633145c07'],
    [[1e5], '3fa24daa9c527e96'],
    [[-1e5], 'bfa24daa9c527e96'],
    [[2.5], '3fe326af0dcfcab0'],
  ],
  dcos: [
    [[0], '3ff0000000000000'],
    [[-0], '3ff0000000000000'],
    [[0.5], '3fec1528065b7d50'],
    [[-1], '3fe14a280fb5068c'],
    [[HALF_PI], '3c91a62633145c07'],
    [[-HALF_PI], '3c91a62633145c07'],
    [[PI], 'bff0000000000000'],
    [[3 * HALF_PI], 'bcaa79394c9e8a0a'],
    [[TAU], '3ff0000000000000'],
    [[1e5], 'bfeffac3841b3da7'],
    [[-1e5], 'bfeffac3841b3da7'],
    [[2.5], 'bfe9a2f7ef858b7d'],
  ],
  dtan: [
    [[0], '0000000000000000'],
    [[-0], '8000000000000000'],
    [[0.5], '3fe17b4f5bf3474a'],
    [[-1], 'bff8eb245cbee3a5'],
    [[HALF_PI], '434d02967c31cdb5'],
    [[-HALF_PI], 'c34d02967c31cdb5'],
    [[PI], 'bca1a62633145c07'],
    [[3 * HALF_PI], '4333570efd768923'],
    [[TAU], 'bcb1a62633145c07'],
    [[1e5], 'bfa250a9d503313c'],
    [[-1e5], '3fa250a9d503313c'],
    [[2.5], 'bfe7e79b4e00bb14'],
  ],
  datan: [
    [[0], '0000000000000000'],
    [[-0], '8000000000000000'],
    [[0.5], '3fddac670561bb4f'],
    [[-0.5], 'bfddac670561bb4f'],
    [[1], '3fe921fb54442d18'],
    [[-1], 'bfe921fb54442d18'],
    [[1e-10], '3ddb7cdfd9d7bdbb'],
    [[10], '3ff789bd2c160054'],
    [[-10], 'bff789bd2c160054'],
    [[1e5], '3ff921f0d7e968a8'],
    [[-1e300], 'bff921fb54442d18'],
    [[HALF_PI], '3ff00fe987ed02ff'],
  ],
  dasin: [
    [[0], '0000000000000000'],
    [[-0], '8000000000000000'],
    [[0.5], '3fe0c152382d7366'],
    [[-0.5], 'bfe0c152382d7366'],
    [[1], '3ff921fb54442d18'],
    [[-1], 'bff921fb54442d18'],
    [[0.1], '3fb9a49276037884'],
    [[-0.1], 'bfb9a49276037884'],
    [[0.9], '3ff1ea93705fa172'],
    [[-0.99], 'bff6de3c6f33d51d'],
    [[1e-10], '3ddb7cdfd9d7bdbb'],
    [[2], '3ff921fb54442d18'],
  ],
  dacos: [
    [[0], '3ff921fb54442d18'],
    [[-0], '3ff921fb54442d18'],
    [[0.5], '3ff0c152382d7365'],
    [[-0.5], '4000c152382d7366'],
    [[1], '0000000000000000'],
    [[-1], '400921fb54442d18'],
    [[0.1], '3ff787b22ce3f590'],
    [[-0.1], '3ffabc447ba464a1'],
    [[0.9], '3fdcdd9f8f922e98'],
    [[-0.99], '4008001be1bc011b'],
    [[1e-10], '3ff921fb543d4de0'],
    [[2], '0000000000000000'],
  ],
  dexp: [
    [[0], '3ff0000000000000'],
    [[-0], '3ff0000000000000'],
    [[1], '4005bf0a8b14576a'],
    [[-1], '3fd78b56362cef38'],
    [[0.5], '3ffa61298e1e069c'],
    [[700], '7f0d945df4f8ec8e'],
    [[-700], '00d14f2b0fb9307f'],
    [[10], '40d5829dcf950560'],
    [[-10], '3f07cd79b5647c9a'],
    [[1e-10], '3ff000000006df38'],
    [[709], '7fdd422d2be5dc9b'],
    [[-745], '0000000000000001'],
  ],
  dlog: [
    [[1], '0000000000000000'],
    [[1e-300], 'c085963447f87fb5'],
    [[1e300], '4085963447f87fb5'],
    [[0.5], 'bfe62e42fefa39ef'],
    [[2], '3fe62e42fefa39ef'],
    [[10], '40026bb1bbb55516'],
    [[2.718281828459045], '3ff0000000000000'],
    [[1e-10], 'c037069e2aa2aa5b'],
    [[0], 'fff0000000000000'],
    [[-1], '7ff8000000000000'],
    [[0.9999999], 'be7ad7f2b1049b9f'],
    [[1e5], '4027069e2aa2aa5b'],
  ],
  datan2: [
    [[1, 1], '3fe921fb54442d18'],
    [[1, -1], '4002d97c7f3321d2'],
    [[-1, -1], 'c002d97c7f3321d2'],
    [[-1, 1], 'bfe921fb54442d18'],
    [[0, 0], '0000000000000000'],
    [[-0, 0], '8000000000000000'],
    [[0, -0], '400921fb54442d18'],
    [[-0, -0], 'c00921fb54442d18'],
    [[0, 1], '0000000000000000'],
    [[1, 0], '3ff921fb54442d18'],
    [[-3, -0.5], 'bffbc66e44cbc074'],
    [[1e-300, 1e300], '0000000000000000'],
  ],
  dpow: [
    [[2, 10], '4090000000000000'],
    [[-2, 3], 'c020000000000000'],
    [[-2, 4], '4030000000000000'],
    [[2, 0.5], '3ff6a09e667f3bcc'],
    [[10, -3], '3f50624dd2f1a9fc'],
    [[0.5, -1], '4000000000000000'],
    [[1e10, 0.1], '4024000000000001'],
    [[2, 0], '3ff0000000000000'],
    [[0, 2], '0000000000000000'],
    [[-1.5, 5], 'c01e600000000000'],
    [[3, 1.5], '4014c8dc2e42397f'],
    [[1.0001, 10000], '4005bec34aabbfd3'],
  ],
  dhypot: [
    [[3, 4], '4014000000000000'],
    [[0, 0], '0000000000000000'],
    [[-3, 4], '4014000000000000'],
    [[1e-150, 1e-150], '20d284603e866142'],
    [[1, 1], '3ff6a09e667f3bcd'],
    [[5, 12], '402a000000000000'],
    [[-0, -0], '0000000000000000'],
    [[1e5, 1], '40f86a0000053e2d'],
    [[0.1, 0.2], '3fcc9f25c5bfedda'],
    [[1, 1e-10], '3ff0000000000000'],
    [[HALF_PI, PI], '400c196908691da7'],
    [[-7.5, -2.25], '401f5227c837f5d2'],
  ],
  dhypot3: [
    [[1, 2, 2], '4008000000000000'],
    [[0, 0, 0], '0000000000000000'],
    [[-1, -2, -2], '4008000000000000'],
    [[3, 4, 12], '402a000000000000'],
    [[1, 1, 1], '3ffbb67ae8584caa'],
    [[0.1, 0.2, 0.3], '3fd7f254dab9cc3b'],
    [[1e5, 1, 1], '40f86a00000a7c5b'],
    [[1e-10, 0, 0], '3ddb7cdfd9d7bdbb'],
    [[2, 3, 6], '401c000000000000'],
    [[-0, -0, -0], '0000000000000000'],
    [[1e100, 1e100, 1e100], '54bface6bc50001b'],
    [[PI, HALF_PI, TAU], '401ccb0d5697bb0e'],
  ],
}

function label(name: string, args: number[]): string {
  return `${name}(${args.map((x) => (Object.is(x, -0) ? '-0' : String(x))).join(', ')})`
}

test('every function pins 12 inputs', () => {
  assert.deepEqual(Object.keys(GOLDEN), Object.keys(FNS))
  for (const name of Object.keys(GOLDEN)) assert.equal(GOLDEN[name].length, 12, name)
})

test('bit-exact golden values', () => {
  for (const name of Object.keys(GOLDEN)) {
    const fn = FNS[name][0]
    for (const [args, hex] of GOLDEN[name]) assert.equal(bits(fn(...args)), hex, label(name, args))
  }
})

test('accuracy vs Math within 1e-15 relative', () => {
  for (const name of Object.keys(GOLDEN)) {
    const [fn, ref] = FNS[name]
    for (const [args] of GOLDEN[name]) {
      const m = ref(...args)
      // Domain edges (log 0, log -1, asin 2) are pinned above; Math gives no finite reference there.
      if (!Number.isFinite(m)) continue
      const d = fn(...args)
      const err = Math.abs(d - m)
      assert.ok(err <= 1e-15 * Math.max(1, Math.abs(m)), `${label(name, args)} = ${d}, Math = ${m}, err ${err}`)
    }
  }
})

test('dsincos matches dsin and dcos bit for bit', () => {
  const out: SinCos = { s: 0, c: 0 }
  for (const [[x]] of GOLDEN.dsin) {
    dsincos(x, out)
    assert.equal(bits(out.s), bits(dsin(x)), `s(${x})`)
    assert.equal(bits(out.c), bits(dcos(x)), `c(${x})`)
  }
})

test('PI, TAU and HALF_PI match Math.PI', () => {
  assert.equal(PI, Math.PI)
  assert.equal(TAU, 2 * Math.PI)
  assert.equal(HALF_PI, Math.PI / 2)
})
