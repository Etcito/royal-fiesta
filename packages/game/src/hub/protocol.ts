import type { Vec3 } from '@royal-fiesta/sim/vec'

export interface HubHello { k: 'hi'; v: 1; name: string; c: number }
export interface HubState { k: 'st'; s: number; p: [number, number, number]; f: number; m: number; e: number; q: 0 | 1; x: 0 | 1 }

export const HUB_RATE_HZ = 5
export const HUB_MATCH_RATE_HZ = 1
export const HUB_HELLO_EVERY_MS = 5000
// 5 Hz states (300/min) plus hellos (12/min) plus create/join/ping/bye, with headroom, under the relay's 400 frames/min and 20/s per non-cadence socket
export const HUB_MAX_ACTS_PER_MIN = 360
export const EMOTES = ['none', 'wave', 'dance', 'cheer', 'laugh'] as const
export const EMOTE_MS = 2000

const TAU = Math.PI * 2
const POS_LIMIT = 1e6
const SEQ_MAX = 2 ** 31 - 1

export function encodeState(pos: Vec3, facing: { x: number; z: number }, mode: number, emote: number, queued: boolean, inMatch: boolean, seq: number): HubState {
  return {
    k: 'st',
    s: seq,
    p: [Math.round(pos.x * 100), Math.round(pos.y * 100), Math.round(pos.z * 100)],
    f: Math.round(Math.atan2(facing.x, facing.z) / TAU * 256) & 255,
    m: mode,
    e: emote,
    q: queued ? 1 : 0,
    x: inMatch ? 1 : 0,
  }
}

function isInt(v: unknown, lo: number, hi: number): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= lo && v <= hi
}

function onlyKeys(o: Record<string, unknown>, keys: string[]): boolean {
  const have = Object.keys(o)
  if (have.length !== keys.length) return false
  for (const k of keys) if (!Object.prototype.hasOwnProperty.call(o, k)) return false
  return true
}

export function decodeHubAct(a: unknown): HubHello | HubState | null {
  if (typeof a !== 'object' || a === null || Array.isArray(a)) return null
  const o = a as Record<string, unknown>
  if (o.k === 'hi') {
    if (!onlyKeys(o, ['k', 'v', 'name', 'c'])) return null
    if (o.v !== 1) return null
    if (typeof o.name !== 'string' || o.name.length < 1 || o.name.length > 24) return null
    if (!isInt(o.c, 0, 7)) return null
    return { k: 'hi', v: 1, name: o.name, c: o.c }
  }
  if (o.k === 'st') {
    if (!onlyKeys(o, ['k', 's', 'p', 'f', 'm', 'e', 'q', 'x'])) return null
    const p = o.p
    if (!Array.isArray(p) || p.length !== 3) return null
    if (!isInt(p[0], -POS_LIMIT, POS_LIMIT) || !isInt(p[1], -POS_LIMIT, POS_LIMIT) || !isInt(p[2], -POS_LIMIT, POS_LIMIT)) return null
    if (!isInt(o.s, 0, SEQ_MAX) || !isInt(o.f, 0, 255) || !isInt(o.m, 0, 7)) return null
    if (!isInt(o.e, 0, EMOTES.length - 1)) return null
    if ((o.q !== 0 && o.q !== 1) || (o.x !== 0 && o.x !== 1)) return null
    return { k: 'st', s: o.s, p: [p[0], p[1], p[2]], f: o.f, m: o.m, e: o.e, q: o.q, x: o.x }
  }
  return null
}

export function stateToPose(s: HubState, out: { pos: Vec3; yaw: number }): { pos: Vec3; yaw: number } {
  out.pos.x = s.p[0] / 100
  out.pos.y = s.p[1] / 100
  out.pos.z = s.p[2] / 100
  out.yaw = s.f / 256 * TAU
  return out
}
