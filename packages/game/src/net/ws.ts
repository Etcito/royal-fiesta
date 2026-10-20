// WebSocket port: the game reaches the global WebSocket only through this factory, at call time.
import { refuse } from '@royal-fiesta/sim/refusal'

export interface WsLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: (() => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code: number; reason: string }) => void) | null
  onerror: ((e: unknown) => void) | null
}

export type WsFactory = (url: string) => WsLike

interface GlobalWs {
  readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((e: unknown) => void) | null
  onmessage: ((e: { data: unknown }) => void) | null
  onclose: ((e: { code: number; reason: string }) => void) | null
  onerror: ((e: unknown) => void) | null
}

type GlobalWsCtor = new (url: string) => GlobalWs

export function globalWsFactory(): WsFactory {
  const Ctor = (globalThis as { WebSocket?: GlobalWsCtor }).WebSocket
  if (typeof Ctor !== 'function') {
    refuse('ws', 'globalThis.WebSocket', 'no global WebSocket in this runtime; use Node >= 22 or inject a WsFactory')
  }
  return (url) => wrap(new Ctor(url))
}

function wrap(sock: GlobalWs): WsLike {
  const w: WsLike = {
    get readyState() { return sock.readyState },
    send(data) { sock.send(data) },
    close(code, reason) { sock.close(code, reason) },
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  }
  // Handlers are read at event time so callers may assign them after creation.
  sock.onopen = () => { w.onopen?.() }
  sock.onmessage = (e) => { w.onmessage?.({ data: e.data }) }
  sock.onclose = (e) => { w.onclose?.({ code: e.code, reason: e.reason }) }
  sock.onerror = (e) => { w.onerror?.(e) }
  return w
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'
const DECODE = new Int16Array(128).fill(-1)
for (let i = 0; i < 64; i++) DECODE[ALPHABET.charCodeAt(i)] = i

// Pure JS (no Buffer): packages/game must run in the browser too.
export function bytesToB64(b: Uint8Array): string {
  const parts: string[] = []
  let chunk = ''
  const full = b.length - (b.length % 3)
  for (let i = 0; i < full; i += 3) {
    const v = (b[i] << 16) | (b[i + 1] << 8) | b[i + 2]
    chunk += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + ALPHABET[v & 63]
    if (chunk.length >= 4096) { parts.push(chunk); chunk = '' }
  }
  const rest = b.length - full
  if (rest === 1) {
    const v = b[full] << 16
    chunk += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + '=='
  } else if (rest === 2) {
    const v = (b[full] << 16) | (b[full + 1] << 8)
    chunk += ALPHABET[v >> 18] + ALPHABET[(v >> 12) & 63] + ALPHABET[(v >> 6) & 63] + '='
  }
  parts.push(chunk)
  return parts.join('')
}

export function b64ToBytes(s: string): Uint8Array {
  if (s.length % 4 !== 0) refuse('ws', 'base64', `length ${s.length} is not a multiple of 4; send padded standard base64`)
  let pad = 0
  if (s.length > 0 && s[s.length - 1] === '=') pad = s[s.length - 2] === '=' ? 2 : 1
  const out = new Uint8Array((s.length / 4) * 3 - pad)
  let o = 0
  for (let i = 0; i < s.length; i += 4) {
    const last = i + 4 === s.length
    const a = sextet(s, i)
    const b = sextet(s, i + 1)
    const c = last && pad === 2 ? 0 : sextet(s, i + 2)
    const d = last && pad >= 1 ? 0 : sextet(s, i + 3)
    const v = (a << 18) | (b << 12) | (c << 6) | d
    out[o++] = v >> 16
    if (o < out.length) out[o++] = (v >> 8) & 255
    if (o < out.length) out[o++] = v & 255
  }
  return out
}

function sextet(s: string, i: number): number {
  const code = s.charCodeAt(i)
  const v = code < 128 ? DECODE[code] : -1
  if (v < 0) refuse('ws', 'base64', `invalid character at ${i}; send standard base64 (A-Z a-z 0-9 + /)`)
  return v
}
