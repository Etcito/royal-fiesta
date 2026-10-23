import assert from 'node:assert/strict'
import test from 'node:test'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { onlinePlayUrl, probeRelay } from '../src/screens/online.ts'
import type { WsFactory, WsLike } from '../src/net/ws.ts'

type Behaviour = 'open' | 'error' | 'close' | 'never'

// Fake socket that opens, errors, closes or stays silent on the next microtask.
class FakeWs implements WsLike {
  readyState = 0
  closed = false
  onopen: (() => void) | null = null
  onmessage: ((e: { data: unknown }) => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  constructor(how: Behaviour) {
    queueMicrotask(() => {
      if (how === 'open') { this.readyState = 1; this.onopen?.() }
      if (how === 'error') { this.onerror?.(new Error('refused')); this.close(1006) }
      if (how === 'close') this.close(1006, 'gone')
    })
  }
  send(): void {}
  close(code = 1000, reason = ''): void {
    if (this.closed) return
    this.closed = true
    this.readyState = 3
    this.onclose?.({ code, reason })
  }
}

function factory(how: Behaviour): { ws: WsFactory; made: FakeWs[]; urls: string[] } {
  const made: FakeWs[] = []
  const urls: string[] = []
  return { made, urls, ws: (url) => { urls.push(url); const s = new FakeWs(how); made.push(s); return s } }
}

const URL = 'ws://127.0.0.1:8787/ws'

test('a socket that opens gives ok and is closed after the probe', async () => {
  const f = factory('open')
  assert.deepEqual(await probeRelay(URL, f.ws, 1000), { ok: true })
  assert.deepEqual(f.urls, [URL])
  assert.equal(f.made[0].closed, true)
})

for (const how of ['error', 'close'] as const) {
  test(`a socket that ${how}s before open gives ok:false with an [online] message`, async () => {
    const r = await probeRelay(URL, factory(how).ws, 1000)
    assert.equal(r.ok, false)
    if (r.ok) return
    assert.ok(r.message.startsWith(`[online] ${URL}: could not reach the GameSaloon relay (`), r.message)
    assert.ok(r.message.includes('choose Play to play against bots'), r.message)
  })
}

test('a socket that never opens times out within 1 s', async () => {
  const f = factory('never')
  const t0 = performance.now()
  const r = await probeRelay(URL, f.ws, 50)
  assert.ok(performance.now() - t0 < 1000)
  assert.equal(r.ok, false)
  assert.ok(!r.ok && r.message.includes('[online]') && r.message.includes(URL) && r.message.includes('50 ms'), JSON.stringify(r))
  assert.equal(f.made[0].closed, true)
})

test('a bad URL is refused without creating a socket', async () => {
  for (const bad of ['', 'http://host/ws', 'ws://', 'localhost:8787']) {
    const f = factory('open')
    const r = await probeRelay(bad, f.ws, 50)
    assert.deepEqual(r, { ok: false, message: `[online] server: '${bad}' is not a ws:// or wss:// URL; pass ?server=ws://host:port/ws on game.html` })
    assert.equal(f.made.length, 0)
  }
})

test('onlinePlayUrl encodes the query and refuses what play.html would refuse', () => {
  assert.equal(onlinePlayUrl('ws://h:1/ws?x=1&y', 'Bé an&co', 7), 'play.html?server=ws%3A%2F%2Fh%3A1%2Fws%3Fx%3D1%26y&name=B%C3%A9%20an%26co&colour=7')
  const q = new URLSearchParams(onlinePlayUrl(URL, 'Bean', 0).slice('play.html?'.length))
  assert.deepEqual([q.get('server'), q.get('name'), q.get('colour')], [URL, 'Bean', '0'])
  for (const [name, colour] of [['', 0], ['x'.repeat(25), 0], ['Bean', -1], ['Bean', 8], ['Bean', 1.5]] as const) {
    assert.throws(() => onlinePlayUrl(URL, name, colour), (e) => isRefusal(e) && e.message.startsWith('[online] '))
  }
})
