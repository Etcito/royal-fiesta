// Game's typed zone-room subset of gamesaloon-relay src/relay/{protocol,binary}.ts and docs/RELAY.md.
import type { LobbyServerMsg } from '../hub/lobby.ts'
import type { RelayLobbyEnter, RelayLobbyLeave, RelayLobbyPick, RelayLobbyPresence } from './relayProtocol.ts'
import { parseRelayServerMsg } from './relayProtocol.ts'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { SignalData } from './roomsProtocol.ts'

export const ZONE_BIN_KIND = 0x5a
// Application payload kind inside the relay's opaque 0x5a routing envelope. Zone game packets never use it.
export const SIGNAL = 0x53
export type ZoneSignal = SignalData | { kind: 'abort'; reason: string }

export function encodeZoneSignal(signal: ZoneSignal): Uint8Array {
  const json = new TextEncoder().encode(JSON.stringify(signal))
  const out = new Uint8Array(1 + json.length)
  out[0] = SIGNAL
  out.set(json, 1)
  return out
}

export function decodeZoneSignal(payload: Uint8Array): ZoneSignal | null {
  if (payload[0] !== SIGNAL) return null
  try {
    const s = JSON.parse(new TextDecoder().decode(payload.subarray(1))) as Record<string, unknown> | null
    if (!s || typeof s !== 'object') return null
    if ((s.kind === 'offer' || s.kind === 'answer') && typeof s.sdp === 'string') return s as ZoneSignal
    if (s.kind === 'ice-end') return { kind: 'ice-end' }
    if (s.kind === 'abort' && typeof s.reason === 'string') return { kind: 'abort', reason: s.reason }
    if (s.kind === 'ice' && typeof s.candidate === 'string' && (s.sdpMid === null || typeof s.sdpMid === 'string')
      && (s.sdpMLineIndex === null || (Number.isInteger(s.sdpMLineIndex) && Number(s.sdpMLineIndex) >= 0))) return s as ZoneSignal
  } catch { /* Malformed signaling stays out of RTC callbacks. */ }
  return null
}
export const ZONE_BIN_IN_HEADER = 10
export const ZONE_BIN_OUT_HEADER = 2
export const MAX_ZONE_PEERS = 64
export const RELAY_MAX_BIN_BYTES = 20000
export const RELAY_BIN_RATE_PER_SEC = 2000
export const ZONE_GAME_ID = 'royal-fiesta'

export interface ZoneQueuePayload {
  g: typeof ZONE_GAME_ID
  v: 1
  zones: 1
  name: string
  seats: number
  course: string
  /** fnv1a32 of the merged zone tuning, as an unsigned u32. */
  tuning: number
  m: { cpuMs: number; bandwidthKbps: number; latencyMs: number; spareSlots: number }
}

export type ZoneCreate = { t: 'create'; players?: number; cadence?: boolean; payload?: ZoneQueuePayload; game: typeof ZONE_GAME_ID; zones: true }
export type ZoneQueue = { t: 'queue'; players: number; cadence: true; payload: ZoneQueuePayload; game: typeof ZONE_GAME_ID; zones: true }
export type ZoneClientMsg = ZoneCreate | ZoneQueue | { t: 'bye' } | { t: 'unqueue' } | { t: 'ping' } | (RelayLobbyEnter & { zones: true }) | RelayLobbyLeave | RelayLobbyPick | RelayLobbyPresence
export type ZoneMatched = { t: 'matched'; seed: number; hostStarts: boolean; youAre: number; token: string; players: number; opps: unknown[] }
export type ZoneSeatEvent = { t: 'player_dropped'; seat: number; graceMs: number }
  | { t: 'player_back' | 'player_left'; seat: number }
export type ZoneServerMsg = ZoneMatched | ZoneSeatEvent | { t: 'room'; code: string }
  | { t: 'waiting'; seat: number; players: number } | { t: 'queued'; estimateMs: number | null }
  | LobbyServerMsg | { t: 'unqueued' | 'pong' | 'opp_left' } | { t: 'error'; reason: string }

type Obj = Record<string, unknown>
function isObj(v: unknown): v is Obj { return typeof v === 'object' && v !== null && !Array.isArray(v) }
function int(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
}
function nonnegative(v: unknown): v is number { return typeof v === 'number' && Number.isFinite(v) && v >= 0 }
function seat(v: unknown): v is number { return int(v, 0, MAX_ZONE_PEERS - 1) }

export function isZoneQueuePayload(p: unknown): p is ZoneQueuePayload {
  return isObj(p) && p.g === ZONE_GAME_ID && p.v === 1 && p.zones === 1
    && typeof p.name === 'string' && int(p.seats, 1, 4) && typeof p.course === 'string' && p.course.length > 0
    && int(p.tuning, 0, 0xffffffff) && isObj(p.m) && nonnegative(p.m.cpuMs)
    && nonnegative(p.m.bandwidthKbps) && nonnegative(p.m.latencyMs) && int(p.m.spareSlots, 0, 15)
}

/** Parses only the zone-room messages we consume. Malformed frames never escape the socket callback. */
export function parseZoneServerMsg(raw: string): ZoneServerMsg | null {
  try {
    if (typeof raw !== 'string') return null
    const m: unknown = JSON.parse(raw)
    if (!isObj(m)) return null
    if (typeof m.t === 'string' && m.t.startsWith('lobby_')) {
      return parseRelayServerMsg(raw) as LobbyServerMsg | null
    }
    let ok = false
    switch (m.t) {
      case 'room': ok = typeof m.code === 'string'; break
      case 'waiting': ok = seat(m.seat) && int(m.players, 2, MAX_ZONE_PEERS) && m.seat < m.players; break
      case 'queued': ok = m.estimateMs === null || nonnegative(m.estimateMs); break
      case 'matched':
        ok = int(m.seed, 0, 0xffffffff) && typeof m.hostStarts === 'boolean' && seat(m.youAre)
          && typeof m.token === 'string' && int(m.players, 1, MAX_ZONE_PEERS) && m.youAre < m.players
          && Array.isArray(m.opps) && m.opps.length === m.players
        break
      case 'player_dropped': ok = seat(m.seat) && nonnegative(m.graceMs); break
      case 'player_back':
      case 'player_left': ok = seat(m.seat); break
      case 'error': ok = typeof m.reason === 'string'; break
      case 'unqueued':
      case 'pong':
      case 'opp_left': ok = true; break
    }
    return ok ? m as ZoneServerMsg : null
  } catch { return null }
}

/** Zero mask broadcasts to every other member. Each word is written separately to preserve all 64 bits. */
export function encodeZoneBinIn(maskLo: number, maskHi: number, payload: Uint8Array): Uint8Array {
  if (payload.byteLength + ZONE_BIN_IN_HEADER > RELAY_MAX_BIN_BYTES) {
    refuse('relay', 'binary.payload', `frame exceeds ${RELAY_MAX_BIN_BYTES} bytes; split the payload before sending`)
  }
  const out = new Uint8Array(ZONE_BIN_IN_HEADER + payload.byteLength)
  out[0] = ZONE_BIN_KIND
  const view = new DataView(out.buffer)
  view.setUint32(2, maskLo, true)
  view.setUint32(6, maskHi, true)
  out.set(payload, ZONE_BIN_IN_HEADER)
  return out
}

/** Payload is a borrowed view of the frame. Accepts both browser and Node arraybuffer delivery. */
export function decodeZoneBinOut(raw: unknown): { sender: number; payload: Uint8Array } | null {
  try {
    const frame = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw
    if (!(frame instanceof Uint8Array) || frame.byteLength < ZONE_BIN_OUT_HEADER
      || frame[0] !== ZONE_BIN_KIND || !seat(frame[1])) return null
    return { sender: frame[1], payload: frame.subarray(ZONE_BIN_OUT_HEADER) }
  } catch { return null }
}
