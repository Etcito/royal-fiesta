import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import test from 'node:test'
import { deflateSync } from 'node:zlib'
import { OFFLINE_SCREENS, ONLINE_ONLY_SCREENS, SCREENS } from '../../packages/game/src/screens/nav.ts'
import { buildScreensRecord, type ScreensRecord } from '../uiTourRecord.ts'

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
function makePng(w: number, h: number, seed: number): Buffer {
  const rows: number[] = []
  for (let y = 0; y < h; y++) {
    rows.push(0)
    for (let x = 0; x < w; x++) rows.push((x * 37 + seed) & 255, (y * 11 + seed) & 255, (x ^ y ^ seed) & 255)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8
  ihdr[9] = 2
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(Buffer.from(rows))), chunk('IEND', Buffer.alloc(0))])
}

const SIZE = 4
const sha = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex')
const ADAPTER = { vendor: 'nvidia', architecture: 'ampere', description: 'NVIDIA GeForce RTX 3090', software: false }

// Fixture-free: the op output and every PNG live in memory; nothing is read from disk.
function tour(): { raw: Record<string, unknown>; pngs: Map<string, Uint8Array> } {
  const pngs = new Map<string, Uint8Array>()
  const captures = OFFLINE_SCREENS.map((screen, i) => {
    const png = makePng(SIZE, SIZE, i + 1)
    pngs.set(screen, png)
    return {
      screen,
      file: `${screen}.png`,
      inputs: i % 2 === 0
        ? [{ kind: 'key', key: 'Enter', events: ['keydown', 'keyup'] }]
        : [{ kind: 'click', target: 'act-play', x: 12.5, y: 8, events: ['pointerdown', 'click'] }],
      width: SIZE,
      height: SIZE,
      sha256: sha(png),
      bytes: png.length,
    }
  })
  return { raw: { renderer: 'raa', adapter: ADAPTER, software: false, captures, transitions: [] }, pngs }
}

function refused(fn: () => unknown, re: RegExp): void {
  assert.throws(fn, (e: unknown) => re.test((e as Error).message))
}

test('an in-memory uiTour output becomes one entry per offline SCREENS id, with the adapter facts', () => {
  const { raw, pngs } = tour()
  const rec: ScreensRecord = buildScreensRecord(raw, pngs)
  assert.equal(rec.format, 'royal-fiesta.ui-screens')
  assert.equal(rec.renderer, 'raa')
  assert.deepEqual(rec.adapter, ADAPTER)
  assert.deepEqual(rec.screens.map(s => s.screen), [...OFFLINE_SCREENS])
  assert.deepEqual(rec.onlineOnly, [...ONLINE_ONLY_SCREENS])
  assert.deepEqual([...OFFLINE_SCREENS, ...ONLINE_ONLY_SCREENS].sort(), [...SCREENS].sort())
  const loading = rec.screens.find(s => s.screen === 'loading')
  assert.ok(loading)
  assert.equal(loading.capture, 'out/ui/loading.png')
  assert.equal(loading.sha256, sha(pngs.get('loading') as Uint8Array))
  assert.equal(loading.width, SIZE)
  assert.equal(loading.height, SIZE)
  assert.equal(loading.inputs.length, 1)
  const hub = rec.screens.find(s => s.screen === 'hub')
  assert.deepEqual(hub?.inputs[0], { kind: 'click', target: 'act-play', x: 12.5, y: 8, events: ['pointerdown', 'click'] })
})

test('an online-only screen is not required and a capture of one is refused', () => {
  const { raw, pngs } = tour()
  assert.ok(!(raw.captures as { screen: string }[]).some(c => (ONLINE_ONLY_SCREENS as readonly string[]).includes(c.screen)))
  const withQueue = structuredClone(raw) as { captures: { screen: string }[] }
  withQueue.captures.push({ ...withQueue.captures[0], screen: 'queue' })
  refused(() => buildScreensRecord(withQueue, pngs), /screen 'queue': is online-only/)
})

test('a missing screen is refused and named', () => {
  const { raw, pngs } = tour()
  const captures = (raw.captures as { screen: string }[]).filter(c => c.screen !== 'round')
  pngs.delete('round')
  refused(() => buildScreensRecord({ ...raw, captures }, pngs), /screen 'round': has no capture/)
})

test('a screen-id mismatch is refused and names the screen', () => {
  const { raw, pngs } = tour()
  const unknown = structuredClone(raw) as { captures: { screen: string }[] }
  unknown.captures[0].screen = 'nope'
  refused(() => buildScreensRecord(unknown, pngs), /screen "nope": is not a SCREENS id/)
  const wrongFile = structuredClone(raw) as { captures: { screen: string; file: string }[] }
  const hub = wrongFile.captures.find(c => c.screen === 'hub')
  assert.ok(hub)
  hub.file = 'title.png'
  refused(() => buildScreensRecord(wrongFile, pngs), /screen 'hub': reports file "title.png", not 'hub\.png'/)
})

test('empty inputs are refused and name the screen', () => {
  const { raw, pngs } = tour()
  const empty = structuredClone(raw) as { captures: { screen: string; inputs: unknown[] }[] }
  const countdown = empty.captures.find(c => c.screen === 'countdown')
  assert.ok(countdown)
  countdown.inputs = []
  refused(() => buildScreensRecord(empty, pngs), /screen 'countdown': has no inputs/)
})

test('a missing PNG and a stale sha256 are refused and name the screen', () => {
  const { raw, pngs } = tour()
  const noPng = new Map(pngs)
  noPng.delete('podium')
  refused(() => buildScreensRecord(raw, noPng), /screen 'podium': is missing its capture out\/ui\/podium\.png/)
  const stale = structuredClone(raw) as { captures: { screen: string; sha256: string }[] }
  const credits = stale.captures.find(c => c.screen === 'credits')
  assert.ok(credits)
  credits.sha256 = '0'.repeat(64)
  refused(() => buildScreensRecord(stale, pngs), /screen 'credits': PNG sha256 [0-9a-f]{64} does not match/)
})

test('an absolute path or the GPU token is never written', () => {
  const { raw, pngs } = tour()
  const absolute = structuredClone(raw) as { captures: { screen: string; inputs: { kind?: string; key?: string }[] }[] }
  const title = absolute.captures.find(c => c.screen === 'title')
  assert.ok(title)
  title.inputs[0] = { kind: 'key', key: '/etc/passwd' }
  refused(() => buildScreensRecord(absolute, pngs), /would contain the absolute path/)
  const token = structuredClone(raw) as { adapter: { description: string } }
  token.adapter.description = 'token-abc'
  process.env.NMC_GPU_TOKEN = 'token-abc'
  try {
    refused(() => buildScreensRecord(token, pngs), /would contain the GPU token/)
  } finally {
    delete process.env.NMC_GPU_TOKEN
  }
})

test('an adapter whose description Chrome masks (empty string) is recorded', () => {
  const { raw, pngs } = tour()
  const masked = structuredClone(raw) as { adapter: { description: string } }
  masked.adapter.description = ''
  const record = buildScreensRecord(masked, pngs) as { adapter: { vendor: string; description: string } }
  assert.equal(record.adapter.vendor, 'nvidia')
  assert.equal(record.adapter.description, '')
})
