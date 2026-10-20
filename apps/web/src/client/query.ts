// Query parsing for the client page. Modes: inpage (default, all clients in this page), relay and webrtc
// (one networked client per page, needs ?server=).
import type { ProfileName } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'

export type Mode = 'inpage' | 'relay' | 'webrtc'
export interface Query { mode: Mode; clients: number; seed: number; profile: ProfileName; server: string | null; pilot: boolean; room: string | null }

// Default clients: in-page, one client and one full-canvas view (?clients=2..4 opts into the grid, one canvas per client).
// Networked modes queue or join rooms for 4 players by default, as before.
export const DEFAULT_INPAGE_CLIENTS = 1
export const DEFAULT_NET_CLIENTS = 4

function intParam(q: URLSearchParams, key: string, def: number, min: number, max: number): number {
  const raw = q.get(key)
  if (raw === null) return def
  const n = Number(raw)
  if (!/^-?\d+$/.test(raw) || n < min || n > max) refuse('query', key, `'${raw}' is not an integer in ${min}..${max}; fix ?${key}=`)
  return n
}

export function parseQuery(search: string): Query {
  const q = new URLSearchParams(search)
  const mode = q.get('mode') ?? 'inpage'
  if (mode !== 'inpage' && mode !== 'relay' && mode !== 'webrtc') refuse('query', 'mode', `'${mode}' is not inpage, relay, webrtc or ops; fix ?mode=`)
  const clients = intParam(q, 'clients', mode === 'inpage' ? DEFAULT_INPAGE_CLIENTS : DEFAULT_NET_CLIENTS, 1, 4)
  const seed = intParam(q, 'seed', 1, 0, 0xffffffff)
  const profile = q.get('profile') ?? 'sprint'
  if (profile !== 'sprint' && profile !== 'standard') refuse('query', 'profile', `'${profile}' is not sprint or standard; fix ?profile=`)
  const pilotRaw = q.get('pilot') ?? '0'
  if (pilotRaw !== '0' && pilotRaw !== '1') refuse('query', 'pilot', `'${pilotRaw}' is not 0 or 1; fix ?pilot=`)
  const server = q.get('server')
  if (mode !== 'inpage') {
    if (server === null) refuse('query', 'server', `is required for mode=${mode}; pass ?server=ws://host:port/...`)
    if (!/^wss?:\/\/./.test(server)) refuse('query', 'server', `'${server}' is not a ws:// or wss:// URL; pass ?server=ws://host:port/...`)
  }
  const room = q.get('room')
  if (room !== null && !/^[A-Za-z0-9-]{1,32}$/.test(room)) refuse('query', 'room', `'${room}' is not a room code; pass the code the room owner shows`)
  return { mode, clients, seed, profile, server: mode === 'inpage' ? null : server, pilot: pilotRaw === '1', room }
}
