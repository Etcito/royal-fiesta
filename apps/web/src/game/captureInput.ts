// The pure input rules of the GPU page ops (gameCapture). No DOM, no WebGPU: node imports this file too, so
// tools/judgeCard.ts can refuse an invalid judge input in about a second, before any build or GPU job, with the
// exact message the op itself would give in the browser.
import type { ContentId } from '@royal-fiesta/game/content'
import { refuse } from '@royal-fiesta/sim/refusal'

export interface GameCaptureInput { content: ContentId; course?: string; flow: 'match' | 'hub' | 'podium' | 'tour'; clients: 1 | 2 | 4; local?: 1 | 2 | 3 | 4; width: number; height: number; captureAt: string[]; reload?: boolean; touch?: boolean; net?: { server: string; party: 2 } }

export const DT = 1 / 60
const CONTENT_IDS: readonly ContentId[] = ['v0', 'v1', 'sdf']

export function obj(op: string, path: string, v: unknown): Record<string, unknown> {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) refuse('ops', `${op}.${path}`, 'is not an object; pass the JSON input declared in nmc.gpu.json')
  return v as Record<string, unknown>
}

export function onlyKeys(op: string, path: string, o: Record<string, unknown>, keys: readonly string[]): void {
  const extra = Object.keys(o).filter(k => !keys.includes(k))
  if (extra.length > 0) refuse('ops', `${op}.${path}`, `has unknown fields ${extra.join(', ')}; pass only ${keys.join(', ')}`)
}

export function int(op: string, path: string, v: unknown, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) refuse('ops', `${op}.${path}`, `is ${JSON.stringify(v)}; pass an integer in ${min}..${max}`)
  return v
}

export function str(op: string, path: string, v: unknown, pattern: RegExp): string {
  if (typeof v !== 'string' || !pattern.test(v)) refuse('ops', `${op}.${path}`, `is ${JSON.stringify(v)}; pass a string matching ${pattern}`)
  return v
}

export function contentId(op: string, v: unknown): ContentId {
  if (!CONTENT_IDS.includes(v as ContentId)) refuse('ops', `${op}.input.content`, `is ${JSON.stringify(v)}; choose ${CONTENT_IDS.join(', ')}`)
  return v as ContentId
}

export type MomentKind = 'loading' | 'hub' | 'match' | 'podium' | 'back-in-hub'
export interface Moment { name: string; kind: MomentKind; frames: number; clock: 'stage' | 'playing' }
export const RANK: Record<MomentKind, number> = { loading: 0, hub: 1, match: 2, podium: 3, 'back-in-hub': 4 }
export const FLOW_MOMENTS: Record<GameCaptureInput['flow'], readonly MomentKind[]> = {
  hub: ['loading', 'hub'],
  match: ['loading', 'match', 'podium'],
  podium: ['loading', 'podium'],
  tour: ['loading', 'hub', 'match', 'podium', 'back-in-hub'],
}
const MAX_MATCH_S = 600

export function validateCapture(raw: unknown, tourScreens?: readonly string[]): { input: GameCaptureInput; moments: Moment[]; screens: string[] } {
  const op = 'gameCapture'
  const o = obj(op, 'input', raw)
  onlyKeys(op, 'input', o, ['content', 'course', 'flow', 'clients', 'width', 'height', 'captureAt', 'reload', 'net', 'local', 'touch'])
  const content = contentId(op, o.content)
  const course = o.course === undefined ? undefined : str(op, 'input.course', o.course, /^[a-z0-9-]{1,40}$/)
  const flow = o.flow as GameCaptureInput['flow']
  if (!Object.hasOwn(FLOW_MOMENTS, String(flow))) refuse('ops', `${op}.input.flow`, `is ${JSON.stringify(o.flow)}; choose match, hub, podium or tour`)
  const clients = o.clients as 1 | 2 | 4
  if (clients !== 1 && clients !== 2 && clients !== 4) refuse('ops', `${op}.input.clients`, `is ${JSON.stringify(o.clients)}; choose 1, 2 or 4`)
  const width = int(op, 'input.width', o.width, 64, 3840)
  const height = int(op, 'input.height', o.height, 64, 2160)
  if (o.reload !== undefined && typeof o.reload !== 'boolean') refuse('ops', `${op}.input.reload`, `is ${JSON.stringify(o.reload)}; pass true or false`)
  let local: GameCaptureInput['local']
  if (o['local'] !== undefined) local = int(op, 'input["local"]', o['local'], 1, 4) as 1 | 2 | 3 | 4
  if (o.touch !== undefined && typeof o.touch !== 'boolean') refuse('ops', `${op}.input.touch`, `is ${JSON.stringify(o.touch)}; pass true or false`)
  const touch = o.touch === true
  let net: GameCaptureInput['net']
  if (o.net !== undefined) {
    const n = obj(op, 'input.net', o.net)
    onlyKeys(op, 'input.net', n, ['server', 'party'])
    if (n.party !== 2) refuse('ops', `${op}.input.net.party`, `is ${JSON.stringify(n.party)}; this op queues parties of 2`)
    net = { server: str(op, 'input.net.server', n.server, /^wss?:\/\/\S+$/), party: 2 }
  }
  // Local split screen: one in-page match on one canvas, so no other clients, relay or flow.
  if (local !== undefined) {
    if (clients !== 1) refuse('ops', `${op}.input.clients`, `${clients} clients cannot share one local split screen; pass clients 1 with local`)
    if (net !== undefined) refuse('ops', `${op}.input.net`, 'local split screen plays in-page; drop net')
    if (flow !== 'match') refuse('ops', `${op}.input.flow`, `local split screen plays a match; flow ${JSON.stringify(flow)} has no local split`)
  }
  if (touch && local !== 1) refuse('ops', `${op}.input.touch`, 'touch controls drive seat 0; pass local 1 with touch')
  if (clients > 1 && (course !== undefined || net !== undefined)) refuse('ops', `${op}.input.clients`, `${clients} clients play the in-page hub loop; drop course and net`)
  if (net !== undefined && course !== undefined) refuse('ops', `${op}.input.course`, 'plays in-page with bots; drop net or course')
  if (flow === 'podium' && (clients > 1 || net !== undefined)) refuse('ops', `${op}.input.flow`, 'podium shows content.podium() on one in-page client; use clients 1 without net')
  if (!Array.isArray(o.captureAt) || o.captureAt.length < 1 || o.captureAt.length > 16) refuse('ops', `${op}.input.captureAt`, 'is not an array of 1..16 moment names')
  const allowed: readonly string[] = FLOW_MOMENTS[flow]
  const moments: Moment[] = []
  // Shared names retain the legacy flow meaning unless a tour-only name selects the screen runner.
  const flowNames = ['loading', 'hub', 'match', 'podium', 'back-in-hub']
  // Without the page's screen list (node preflight) any name that is not a flow moment counts as a screen name; the op checks it in the browser.
  const isMoment = (name: unknown): boolean => typeof name !== 'string' || flowNames.includes(name) || /^(?:match-\d|playing)/.test(name)
  const known = (name: string): boolean => tourScreens === undefined || tourScreens.includes(name)
  const screenMode = flow === 'tour' && o.captureAt.some(name => !isMoment(name) && known(name as string))
  const screens: string[] = []
  for (let i = 0; i < o.captureAt.length; i++) {
    const name: unknown = o.captureAt[i]
    if (screenMode) {
      if (typeof name !== 'string' || isMoment(name) || !known(name)) refuse('ops', `${op}.input.captureAt/${i}`, 'tour screen names and flow moments cannot be mixed; request only tour screens or only flow moments')
      if (screens.includes(name)) refuse('ops', `${op}.input.captureAt/${i}`, `${name} is repeated; request each screen once`)
      screens.push(name)
      continue
    }
    // playing and playing+<s>s count from the first frame the match sim is in Phase.playing; match-<s>s counts
    // from the match stage, as it always has.
    const s = typeof name === 'string' ? /^match-(\d+(?:\.\d+)?)s$/.exec(name) : null
    const p = typeof name === 'string' ? /^playing(?:\+(\d+(?:\.\d+)?)s)?$/.exec(name) : null
    const kind = (s !== null || p !== null ? 'match' : name) as MomentKind
    const seconds = s !== null ? Number(s[1]) : p !== null ? Number(p[1] ?? 0) : 0
    const clock: Moment['clock'] = p !== null ? 'playing' : 'stage'
    const where = `${op}.input.captureAt/${i}`
    if (typeof name !== 'string' || !allowed.includes(kind)) {
      refuse('ops', where, `${JSON.stringify(name)} is not a moment of flow ${flow}; choose from ${allowed.map(k => (k === 'match' ? 'match-<s>s, playing, playing+<s>s' : k)).join(', ')}`)
    }
    // A local split screen has no loading capture of its own and no podium view: only the match moments.
    if (local !== undefined && kind !== 'match') {
      refuse('ops', where, kind === 'podium'
        ? 'a local split-screen match has no podium capture; capture playing, playing+<s>s or match-<s>s'
        : `${JSON.stringify(name)} is not a local split-screen moment; capture playing, playing+<s>s or match-<s>s`)
    }
    if (seconds > MAX_MATCH_S) refuse('ops', where, `${name} is past ${MAX_MATCH_S} s of match`)
    const frames = Math.round(seconds / DT)
    const prev = moments[moments.length - 1]
    if (prev !== undefined && (RANK[kind] < RANK[prev.kind] || (RANK[kind] === RANK[prev.kind] && (kind !== 'match' || frames <= prev.frames)))) {
      refuse('ops', where, `${name} is repeated or out of order; list moments in flow order (${allowed.join(', ')}), match seconds ascending`)
    }
    moments.push({ name, kind, frames, clock })
  }
  return { input: { content, course, flow, clients, width, height, captureAt: o.captureAt as string[], reload: o.reload === true, net, local, touch }, moments, screens }
}
