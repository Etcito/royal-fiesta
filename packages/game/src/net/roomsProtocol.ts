// The game's typed copy of the GameSaloon rooms protocol subset it uses (gamesaloon PROTOCOL.md, src/protocol.ts).
// Rooms and relay share `/ws`: the server routes a socket by its message types, so rooms gets its own socket.

export const ROOMS_PATH = '/ws'
export const ROOMS_PROTOCOL_VERSION = 1
export const ROOMS_GAME_ID = 'royal-fiesta-1'
export const ROOMS_MAX_PEERS = 8
export const ROOMS_SIGNAL_MAX_BYTES = 16384

export type Rid = string | number
export interface IceServer { urls: string[]; username?: string; credential?: string }
export interface LocalPlayer { name: string; build: { characterId: string; bodyId: string; wheelId: string; gliderId: string } }
export interface RoomSettings { kind: string; cupId: string; trackId: string; cc: number; items: boolean }
// peer is the lowest free id in 0..7 when the member joined.
export interface Member { peer: number; name: string; players: LocalPlayer[] }
export type SignalData =
  | { kind: 'offer' | 'answer'; sdp: string }
  | { kind: 'ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  | { kind: 'ice-end' }

export type Welcome = { t: 'welcome'; rid?: Rid; v: 1; client: string; iceServers: IceServer[]; maxHumans: number; maxLocal: number }
export type RoomMsg = { t: 'room'; rid?: Rid; code: string; you: number; owner: number; status: 'lobby' | 'racing'; members: Member[]; settings: RoomSettings; humans: number; private?: boolean }
// members are sorted by peer: player index = rank, rollback peer = rooms peer id.
export type Started = { t: 'started'; rid?: Rid; code: string; seed: number; settings: RoomSettings; members: Member[] }
export type RoomsLeft = { t: 'left'; rid?: Rid }
// Always followed by a `room` message.
export type RoomsPeerLeft = { t: 'peerLeft'; peer: number }
export type RoomsSignal = { t: 'signal'; from: number; data: SignalData }
export type RoomsPong = { t: 'pong'; rid?: Rid; id: number }
export type RoomsError = { t: 'error'; rid?: Rid; code: string; message: string }
export type RoomsServerMsg = Welcome | RoomMsg | Started | RoomsLeft | RoomsPeerLeft | RoomsSignal | RoomsPong | RoomsError

export function fiestaLocalPlayer(name: string, colour: number): LocalPlayer {
  return { name, build: { characterId: 'bean', bodyId: `c${colour}`, wheelId: 'none', gliderId: 'none' } }
}

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v)
const isStr = (v: unknown): v is string => typeof v === 'string'
const isPeer = (v: unknown): v is number => isInt(v) && v >= 0 && v < ROOMS_MAX_PEERS

function isPlayer(v: unknown): v is LocalPlayer {
  if (!isObj(v) || !isStr(v.name) || !isObj(v.build)) return false
  const b = v.build
  return isStr(b.characterId) && isStr(b.bodyId) && isStr(b.wheelId) && isStr(b.gliderId)
}

function members(v: unknown): Member[] | null {
  if (!Array.isArray(v)) return null
  const out: Member[] = []
  for (const m of v) {
    if (!isObj(m) || !isPeer(m.peer) || !isStr(m.name) || !Array.isArray(m.players) || !m.players.every(isPlayer)) return null
    out.push({ peer: m.peer, name: m.name, players: m.players })
  }
  return out.sort((a, b) => a.peer - b.peer)
}

function isSettings(v: unknown): v is RoomSettings {
  return isObj(v) && isStr(v.kind) && isStr(v.cupId) && isStr(v.trackId) && isInt(v.cc) && typeof v.items === 'boolean'
}

function isIce(v: unknown): v is IceServer {
  return isObj(v) && Array.isArray(v.urls) && v.urls.every(isStr) && (v.username === undefined || isStr(v.username)) && (v.credential === undefined || isStr(v.credential))
}

export function isSignalData(v: unknown): v is SignalData {
  if (!isObj(v)) return false
  switch (v.kind) {
    case 'offer': case 'answer': return isStr(v.sdp)
    case 'ice': return isStr(v.candidate) && (v.sdpMid === null || isStr(v.sdpMid)) && (v.sdpMLineIndex === null || isInt(v.sdpMLineIndex))
    case 'ice-end': return true
    default: return false
  }
}

// UTF-8 length of the JSON form, as the server counts it (TextEncoder exists in browsers and Node).
export function signalBytes(data: SignalData): number {
  return new TextEncoder().encode(JSON.stringify(data)).length
}

export function parseRoomsServerMsg(raw: string): RoomsServerMsg | null {
  let o: unknown
  try { o = JSON.parse(raw) } catch { return null }
  if (!isObj(o)) return null
  const rid = isStr(o.rid) || (typeof o.rid === 'number' && Number.isFinite(o.rid)) ? { rid: o.rid as Rid } : {}
  switch (o.t) {
    case 'welcome':
      if (o.v !== 1 || !isStr(o.client) || !Array.isArray(o.iceServers) || !o.iceServers.every(isIce) || !isInt(o.maxHumans) || !isInt(o.maxLocal)) return null
      return { t: 'welcome', ...rid, v: 1, client: o.client, iceServers: o.iceServers, maxHumans: o.maxHumans, maxLocal: o.maxLocal }
    case 'room': {
      const ms = members(o.members)
      if (!ms || !isStr(o.code) || !isPeer(o.you) || !isPeer(o.owner) || !isInt(o.humans) || !isSettings(o.settings)) return null
      if (o.status !== 'lobby' && o.status !== 'racing') return null
      const priv = o.private === true ? { private: true } : {}
      return { t: 'room', ...rid, code: o.code, you: o.you, owner: o.owner, status: o.status, members: ms, settings: o.settings, humans: o.humans, ...priv }
    }
    case 'started': {
      const ms = members(o.members)
      if (!ms || !isStr(o.code) || !isInt(o.seed) || o.seed < 0 || !isSettings(o.settings)) return null
      return { t: 'started', ...rid, code: o.code, seed: o.seed, settings: o.settings, members: ms }
    }
    case 'left': return { t: 'left', ...rid }
    case 'peerLeft': return isPeer(o.peer) ? { t: 'peerLeft', peer: o.peer } : null
    case 'signal': return isPeer(o.from) && isSignalData(o.data) ? { t: 'signal', from: o.from, data: o.data } : null
    case 'pong': return isInt(o.id) ? { t: 'pong', ...rid, id: o.id } : null
    case 'error': return isStr(o.code) && isStr(o.message) ? { t: 'error', ...rid, code: o.code, message: o.message } : null
    default: return null
  }
}
