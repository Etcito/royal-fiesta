import assert from 'node:assert/strict'
import test from 'node:test'
import { fuzzAndBloom, hash01, parseLegend, relight, type ViewPasses } from '../viewGrade.ts'

const KEY = [46, 48, 54]
const PLUSH = [230, 56, 64]
const PINK = [140, 217, 77]

// A 16x16 render: the clear colour around a plush square (x 4..9) next to a sneaker square (x 10..11), facing the camera.
function passes(): ViewPasses {
  const w = 16
  const img = (fill: (x: number, y: number) => number[]): { width: number; height: number; data: Uint8Array } => {
    const data = new Uint8Array(w * w * 4)
    for (let y = 0; y < w; y++) for (let x = 0; x < w; x++) data.set([...fill(x, y), 255], (y * w + x) * 4)
    return { width: w, height: w, data }
  }
  const inside = (x: number, y: number): boolean => x >= 4 && x < 12 && y >= 4 && y < 12
  return {
    shaded: img((x, y) => inside(x, y) ? (x < 10 ? [47, 79, 208] : [240, 40, 127]) : KEY),
    normals: img((x, y) => inside(x, y) ? [128, 128, 255] : KEY),
    materials: img((x, y) => inside(x, y) ? (x < 10 ? PLUSH : PINK) : KEY),
    legend: parseLegend('materials (colour = material of the part): #0 #e63840 penguin-plush (m1); #1 #8cd94d penguin-sneaker-pink (m4)'),
  }
}

test('parseLegend reads the colour and name of every material', () => {
  assert.deepEqual(parseLegend('x; #0 #e63840 penguin-plush (m1); #3 #8cd94d penguin-sneaker-pink (m4)'), [
    { rgb: [230, 56, 64], name: 'penguin-plush' },
    { rgb: [140, 217, 77], name: 'penguin-sneaker-pink' },
  ])
  assert.deepEqual(parseLegend('rendered out.png'), [])
})

test('hash01 is deterministic and in [0, 1)', () => {
  assert.equal(hash01(3, 7), hash01(3, 7))
  for (let i = 0; i < 100; i++) { const h = hash01(i, -i); assert.ok(h >= 0 && h < 1) }
})

test('relight keeps the clear colour, masks only the plush material and keeps the hues', () => {
  const p = passes()
  const r = relight(p, [0, 0, 5], [0, 0, 0])
  assert.deepEqual([...r.img.data.subarray(0, 4)], [...KEY, 255])
  assert.equal(r.subject[5 * 16 + 5], 1)
  assert.equal(r.plush[5 * 16 + 5], 1)
  assert.equal(r.plush[5 * 16 + 10], 0)
  assert.equal(r.subject[0], 0)
  const blue = r.img.data.subarray((6 * 16 + 6) * 4, (6 * 16 + 6) * 4 + 3)
  assert.ok(blue[2] > blue[0] && blue[2] > blue[1], 'the plush stays blue')
  const pink = r.img.data.subarray((6 * 16 + 11) * 4, (6 * 16 + 11) * 4 + 3)
  assert.ok(pink[0] > pink[1] && pink[0] > pink[2], 'the sneaker stays pink')
})

test('fuzzAndBloom grows fur only out of plush edges and leaves far background alone', () => {
  const p = passes()
  const r = relight(p, [0, 0, 5], [0, 0, 0])
  const staged = { width: 16, height: 16, data: new Uint8Array(r.img.data) }
  for (let i = 0; i < 256; i++) if (!r.subject[i]) staged.data.set([240, 240, 240], i * 4)
  const out = fuzzAndBloom(staged, r)
  const at = (x: number, y: number): number[] => [...out.data.subarray((y * 16 + x) * 4, (y * 16 + x) * 4 + 3)]
  assert.ok(at(15, 15)[0] > 230, 'a background pixel far from the plush keeps the backdrop')
  let fuzzed = 0
  for (let y = 4; y < 12; y++) if (at(3, y)[2] - at(3, y)[0] > 10) fuzzed++
  assert.ok(fuzzed > 0, 'some fibres reach past the left plush edge')
  assert.equal(fuzzAndBloom(staged, r).data.join(), out.data.join(), 'the grade is deterministic')
})
