// Frame probe (docs/wavedash.md, "Frame probe"): off by default. `?probe=1` (or a build made with VITE_RF_PROBE=1,
// since the Wavedash page cannot carry a query into its frame) runs it next to the game. It tells what the frame
// allows, which the Wavedash docs leave open (R7, R10): a WebSocket to a public echo server, WebRTC ICE gathering
// from a public STUN server, third-party fetches (CORS, and no-cors which COEP blocks without CORP), CSP violations,
// isolation and storage. Each result goes to the console as `[probe] <item> <json>` and to a corner panel.
// With the probe on, Wavedash.init() is called at once so the panel is visible even if the boot stalls.
import { wavedashReady, wavedashSdk } from './wavedash.ts'

// Two public echo servers: echo.websocket.events did not answer on 2026-10-30, ws.postman-echo.com did (101).
export const PROBE_WS: readonly string[] = ['wss://echo.websocket.events', 'wss://ws.postman-echo.com/raw']
export const PROBE_STUN = 'stun:stun.l.google.com:19302'
export const PROBE_CORS = 'https://api.github.com/zen'
export const PROBE_NO_CORS = 'https://www.google.com/favicon.ico'
const ITEM_MS = 8000

// VITE_RF_PROBE is read here, not in main.ts (a test evaluates main.ts as a script, where import.meta is invalid).
function buildProbeFlag(): string | undefined {
  return (import.meta as { env?: Record<string, string | undefined> }).env?.VITE_RF_PROBE
}

export function probeWanted(search: string, buildFlag: string | undefined = buildProbeFlag()): boolean {
  const v = new URLSearchParams(search).get('probe')
  return v === '1' || (v === null && buildFlag === '1')
}

export type ProbeResult = Record<string, unknown>

/** One panel line per item: `<item>: <json>`, long values cut so the panel stays readable. */
export function probeLine(item: string, r: ProbeResult): string {
  const text = JSON.stringify(r)
  return `${item}: ${text.length > 400 ? `${text.slice(0, 400)}...` : text}`
}

function messageOf(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e)
}

function timeout<T>(ms: number, value: T): Promise<T> {
  return new Promise(resolve => setTimeout(() => resolve(value), ms))
}

function envProbe(): ProbeResult {
  let top: string
  try {
    top = window.top === window ? 'self (not framed)' : `framed, top readable: ${String(window.top?.location.href).slice(0, 40)}`
  } catch (e) {
    top = `framed, cross-origin top (${messageOf(e).slice(0, 60)})`
  }
  const sdk = wavedashSdk()
  let launch: unknown = null
  try { launch = sdk?.getLaunchParams ? Object.keys(sdk.getLaunchParams() as object ?? {}) : null } catch (e) { launch = messageOf(e) }
  return {
    origin: location.origin, queryKeys: [...new URLSearchParams(location.search).keys()], top,
    crossOriginIsolated: self.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer, secure: self.isSecureContext,
    webgpu: 'gpu' in navigator, serviceWorker: 'serviceWorker' in navigator, wavedash: sdk !== null, launchParamKeys: launch,
  }
}

async function headersProbe(): Promise<ProbeResult> {
  try {
    const r = await fetch(location.href, { cache: 'no-store' })
    const h = (k: string): string | null => r.headers.get(k)
    return {
      status: r.status, csp: h('content-security-policy'), coep: h('cross-origin-embedder-policy'), coop: h('cross-origin-opener-policy'),
      corp: h('cross-origin-resource-policy'), permissionsPolicy: h('permissions-policy'),
    }
  } catch (e) {
    return { error: messageOf(e) }
  }
}

async function storageProbe(): Promise<ProbeResult> {
  const out: ProbeResult = {}
  try { localStorage.setItem('rf-probe', '1'); localStorage.removeItem('rf-probe'); out.localStorage = 'ok' } catch (e) { out.localStorage = messageOf(e) }
  out.indexedDB = await Promise.race([
    new Promise<string>(resolve => {
      try {
        const req = indexedDB.open('rf-probe')
        req.onsuccess = () => { req.result.close(); resolve('ok') }
        req.onerror = () => resolve(`error: ${req.error?.message ?? 'unknown'}`)
        req.onblocked = () => resolve('blocked')
      } catch (e) { resolve(messageOf(e)) }
    }),
    timeout(ITEM_MS, 'no answer in 8 s'),
  ])
  return out
}

function wsProbe(url: string): Promise<ProbeResult> {
  const t0 = performance.now()
  return new Promise(resolve => {
    let ws: WebSocket
    const done = (r: ProbeResult): void => {
      clearTimeout(timer)
      try { ws.close() } catch { /* already closed */ }
      resolve({ url, ms: Math.round(performance.now() - t0), ...r })
    }
    const timer = setTimeout(() => done({ result: 'no answer in 8 s', readyState: ws?.readyState }), ITEM_MS)
    try {
      ws = new WebSocket(url)
    } catch (e) {
      done({ result: 'blocked (constructor threw)', error: messageOf(e) })
      return
    }
    let opened = false
    ws.onopen = () => { opened = true; ws.send('royal-fiesta probe') }
    ws.onmessage = e => done({ result: 'allowed', firstMessage: String(e.data).slice(0, 80) })
    ws.onerror = () => { if (!opened) done({ result: 'blocked or unreachable (error before open)' }) }
    ws.onclose = e => done({ result: opened ? 'closed after open' : 'closed before open', code: e.code })
  })
}

async function rtcProbe(): Promise<ProbeResult> {
  if (typeof RTCPeerConnection === 'undefined') return { result: 'RTCPeerConnection undefined' }
  const t0 = performance.now()
  let pc: RTCPeerConnection
  try {
    pc = new RTCPeerConnection({ iceServers: [{ urls: PROBE_STUN }] })
  } catch (e) {
    return { result: 'blocked (constructor threw)', error: messageOf(e) }
  }
  const types = new Set<string>()
  const errors: string[] = []
  pc.onicecandidateerror = e => errors.push(`${(e as RTCPeerConnectionIceErrorEvent).errorCode} ${(e as RTCPeerConnectionIceErrorEvent).errorText}`.slice(0, 80))
  const gathered = new Promise<string>(resolve => {
    pc.onicecandidate = e => {
      if (e.candidate === null) resolve('complete')
      else types.add(e.candidate.type ?? /typ (\w+)/.exec(e.candidate.candidate)?.[1] ?? '?')
    }
  })
  try {
    pc.createDataChannel('probe')
    await pc.setLocalDescription(await pc.createOffer())
  } catch (e) {
    pc.close()
    return { result: 'offer failed', error: messageOf(e) }
  }
  const state = await Promise.race([gathered, timeout(ITEM_MS, 'not complete in 8 s')])
  pc.close()
  return {
    stun: PROBE_STUN, gathering: state, candidateTypes: [...types], ms: Math.round(performance.now() - t0),
    result: types.has('srflx') ? 'STUN reachable (srflx candidate)' : 'no srflx candidate (STUN blocked or unreachable)', errors: errors.slice(0, 3),
  }
}

async function fetchProbe(url: string, mode: RequestMode): Promise<ProbeResult> {
  const t0 = performance.now()
  try {
    const r = await Promise.race([fetch(url, { mode, cache: 'no-store' }), timeout(ITEM_MS, null)])
    if (r === null) return { url, mode, result: 'no answer in 8 s' }
    return { url, mode, result: 'allowed', status: r.status, type: r.type, ms: Math.round(performance.now() - t0) }
  } catch (e) {
    return { url, mode, result: 'blocked', error: messageOf(e), ms: Math.round(performance.now() - t0) }
  }
}

function panel(): (line: string) => void {
  const pre = document.createElement('pre')
  pre.id = 'rf-probe'
  pre.style.cssText = 'position: fixed; left: 8px; top: 8px; z-index: 60; max-width: min(720px, 92vw); max-height: 70vh; overflow: auto;'
    + ' margin: 0; padding: 8px; pointer-events: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: rgba(0, 0, 0, 0.8);'
    + ' color: #9effa8; font: 11px ui-monospace, monospace; border-radius: 6px'
  pre.textContent = 'Royal Fiesta frame probe\n'
  document.body.append(pre)
  return line => { pre.textContent += `${line}\n` }
}

export async function runProbe(): Promise<Record<string, ProbeResult>> {
  const show = panel()
  const results: Record<string, ProbeResult> = {}
  const report = (item: string, r: ProbeResult): void => {
    results[item] = r
    console.info(`[probe] ${item}`, JSON.stringify(r))
    show(probeLine(item, r))
  }
  const violations: ProbeResult[] = []
  document.addEventListener('securitypolicyviolation', e => {
    const v = { directive: e.effectiveDirective, blocked: e.blockedURI, source: e.sourceFile, disposition: e.disposition }
    violations.push(v)
    report('csp-violation', v)
  })
  report('wavedash-init', { result: wavedashReady() })
  report('env', envProbe())
  report('headers', await headersProbe())
  report('storage', await storageProbe())
  const [ws, rtc, cors, noCors] = await Promise.all([
    Promise.all(PROBE_WS.map(wsProbe)), rtcProbe(), fetchProbe(PROBE_CORS, 'cors'), fetchProbe(PROBE_NO_CORS, 'no-cors'),
  ])
  ws.forEach((r, i) => report(`websocket-${i + 1}`, r))
  report('webrtc', rtc)
  report('fetch-cors', cors)
  report('fetch-no-cors', noCors)
  report('summary', { cspViolations: violations.length, items: Object.keys(results).length })
  return results
}
