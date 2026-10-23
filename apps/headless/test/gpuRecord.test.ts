import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { buildCapturesRecord, decodePng, pngNonEmpty } from '../src/gpuRecord.ts'

function crcTable(): Uint32Array {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
}
const CRC = crcTable()
function chunk(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(body.length, 0)
  head.write(type, 4, 'latin1')
  let c = 0xffffffff
  for (const b of Buffer.concat([head.subarray(4), body])) c = CRC[(c ^ b) & 255] ^ (c >>> 8)
  const tail = Buffer.alloc(4)
  tail.writeUInt32BE((c ^ 0xffffffff) >>> 0, 0)
  return Buffer.concat([head, body, tail])
}

// RGB pixels from px(x, y); row y uses filter filters[y % filters.length] (0 none, 1 sub, 2 up).
function makePng(w: number, h: number, px: (x: number, y: number) => number[], filters = [0], declared = { w, h }): Buffer {
  const rows: number[] = []
  const pix = (x: number, y: number, k: number): number => (x < 0 || y < 0 ? 0 : px(x, y)[k])
  for (let y = 0; y < h; y++) {
    const ft = filters[y % filters.length]
    rows.push(ft)
    for (let x = 0; x < w; x++) {
      for (let k = 0; k < 3; k++) {
        const pred = ft === 1 ? pix(x - 1, y, k) : ft === 2 ? pix(x, y - 1, k) : 0
        rows.push((pix(x, y, k) - pred) & 255)
      }
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(declared.w, 0)
  ihdr.writeUInt32BE(declared.h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))])
}

const varied = (x: number, y: number): number[] => [(x * 37) & 255, (y * 11) & 255, (x ^ y) & 255]

test('a uniform image is empty', () => {
  assert.equal(pngNonEmpty(decodePng(makePng(16, 8, () => [40, 80, 120]), 16, 8, 't')), false)
})

test('varied quadrants with filters 0, 1 and 2 are non-empty and decode exactly', () => {
  const png = decodePng(makePng(16, 8, varied, [0, 1, 2]), 16, 8, 't')
  assert.equal(png.data[(5 * 16 + 9) * 3], (9 * 37) & 255)
  assert.equal(png.data[(7 * 16 + 15) * 3 + 2], 15 ^ 7)
  assert.equal(pngNonEmpty(png), true)
  // Only the HUD corner (top half of the top-left quadrant) varies: still empty.
  const hud = (x: number, y: number): number[] => (x < 8 && y < 2 ? varied(x, y) : [9, 9, 9])
  assert.equal(pngNonEmpty(decodePng(makePng(16, 8, hud, [1]), 16, 8, 't')), false)
})

test('a bad signature or a size mismatch refuses', () => {
  const bad = makePng(4, 4, varied)
  bad[1] = 0
  assert.throws(() => decodePng(bad, 4, 4, 'f.json#/captures/0/base64'), e => isRefusal(e) && /signature/.test(e.message) && /f\.json#/.test(e.message))
  assert.throws(() => decodePng(makePng(4, 4, varied, [0], { w: 4, h: 5 }), 4, 4, 't'), e => isRefusal(e) && /4x5/.test(e.message))
})

const capOut = (pngs: Buffer[]): object => ({
  renderer: 'raa',
  adapter: { vendor: 'v', architecture: 'a', description: 'd', software: false },
  captures: pngs.map((p, i) => ({ name: `round-${i}s`, width: 16, height: 8, mime: 'image/png', base64: p.toString('base64') })),
})

test('the unwrap finds a nested op output and refuses ambiguity', () => {
  const nested = { file: 'r.json', json: { ok: true, result: { output: capOut([makePng(16, 8, varied)]) } } }
  assert.equal(buildCapturesRecord(nested, null, 'REF').record.captures.length, 1)
  const two = { file: 'r.json', json: { a: capOut([]), b: capOut([]) } }
  assert.throws(() => buildCapturesRecord(two, null, 'REF'), e => isRefusal(e) && /2 objects/.test(e.message))
  assert.throws(() => buildCapturesRecord({ file: 'r.json', json: { x: 1 } }, null, 'REF'), e => isRefusal(e) && /r\.json#/.test(e.message))
  const soft = { ...capOut([makePng(16, 8, varied)]), renderer: 'three' }
  assert.throws(() => buildCapturesRecord({ file: 'r.json', json: soft }, null, 'REF'), e => isRefusal(e) && /renderer/.test(e.message))
})

test('the record matches the m7-web CapturesRecord shape', () => {
  const pngs = [makePng(16, 8, varied, [2]), makePng(16, 8, () => [1, 2, 3])]
  const timing = { file: 't.json', json: { result: { p50Ms: 7.5, p95Ms: 9.25, frames: 600, adapter: { vendor: 'v', architecture: 'a', description: 'd', software: true } } } }
  const { record, pngs: files } = buildCapturesRecord({ file: 'c.json', json: capOut(pngs) }, timing, 'REF1')
  assert.deepEqual(Object.keys(record), ['renderer', 'adapter', 'software', 'pageRef', 'captures', 'frameTiming'])
  assert.equal(record.adapter, 'v | a | d')
  assert.equal(record.software, true)
  assert.equal(record.pageRef, 'REF1')
  assert.deepEqual(Object.keys(record.captures[0]), ['name', 'width', 'height', 'sha256', 'bytes', 'nonEmpty'])
  assert.match(record.captures[0].sha256, /^[0-9a-f]{64}$/)
  assert.equal(record.captures[0].bytes, pngs[0].length)
  assert.deepEqual(record.captures.map(c => c.nonEmpty), [true, false])
  assert.deepEqual(record.frameTiming, { width: 1920, height: 1080, frames: 600, p50Ms: 7.5, p95Ms: 9.25 })
  assert.deepEqual(files.map(f => f.name), ['round-0s', 'round-1s'])
  assert.equal(buildCapturesRecord({ file: 'c.json', json: capOut(pngs) }, null, 'R').record.frameTiming, null)
})
