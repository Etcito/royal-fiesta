// Game's typed zone-room subset of gamesaloon-relay src/relay/{protocol,binary}.ts and docs/RELAY.md.
import { refuse } from '@royal-fiesta/sim/refusal'

export const ZONE_BIN_KIND = 0x5a
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
export type ZoneClientMsg = ZoneCreate | ZoneQueue | { t: 'bye' }
export type ZoneMatched = { t: 'matched'; seed: number; hostStarts: boolean; youAre: number; token: string; players: number; opps: unknown[] }
export type ZoneSeatEvent = { t: 'player_dropped'; seat: number; graceMs: number }
  | { t: 'player_back' | 'player_left'; seat: number }
export type ZoneServerMsg = ZoneMatched | ZoneSeatEvent | { t: 'room'; code: string }
  | { t: 'waiting'; seat: number; players: number } | { t: 'queued'; estimateMs: number | null }
  | { t: 'unqueued' | 'pong' | 'opp_left' } | { t: 'error'; reason: string }

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
    let ok = false
    switch (m.t) {
      case 'room': ok = typeof m.code === 'string'; break
      case 'waiting': ok = seat(m.seat) && int(m.players, 2, MAX_ZONE_PEERS) && m.seat < m.players; break
      case 'queued': ok = m.estimateMs === null || nonnegative(m.estimateMs); break
      case 'matched':
        ok = int(m.seed, 0, 0xffffffff) && typeof m.hostStarts === 'boolean' && seat(m.youAre)
          && typeof m.token === 'string' && int(m.players, 2, MAX_ZONE_PEERS) && m.youAre < m.players
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
