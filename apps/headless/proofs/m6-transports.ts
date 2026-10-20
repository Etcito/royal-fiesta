import os from 'node:os'
import { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import { RelayClient } from '@royal-fiesta/game/net/relayClient'
import { globalWsFactory } from '@royal-fiesta/game/net/ws'
import type { WsFactory, WsLike } from '@royal-fiesta/game/net/ws'
import { helloHandshake, startGameSaloon } from '../src/gamesaloon.ts'
import type { LocalServer } from '../src/gamesaloon.ts'
import { report, runProof } from '../src/proofkit.ts'
import type { CheckResult, ProofCheck, ProofMode } from '../src/proofkit.ts'
import { runRealCase } from '../src/realMatch.ts'
import type { RealCase } from '../src/realMatch.ts'

const REFUSAL_MS = 50
const QUIET_MS = 300
const STEP_QUIET_MS = 100
const PAYLOAD = { g: 'royal-fiesta', v: 1, name: 'bot', c: 0 } as const

// One GameSaloon for the whole run, stopped after runProof.
let serverP: Promise<LocalServer> | null = null
const server = (): Promise<LocalServer> => (serverP ??= startGameSaloon())

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

interface Tap { factory: WsFactory; logs: string[][]; sent: number; lastRecv: number }

// Wraps a factory so every socket records the `t` of each server frame and counts sent frames.
function tap(inner: WsFactory): Tap {
  const t: Tap = { factory: (url) => wrap(inner(url)), logs: [], sent: 0, lastRecv: performance.now() }
  function wrap(s: WsLike): WsLike {
    const log: string[] = []
    t.logs.push(log)
    return {
      get readyState() { return s.readyState },
      send(data) { t.sent++; s.send(data) },
      close(code, reason) { s.close(code, reason) },
      get onopen() { return s.onopen },
      set onopen(fn) { s.onopen = fn },
      get onclose() { return s.onclose },
      set onclose(fn) { s.onclose = fn },
      get onerror() { return s.onerror },
      set onerror(fn) { s.onerror = fn },
      get onmessage() { return s.onmessage },
      set onmessage(fn) {
        s.onmessage = fn === null ? null : (e) => {
          t.lastRecv = performance.now()
          let ty = '?'
          try { ty = String((JSON.parse(String(e.data)) as { t?: unknown }).t) } catch { ty = 'non-json' }
          log.push(ty)
          fn(e)
        }
      },
    }
  }
  return t
}

async function checkRelay8Refused(): Promise<CheckResult> {
  const s = await server()
  const t = tap(globalWsFactory())
  const client = new RelayClient(s.url, t.factory)
  await client.connect()
  const sentBefore = t.sent
  const t0 = performance.now()
  let message = ''
  let name = ''
  try {
    await client.queue(8, PAYLOAD)
  } catch (e) {
    name = (e as Error).name
    message = (e as Error).message
  }
  const elapsed = performance.now() - t0
  const frames = t.sent - sentBefore
  client.close()
  const pass = name === 'RefusalError' && message.includes('capped at 4') && elapsed < REFUSAL_MS && frames === 0
  return {
    value: `${elapsed.toFixed(3)}ms`,
    threshold: `RefusalError 'capped at 4' in <${REFUSAL_MS}ms, 0 frames sent`,
    pass,
    notes: [message === '' ? 'queue(8) did not throw' : message, `error=${name || 'none'} framesSent=${frames}`],
  }
}

// The scripted relay scenario; `settle` waits until the relay is quiet.
async function scenario(factory: WsFactory, url: string, settle: (ms: number) => Promise<void>): Promise<void> {
  const clients = [0, 1, 2, 3].map(() => new RelayClient(url, factory))
  try {
    for (const c of clients) await c.connect()
    const code = await clients[0].create(4)
    await settle(STEP_QUIET_MS)
    await clients[1].join(code)
    await settle(STEP_QUIET_MS)
    clients[0].act({ k: 'pre', from: 0 })
    await settle(STEP_QUIET_MS)
    await clients[2].join(code)
    await settle(STEP_QUIET_MS)
    await clients[3].join(code)
    await settle(STEP_QUIET_MS)
    for (let k = 0; k < 4; k++) {
      clients[k].act({ k: 'post', from: k })
      await settle(STEP_QUIET_MS)
    }
    clients[3].bye()
    await settle(QUIET_MS)
  } finally {
    for (const c of clients) c.close()
  }
}

async function realQuiet(t: Tap, ms: number): Promise<void> {
  const start = performance.now()
  for (;;) {
    const idle = performance.now() - Math.max(t.lastRecv, start)
    if (idle >= ms) return
    await sleep(ms - idle)
  }
}

function firstDiff(a: string[][], b: string[][]): string | null {
  for (let k = 0; k < Math.max(a.length, b.length); k++) {
    const x = a[k] ?? [], y = b[k] ?? []
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
      if (x[i] !== y[i]) return `client ${k} frame ${i}: real=${x[i] ?? '<none>'} loopback=${y[i] ?? '<none>'}`
    }
  }
  return null
}

async function checkLoopbackConformance(): Promise<CheckResult> {
  const s = await server()
  const real = tap(globalWsFactory())
  await scenario(real.factory, s.url, (ms) => realQuiet(real, ms))
  const relay = new LoopbackRelay({ seed: 1 })
  const loop = tap(relay.factory())
  await scenario(loop.factory, 'loopback://relay', async () => {
    for (let i = 0; i < 4; i++) { relay.pump(); await sleep(0) }
  })
  // Snapshot before comparing: closes may still deliver frames.
  const a = real.logs.map(l => l.slice())
  const b = loop.logs.map(l => l.slice())
  const diff = firstDiff(a, b)
  const notes = a.map((l, k) => `real client ${k}: ${l.join(',')}`)
  if (diff !== null) {
    notes.unshift(`first diff: ${diff}`)
    b.forEach((l, k) => notes.push(`loopback client ${k}: ${l.join(',')}`))
  }
  return {
    value: diff === null ? `identical frames=${a.map(l => l.length).join('/')}` : 'diverged',
    threshold: 'identical per-client t sequences',
    pass: diff === null && a.length === 4 && b.length === 4,
    notes,
  }
}

const machine = os.cpus()[0]?.model ?? 'unknown'

async function matchCases(mode: ProofMode, cases: RealCase[]): Promise<CheckResult> {
  const s = await server()
  const parts: string[] = []
  const notes: string[] = []
  let pass = true
  for (const c of cases) {
    try {
      const r = await runRealCase(s, c)
      const ts = r.transportStats
      report(c.label, {
        rollbackMsP99: r.frameMsP99.toFixed(3), rollbackMsMean: r.frameMsMean.toFixed(3),
        rollbacks: r.rollbacks, resimTicks: r.resimTicks, resimPerTick: r.resimPerTick.toFixed(4),
        actsPerSec: ts.actsPerSec === undefined ? 'n/a' : ts.actsPerSec.toFixed(1),
        ...(ts.packetsPerSec === undefined ? {} : { packetsPerSec: ts.packetsPerSec.toFixed(1) }),
        ticks: r.ticks, wallS: (r.wallMs / 1000).toFixed(1), mode, node: process.version, machine: JSON.stringify(machine),
      })
      const w = r.winners[0]
      const ok = r.mismatches === 0 && r.winners.every(x => x === w) && w >= 0 && r.logsEqual
      parts.push(`${c.label}:mismatches=${r.mismatches},winner=${r.winners.every(x => x === w) ? w : r.winners.join('/')}`)
      notes.push(`${c.label}: ticksCompared=${r.ticksCompared} seed=${r.seed} stalls=${r.stalls} maxDelay=${r.maxDelay}`)
      if (!ok) {
        pass = false
        notes.push(`${c.label}: firstMismatch=${r.firstMismatch} winners=[${r.winners.join(',')}] logsEqual=${r.logsEqual}`)
      }
    } catch (e) {
      const err = e as { name?: string; message?: string; stack?: string }
      pass = false
      parts.push(`${c.label}:failed`)
      notes.push(err?.name === 'RefusalError' ? String(err.message) : String(err?.stack ?? e).split('\n').slice(0, 6).join('\n  '))
    }
  }
  return { value: parts.join(' '), threshold: 'mismatches=0, all done, same winner >= 0, logsEqual', pass, notes }
}

async function checkRelay4(mode: ProofMode): Promise<CheckResult> {
  const s = await server()
  const hello = await helloHandshake(s)
  if (!hello.startsWith('OK: created room')) {
    return { value: 'handshake-failed', threshold: "'OK: created room ...'", pass: false, notes: [hello] }
  }
  const r = await matchCases(mode, [{ label: 'relay-4', transport: 'relay', clients: 4, profile: 'sprint' }])
  return { ...r, notes: [hello, ...(r.notes ?? [])] }
}

function checkWebRtc(mode: ProofMode): Promise<CheckResult> {
  return matchCases(mode, [
    { label: 'webrtc-4', transport: 'webrtc', clients: 4, profile: 'sprint' },
    { label: 'webrtc-8', transport: 'webrtc', clients: 8, profile: 'sprint' },
  ])
}

// Every check is marked timing so runProof keeps them in this process: they share one
// GameSaloon and run in real time, one after another.
const checks: ProofCheck[] = [
  { label: 'relay-8-refused', inQuick: true, timing: true, run: () => checkRelay8Refused() },
  { label: 'loopback-conformance', inQuick: true, timing: true, run: () => checkLoopbackConformance() },
  { label: 'relay-4', inQuick: true, timing: true, run: (mode) => checkRelay4(mode) },
  { label: 'webrtc', inQuick: true, timing: true, run: (mode) => checkWebRtc(mode) },
]

try {
  await runProof('m6-transports', import.meta.url, checks)
} finally {
  // The cast undoes TS narrowing serverP to null: it is assigned inside server().
  const started = serverP as Promise<LocalServer> | null
  if (started !== null) {
    try { await (await started).stop() } catch { /* start failed: the check already printed why */ }
  }
}
// Stray sockets or timers must not keep the proof alive after the summary.
process.exit(process.exitCode ?? 0)
