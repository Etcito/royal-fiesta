import type { LobbyPick, LobbyServerMsg } from '../hub/lobby.ts'

// The game's typed copy of the GameSaloon relay protocol subset it uses (gamesaloon src/relay/protocol.ts, docs/RELAY.md).

export const RELAY_PATH = '/ws'
export const RELAY_MAX_PLAYERS = 4
export const RELAY_MAX_MSG_BYTES = 4096
export const RELAY_RATE_PER_SEC = 20
export const CADENCE_RATE_PER_SEC = 90
export const CADENCE_RATE_PER_MIN = 4000
export const RELAY_MAX_ACT_KEYS = 24
export const RELAY_MAX_ACT_ITEMS = 512
export const RELAY_MAX_ACT_DEPTH = 6

export const RELAY_CLIENT_TYPES = ['create', 'join', 'queue', 'unqueue', 'act', 'bye', 'ping'] as const
export type RelayClientType = typeof RELAY_CLIENT_TYPES[number]

export const RELAY_SERVER_TYPES = [
  'room', 'waiting', 'queued', 'unqueued', 'matched', 'act', 'ack',
  'player_dropped', 'player_back', 'player_left', 'opp_dropped', 'opp_back', 'opp_left', 'pong', 'error',
] as const
export type RelayServerType = typeof RELAY_SERVER_TYPES[number]

export type RelayActBody = Record<string, unknown> | unknown[]

// GameSaloon timed lobbies (gamesaloon docs/lobby.md): extension messages on the same socket.
export const LOBBY_GAME = 'royal-fiesta'
export const LOBBY_SERVER_TYPES = ['lobby_choice', 'lobby_state', 'lobby_watch', 'lobby_act', 'lobby_closed', 'lobby_left', 'lobby_error', 'lobby_presence'] as const
export type RelayLobbyEnter = { t: 'lobby_enter'; game: string; seats: number; cadence: boolean; payload: object | null }
export type RelayLobbyPick = { t: 'lobby_pick'; action: LobbyPick; id: string | null }
export type RelayLobbyLeave = { t: 'lobby_leave' }
// Shared hub presence (gamesaloon docs/lobby.md "Shared hub presence"): this client's hub avatar state.
export type RelayLobbyPresence = { t: 'lobby_presence'; a: object }

export type RelayCreate = { t: 'create'; players?: number; cadence?: boolean; payload?: object | null }
export type RelayJoin = { t: 'join'; code: string; payload?: object | null }
export type RelayQueue = { t: 'queue'; players?: number; cadence?: boolean; payload?: object | null }
export type RelayUnqueue = { t: 'unqueue' }
export type RelayAct = { t: 'act'; a: object | unknown[]; n?: number }
export type RelayBye = { t: 'bye' }
export type RelayPing = { t: 'ping' }
export type RelayClientMsg = RelayCreate | RelayJoin | RelayQueue | RelayUnqueue | RelayAct | RelayBye | RelayPing
  | RelayLobbyEnter | RelayLobbyPick | RelayLobbyLeave | RelayLobbyPresence

export type RelayRoom = { t: 'room'; code: string }
export type RelayWaiting = { t: 'waiting'; seat: number; players: number }
export type RelayQueued = { t: 'queued'; estimateMs: number | null }
export type RelayUnqueued = { t: 'unqueued' }
export type RelayMatched = { t: 'matched'; seed: number; hostStarts: boolean; youAre: number; token: string; players: number; opps: unknown[] }
// `from` is the sender seat and `n` its sequence number (hub.ts act broadcast).
export type RelayActMsg = { t: 'act'; a: RelayActBody; n: number; from: number }
export type RelayAck = { t: 'ack'; n: number }
export type RelayPlayerDropped = { t: 'player_dropped'; seat: number; graceMs: number }
export type RelayPlayerBack = { t: 'player_back'; seat: number }
export type RelayPlayerLeft = { t: 'player_left'; seat: number }
export type RelayOppDropped = { t: 'opp_dropped'; graceMs: number }
export type RelayOppBack = { t: 'opp_back' }
export type RelayOppLeft = { t: 'opp_left' }
export type RelayPong = { t: 'pong' }
export type RelayError = { t: 'error'; reason: string }
export type RelayServerMsg = RelayRoom | RelayWaiting | RelayQueued | RelayUnqueued | RelayMatched | RelayActMsg | RelayAck
  | RelayPlayerDropped | RelayPlayerBack | RelayPlayerLeft | RelayOppDropped | RelayOppBack | RelayOppLeft | RelayPong | RelayError
  | LobbyServerMsg

type Obj = Record<string, unknown>

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

function isSeat(v: unknown): v is number {
  return isInt(v) && v >= 0 && v < RELAY_MAX_PLAYERS
}

function isPhase(v: unknown): boolean {
  return v === 'waiting' || v === 'playing'
}

function valid(m: Obj): boolean {
  switch (m.t) {
    case 'room': return typeof m.code === 'string'
    case 'waiting': return isSeat(m.seat) && isInt(m.players)
    case 'queued': return m.estimateMs === null || typeof m.estimateMs === 'number'
    case 'matched':
      return typeof m.seed === 'number' && Number.isFinite(m.seed) && typeof m.hostStarts === 'boolean'
        && isSeat(m.youAre) && typeof m.token === 'string' && isInt(m.players) && Array.isArray(m.opps)
    case 'act': return (isObj(m.a) || Array.isArray(m.a)) && isInt(m.n) && m.n >= 0 && isSeat(m.from)
    case 'ack': return isInt(m.n) && m.n >= 0
    case 'player_dropped': return isSeat(m.seat) && typeof m.graceMs === 'number'
    case 'player_back':
    case 'player_left': return isSeat(m.seat)
    case 'opp_dropped': return typeof m.graceMs === 'number'
    case 'error': return typeof m.reason === 'string'
    case 'lobby_choice':
      return Array.isArray(m.lobbies) && m.lobbies.every((l) => isObj(l) && typeof l.id === 'string' && isPhase(l.phase)
        && isInt(l.players) && isInt(l.seats) && typeof l.startsInMs === 'number' && Array.isArray(l.actions) && Array.isArray(l.names))
    case 'lobby_state':
      return typeof m.id === 'string' && isPhase(m.phase) && (m.role === 'player' || m.role === 'spectator') && isInt(m.seat)
        && Array.isArray(m.players) && isInt(m.seats) && typeof m.startsInMs === 'number' && typeof m.waitMs === 'number'
    case 'lobby_watch':
      return typeof m.id === 'string' && typeof m.session === 'string' && typeof m.seed === 'number' && isInt(m.players)
        && Array.isArray(m.opps) && typeof m.replay === 'boolean'
    case 'lobby_act': return typeof m.id === 'string' && isInt(m.n) && isInt(m.from)
    case 'lobby_presence': return typeof m.id === 'string' && isInt(m.from) && m.from >= 0 && isObj(m.a)
    case 'lobby_closed': return typeof m.id === 'string' && (m.reason === 'ended' || m.reason === 'empty')
    case 'lobby_error': return typeof m.reason === 'string'
    case 'lobby_left':
    case 'unqueued':
    case 'opp_back':
    case 'opp_left':
    case 'pong': return true
    default: return false
  }
}

/** Parses one server text frame; null for anything that is not a well-formed known server message. Never throws. */
export function parseRelayServerMsg(raw: string): RelayServerMsg | null {
  if (typeof raw !== 'string') return null
  let v: unknown
  try { v = JSON.parse(raw) } catch { return null }
  if (!isObj(v) || !valid(v)) return null
  return v as RelayServerMsg
}
