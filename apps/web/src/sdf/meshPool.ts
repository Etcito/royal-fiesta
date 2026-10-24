// A fixed pool of mesh workers. The protocol here is the one mama/worker.ts answers:
// the pool posts { id, req }; the worker replies { id, ok: true, value } (posted with value.transfer)
// or { id, ok: false, area, path, reason }, rebuilt here as a RefusalError.
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { MeshedAsset, MeshRequest } from './mamaApi.ts'

export interface WorkerLike { postMessage(m: unknown, transfer?: Transferable[]): void; onmessage: ((e: { data: unknown }) => void) | null; onerror: ((e: unknown) => void) | null; terminate(): void }

export interface MeshJobMessage { id: number; req: MeshRequest }
export type MeshReplyMessage =
  | { id: number; ok: true; value: MeshedAsset }
  | { id: number; ok: false; area: string; path: string; reason: string }

interface Job { id: number; req: MeshRequest; resolve(v: MeshedAsset): void; reject(e: unknown): void }
interface Slot { worker: WorkerLike; job: Job | null }

function parseReply(data: unknown): MeshReplyMessage | null {
  if (typeof data !== 'object' || data === null) return null
  const r = data as Record<string, unknown>
  if (typeof r.id !== 'number') return null
  if (r.ok === true && typeof r.value === 'object' && r.value !== null) return r as unknown as MeshReplyMessage
  if (r.ok === false && typeof r.area === 'string' && typeof r.path === 'string' && typeof r.reason === 'string') return r as unknown as MeshReplyMessage
  return null
}

export class MeshPool {
  private readonly spawn: () => WorkerLike
  private readonly slots: Slot[] = []
  private readonly queue: Job[] = []
  private nextId = 1
  private closed = false

  constructor(size: number, spawn: () => WorkerLike) {
    if (!Number.isInteger(size) || size < 1) throw new RefusalError('sdf', 'MeshPool', `pool size must be an integer >= 1, got ${size}; use poolSize()`)
    this.spawn = spawn
    for (let i = 0; i < size; i++) {
      const slot: Slot = { worker: spawn(), job: null }
      this.slots.push(slot)
      this.wire(slot)
    }
  }

  // Requests not settled yet: queued plus in flight.
  get pending(): number {
    let busy = 0
    for (const s of this.slots) if (s.job !== null) busy++
    return this.queue.length + busy
  }

  mesh(req: MeshRequest): Promise<MeshedAsset> {
    if (this.closed) return Promise.reject(new RefusalError('sdf', req.assetId, 'mesh pool is closed; create a new pool'))
    return new Promise<MeshedAsset>((resolve, reject) => {
      this.queue.push({ id: this.nextId++, req, resolve, reject })
      this.dispatch()
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    const jobs: Job[] = []
    for (const s of this.slots) {
      s.worker.onmessage = null
      s.worker.onerror = null
      s.worker.terminate()
      if (s.job !== null) jobs.push(s.job)
      s.job = null
    }
    jobs.push(...this.queue.splice(0))
    for (const j of jobs) j.reject(new RefusalError('sdf', j.req.assetId, 'mesh pool closed before the asset was meshed; reload the content'))
  }

  private wire(slot: Slot): void {
    slot.worker.onmessage = (e) => this.onReply(slot, e.data)
    slot.worker.onerror = (e) => this.onCrash(slot, e)
  }

  private dispatch(): void {
    for (const s of this.slots) {
      if (this.queue.length === 0) return
      if (s.job !== null) continue
      const job = this.queue.shift() as Job
      s.job = job
      const msg: MeshJobMessage = { id: job.id, req: job.req }
      s.worker.postMessage(msg)
    }
  }

  private onReply(slot: Slot, data: unknown): void {
    const job = slot.job
    if (job === null) return
    const reply = parseReply(data)
    if (reply === null || reply.id !== job.id) {
      this.onCrash(slot, new Error('malformed reply'))
      return
    }
    slot.job = null
    if (reply.ok) job.resolve(reply.value)
    else job.reject(new RefusalError(reply.area, reply.path, reply.reason))
    this.dispatch()
  }

  private onCrash(slot: Slot, e: unknown): void {
    const job = slot.job
    slot.job = null
    slot.worker.onmessage = null
    slot.worker.onerror = null
    slot.worker.terminate()
    if (job !== null) {
      const detail = e instanceof Error ? e.message : typeof e === 'object' && e !== null && typeof (e as { message?: unknown }).message === 'string' ? (e as { message: string }).message : 'no detail'
      job.reject(new RefusalError('sdf', job.req.assetId, `mesh worker crashed; the worker was restarted, reload to retry this asset (${detail})`))
    }
    if (this.closed) return
    slot.worker = this.spawn()
    this.wire(slot)
    this.dispatch()
  }
}

// Rule 1.6: one core stays with the page, at most 4 workers, at least 1.
export function poolSize(hardwareConcurrency: number): number {
  if (!Number.isFinite(hardwareConcurrency)) return 1
  return Math.max(1, Math.min(4, Math.floor(hardwareConcurrency) - 1))
}
