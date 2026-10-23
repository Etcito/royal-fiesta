import assert from 'node:assert/strict'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { repoRoot } from '../bricks.ts'
import { VIEW_YAWS, buildViewsRecord, main, viewsProblems, type ViewsInput } from '../viewsRecord.ts'

// PNG writer modelled on apps/headless/test/gpuRecord.test.ts (8-bit RGB, filter 0).
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
function makePng(w: number, h: number, px: (x: number, y: number) => number[]): Buffer {
  const rows: number[] = []
  for (let y = 0; y < h; y++) {
    rows.push(0)
    for (let x = 0; x < w; x++) rows.push(...px(x, y))
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))])
}

const SIZE = 8
const BODY = 'assets/common/penguin.body.asset.json'
const varied = (x: number, y: number): number[] => [(x * 37) & 255, (y * 11) & 255, (x ^ y) & 255]

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'views-record-'))
  mkdirSync(join(root, 'assets/common'), { recursive: true })
  copyFileSync(join(repoRoot(), BODY), join(root, BODY))
  mkdirSync(join(root, 'out/c2'), { recursive: true })
  writeFileSync(join(root, 'out/c2/penguin-front.png'), makePng(SIZE, SIZE, varied))
  writeFileSync(join(root, 'out/c2/penguin-back.png'), makePng(SIZE, SIZE, () => [90, 90, 90]))
  return root
}

const input = (): ViewsInput => ({
  format: 'royal-fiesta.views-input', version: 1, out: 'out/c2', width: SIZE, height: SIZE,
  subjects: [{ name: 'penguin', assets: ['penguin.body'], views: ['front', 'back'] }],
})

const assetHash = (): string => JSON.parse(readFileSync(join(repoRoot(), BODY), 'utf8')).hash

test('the record hashes the asset and flags a uniform view as empty', async () => {
  const root = tempRoot()
  const rec = await buildViewsRecord(input(), root)
  assert.equal(rec.tool, 'sdfm')
  assert.deepEqual(rec.camera, { fovYDeg: 30, yaws: VIEW_YAWS })
  const s = rec.subjects[0]
  assert.deepEqual(s.assets, { 'penguin.body': assetHash() })
  assert.deepEqual(s.views.map(v => [v.name, v.png, v.nonEmpty]),
    [['front', 'out/c2/penguin-front.png', true], ['back', 'out/c2/penguin-back.png', false]])
  assert.equal(s.views[0].bytes, readFileSync(join(root, 'out/c2/penguin-front.png')).length)
  assert.match(s.views[0].sha256, /^[0-9a-f]{64}$/)
})

test('viewsProblems is empty when fresh and reports a stale hash', async () => {
  const root = tempRoot()
  writeFileSync(join(root, 'out/c2/penguin-back.png'), makePng(SIZE, SIZE, varied))
  const rec = await buildViewsRecord(input(), root)
  // The small test PNGs are fine except for the 1024 size rule, so set the size the proof expects.
  for (const v of rec.subjects[0].views) { v.width = 1024; v.height = 1024 }
  assert.deepEqual(await viewsProblems(rec, root), [])
  rec.subjects[0].assets['penguin.body'] = '0'.repeat(64)
  const problems = await viewsProblems(rec, root)
  assert.equal(problems.length, 1)
  assert.match(problems[0], /penguin: asset penguin\.body .*stale record; re-render/)
})

test('viewsProblems reports size, emptiness, missing views and a missing asset', async () => {
  const root = tempRoot()
  const rec = await buildViewsRecord(input(), root)
  rec.subjects.push({ name: 'ghost', assets: { 'costume.ghost': 'x' }, views: [] })
  const problems = await viewsProblems(rec, root)
  assert.ok(problems.some(p => p.includes('penguin/front: 8x8, not 1024x1024')))
  assert.ok(problems.some(p => p.includes('penguin/back: out/c2/penguin-back.png is empty')))
  assert.ok(problems.some(p => p.startsWith('ghost: asset costume.ghost:') && p.includes('no file')))
  assert.ok(problems.some(p => p.startsWith('ghost: no views')))
})

async function runMain(root: string, json: unknown): Promise<{ code: number; err: string[] }> {
  mkdirSync(join(root, 'proofs/c2'), { recursive: true })
  writeFileSync(join(root, 'proofs/c2/views.input.json'), JSON.stringify(json))
  const cwd = process.cwd()
  const err: string[] = []
  const log = console.log
  const error = console.error
  console.log = () => {}
  console.error = (m: string) => { err.push(m) }
  try {
    process.chdir(root)
    return { code: await main(['proofs/c2/views.input.json']), err }
  } finally {
    process.chdir(cwd)
    console.log = log
    console.error = error
  }
}

test('main writes views.json next to the input with a trailing newline', async () => {
  const root = tempRoot()
  const { code } = await runMain(root, input())
  assert.equal(code, 0)
  const text = readFileSync(join(root, 'proofs/c2/views.json'), 'utf8')
  assert.ok(text.endsWith('}\n'))
  assert.equal(text, JSON.stringify(await buildViewsRecord(input(), root), null, 2) + '\n')
})

test('a bad view name and a duplicate subject are refused with the pointer', async () => {
  const root = tempRoot()
  const badView = input() as unknown as { subjects: { views: string[] }[] }
  badView.subjects[0].views = ['front', 'side']
  const a = await runMain(root, badView)
  assert.equal(a.code, 1)
  assert.match(a.err[0], /^\[views\] proofs\/c2\/views\.input\.json#\/subjects\/0\/views\/1: view "side" is not one of/)
  const dup = input()
  dup.subjects.push({ ...dup.subjects[0] })
  const b = await runMain(root, dup)
  assert.equal(b.code, 1)
  assert.match(b.err[0], /^\[views\] proofs\/c2\/views\.input\.json#\/subjects\/1\/name: duplicate subject 'penguin'/)
})

test('a size that is not a positive integer and an unknown key are refused', async () => {
  const root = tempRoot()
  const a = await runMain(root, { ...input(), width: 0 })
  assert.match(a.err[0], /#\/width: width is 0, not a positive integer/)
  const b = await runMain(root, { ...input(), extra: 1 })
  assert.match(b.err[0], /#\/extra: unknown key 'extra'/)
})
