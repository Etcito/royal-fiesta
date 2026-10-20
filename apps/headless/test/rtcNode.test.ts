import { test } from 'node:test'
import assert from 'node:assert/strict'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { RtcChannel, RtcPeer } from '@royal-fiesta/game/net/rtcBackend'
import { closeNodeRtc, nodeRtcBackend } from '../src/rtcNode.ts'

// The sandbox only has `lo`: without bindAddress, libdatachannel gathers no candidate.
const BIND = '127.0.0.1'
const COUNT = 100
const OPEN_MS = 10_000

function wire(from: RtcPeer, to: RtcPeer): void {
  from.onIce((c) => { if (c) to.addIce(c) })
}

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const t = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new RefusalError('rtc-node', `bindAddress ${BIND}`, `${what} not open within ${ms} ms on loopback; check that node-datachannel loads and that ${BIND} accepts UDP`)), ms)
  })
  return Promise.race([p, t]).finally(() => clearTimeout(timer))
}

function payload(i: number): Uint8Array {
  const b = new Uint8Array(4 + (i % 17))
  new DataView(b.buffer).setUint32(0, i, true)
  for (let k = 4; k < b.length; k++) b[k] = (i * 31 + k) & 255
  return b
}

function collect(ch: RtcChannel, n: number, ms: number): Promise<Uint8Array[]> {
  const got: Uint8Array[] = []
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(got), ms)
    ch.onMessage((d) => {
      got.push(d)
      if (got.length === n) { clearTimeout(timer); resolve(got) }
    })
  })
}

test('two node-datachannel peers on loopback exchange 100 messages per channel', async () => {
  const backend = nodeRtcBackend({ bindAddress: BIND })
  let a: RtcPeer | undefined
  let b: RtcPeer | undefined
  try {
    a = backend.createPeer([], true)
    b = backend.createPeer([], false)
    wire(a, b)
    wire(b, a)
    const [pa, pb] = [a, b]
    const open = (async () => {
      await pa.acceptAnswer(await pb.acceptOffer(await pa.createOffer()))
      return Promise.all([pa.channels(), pb.channels()])
    })()
    const [ca, cb] = await withTimeout(open, OPEN_MS, 'channels fast+reliable')
    assert.equal(ca.fast.label, 'fast')
    assert.equal(cb.reliable.label, 'reliable')
    assert.ok(ca.fast.open && ca.reliable.open && cb.fast.open && cb.reliable.open)

    const relIn = collect(cb.reliable, COUNT, 5000)
    const fastIn = collect(cb.fast, COUNT, 2000)
    const backIn = collect(ca.reliable, 1, 5000)
    for (let i = 0; i < COUNT; i++) {
      ca.reliable.send(payload(i))
      ca.fast.send(payload(i))
    }
    cb.reliable.send(payload(7))

    const rel = await relIn
    assert.equal(rel.length, COUNT)
    for (let i = 0; i < COUNT; i++) assert.deepEqual(rel[i], payload(i), `reliable message ${i}`)

    const fast = await fastIn
    assert.ok(fast.length >= 95, `fast delivered ${fast.length}/${COUNT} on loopback`)
    for (const d of fast) {
      assert.ok(d instanceof Uint8Array && !Buffer.isBuffer(d), 'a fresh Uint8Array, not a Buffer')
      assert.deepEqual(d, payload(new DataView(d.buffer, d.byteOffset).getUint32(0, true)))
    }

    assert.deepEqual(await backIn, [payload(7)])
  } finally {
    a?.close()
    b?.close()
    closeNodeRtc()
  }
})
