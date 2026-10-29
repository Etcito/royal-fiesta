// The pure input rules of the GPU page ops (gameCapture). No DOM, no WebGPU: node imports this file too, so
// tools/judgeCard.ts can refuse an invalid judge input in about a second, before any build or GPU job, with the
// exact message the op itself would give in the browser.
import type { ContentId } from '@royal-fiesta/game/content'
import { refuse } from '@royal-fiesta/sim/refusal'

export interface GameCaptureInput { content: ContentId; course?: string; flow: 'match' | 'hub' | 'podium' | 'tour'; clients: 1 | 2 | 4; width: number; height: number; captureAt: string[]; reload?: boolean; net?: { server: string; party: 2 } }

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
export interface Moment { name: string; kind: MomentKind; frames: number }
export const RANK: Record<MomentKind, number> = { loading: 0, hub: 1, match: 2, podium: 3, 'back-in-hub': 4 }
export const FLOW_MOMENTS: Record<GameCaptureInput['flow'], readonly MomentKind[]> = {
  hub: ['loading', 'hub'],
  match: ['loading', 'match', 'podium'],
  podium: ['loading', 'podium'],
  tour: ['loading', 'hub', 'match', 'podium', 'back-in-hub'],
}
const MAX_MATCH_S = 600

export function validateCapture(raw: unknown): { input: GameCaptureInput; moments: Moment[] } {
  const op = 'gameCapture'
  const o = obj(op, 'input', raw)
  onlyKeys(op, 'input', o, ['content', 'course', 'flow', 'clients', 'width', 'height', 'captureAt', 'reload', 'net'])
  const content = contentId(op, o.content)
  const course = o.course === undefined ? undefined : str(op, 'input.course', o.course, /^[a-z0-9-]{1,40}$/)
  const flow = o.flow as GameCaptureInput['flow']
  if (!Object.hasOwn(FLOW_MOMENTS, String(flow))) refuse('ops', `${op}.input.flow`, `is ${JSON.stringify(o.flow)}; choose match, hub, podium or tour`)
  const clients = o.clients as 1 | 2 | 4
  if (clients !== 1 && clients !== 2 && clients !== 4) refuse('ops', `${op}.input.clients`, `is ${JSON.stringify(o.clients)}; choose 1, 2 or 4`)
  const width = int(op, 'input.width', o.width, 64, 3840)
  const height = int(op, 'input.height', o.height, 64, 2160)
  if (o.reload !== undefined && typeof o.reload !== 'boolean') refuse('ops', `${op}.input.reload`, `is ${JSON.stringify(o.reload)}; pass true or false`)
  let net: GameCaptureInput['net']
  if (o.net !== undefined) {
    const n = obj(op, 'input.net', o.net)
    onlyKeys(op, 'input.net', n, ['server', 'party'])
    if (n.party !== 2) refuse('ops', `${op}.input.net.party`, `is ${JSON.stringify(n.party)}; this op queues parties of 2`)
    net = { server: str(op, 'input.net.server', n.server, /^wss?:\/\/\S+$/), party: 2 }
  }
  if (clients > 1 && (course !== undefined || net !== undefined)) refuse('ops', `${op}.input.clients`, `${clients} clients play the in-page hub loop; drop course and net`)
  if (net !== undefined && course !== undefined) refuse('ops', `${op}.input.course`, 'plays in-page with bots; drop net or course')
  if (flow === 'podium' && (clients > 1 || net !== undefined)) refuse('ops', `${op}.input.flow`, 'podium shows content.podium() on one in-page client; use clients 1 without net')
  if (!Array.isArray(o.captureAt) || o.captureAt.length < 1 || o.captureAt.length > 16) refuse('ops', `${op}.input.captureAt`, 'is not an array of 1..16 moment names')
  const allowed = FLOW_MOMENTS[flow]
  const moments: Moment[] = []
  for (let i = 0; i < o.captureAt.length; i++) {
    const name: unknown = o.captureAt[i]
    const s = typeof name === 'string' ? /^match-(\d+(?:\.\d+)?)s$/.exec(name) : null
    const kind = (s !== null ? 'match' : name) as MomentKind
    const seconds = s !== null ? Number(s[1]) : 0
    const where = `${op}.input.captureAt/${i}`
    if (typeof name !== 'string' || !allowed.includes(kind)) {
      refuse('ops', where, `${JSON.stringify(name)} is not a moment of flow ${flow}; choose from ${allowed.map(k => (k === 'match' ? 'match-<s>s' : k)).join(', ')}`)
    }
    if (seconds > MAX_MATCH_S) refuse('ops', where, `${name} is past ${MAX_MATCH_S} s of match`)
    const frames = Math.round(seconds / DT)
    const prev = moments[moments.length - 1]
    if (prev !== undefined && (RANK[kind] < RANK[prev.kind] || (RANK[kind] === RANK[prev.kind] && (kind !== 'match' || frames <= prev.frames)))) {
      refuse('ops', where, `${name} is repeated or out of order; list moments in flow order (${allowed.join(', ')}), match seconds ascending`)
    }
    moments.push({ name, kind, frames })
  }
  return { input: { content, course, flow, clients, width, height, captureAt: o.captureAt as string[], reload: o.reload === true, net }, moments }
}
