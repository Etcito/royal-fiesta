// Economy service storage (tools/economy/server.ts). Files in the store dir:
//   players/<id>.json   PlayerRecord (id = Wavedash user id, checked against PLAYER_ID before it touches a path)
//   items.json          { [itemId]: sold }
//   commissions.json    Commission[]
//   rewards.json        { [key]: true }   reward idempotency keys
// Every write goes to '<file>.<pid>.tmp' then renameSync (as tools/levels/server.ts). commit() runs its mutate in one
// synchronous section with no await, so commits are serialized by the event loop; a throwing mutate writes nothing.
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { Commission, InboxEntry } from '../../packages/game/src/economy/contract.ts'

const PLAYER_ID = /^[A-Za-z0-9_-]{1,64}$/

export interface PlayerRecord {
  id: string; coins: number; tickets: number; owned: string[]; inbox: InboxEntry[]; blocks: string[]
  giftLog: number[]   // send timestamps (ms)
}

export interface StoreTx {
  player(id: string): PlayerRecord   // mutable; the same object for the same id within one commit
  sold(itemId: string): number
  setSold(itemId: string, n: number): void
  readonly commissions: Commission[]   // mutable
  hasReward(key: string): boolean
  addReward(key: string): void
}

/** One file loaded for a commit: written back only when its JSON differs from what was read. */
interface Doc<T> { path: string; value: T; before: string }

function checkId(id: string): string {
  if (typeof id !== 'string' || !PLAYER_ID.test(id)) {
    refuse('economy-store', 'playerId', `invalid player id ${JSON.stringify(String(id).slice(0, 80))}: expected ^[A-Za-z0-9_-]{1,64}$`)
  }
  return id
}

function readJson(path: string): unknown {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw e
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`economy store: ${path} is not valid JSON`)
  }
}

function playerOf(id: string, raw: unknown): PlayerRecord {
  const r = (raw ?? {}) as Partial<PlayerRecord>
  return {
    id, coins: r.coins ?? 0, tickets: r.tickets ?? 0, owned: r.owned ?? [], inbox: r.inbox ?? [],
    blocks: r.blocks ?? [], giftLog: r.giftLog ?? [],
  }
}

/** A null-prototype map read from a JSON object, so item ids or keys like 'constructor' never hit Object.prototype. */
function tableOf<V>(raw: unknown): Record<string, V> {
  const table = Object.create(null) as Record<string, V>
  return raw !== null && typeof raw === 'object' && !Array.isArray(raw) ? Object.assign(table, raw) : table
}

export class EconomyStore {
  private readonly dir: string

  constructor(dir: string) {
    this.dir = dir
    mkdirSync(join(dir, 'players'), { recursive: true })
  }

  /** A fresh copy of the player's record; zero coins and tickets and empty lists when the file is missing. */
  player(id: string): PlayerRecord {
    return this.load(this.playerPath(id), (raw) => playerOf(id, raw)).value
  }

  commit(mutate: (tx: StoreTx) => void): void {
    const docs = new Map<string, Doc<unknown>>()
    const open = <T>(path: string, shape: (raw: unknown) => T): T => {
      let doc = docs.get(path)
      if (doc === undefined) docs.set(path, doc = this.load(path, shape))
      return doc.value as T
    }
    const items = () => open(join(this.dir, 'items.json'), (raw) => tableOf<number>(raw))
    const rewards = () => open(join(this.dir, 'rewards.json'), (raw) => tableOf<true>(raw))
    const commissionsPath = join(this.dir, 'commissions.json')
    const tx: StoreTx = {
      player: (id) => open(this.playerPath(id), (raw) => playerOf(id, raw)),
      sold: (itemId) => items()[itemId] ?? 0,
      setSold: (itemId, n) => { items()[itemId] = n },
      get commissions() { return open(commissionsPath, (raw) => (Array.isArray(raw) ? raw as Commission[] : [])) },
      hasReward: (key) => rewards()[key] === true,
      addReward: (key) => { rewards()[key] = true },
    }
    mutate(tx)
    this.write([...docs.values()])
  }

  private playerPath(id: string): string {
    return join(this.dir, 'players', `${checkId(id)}.json`)
  }

  private load<T>(path: string, shape: (raw: unknown) => T): Doc<T> {
    const value = shape(readJson(path))
    return { path, value, before: JSON.stringify(value) }
  }

  /** Writes every changed doc to its tmp file first, then renames them all, so a failed write leaves no file half-done. */
  private write(docs: readonly Doc<unknown>[]): void {
    const changed = docs.map((d) => ({ path: d.path, text: JSON.stringify(d.value) })).filter((w, i) => w.text !== docs[i].before)
    const tmps: string[] = []
    try {
      for (const w of changed) {
        const tmp = `${w.path}.${process.pid}.tmp`
        tmps.push(tmp)
        writeFileSync(tmp, w.text)
      }
    } catch (e) {
      for (const tmp of tmps) rmSync(tmp, { force: true })
      throw e
    }
    for (const w of changed) renameSync(`${w.path}.${process.pid}.tmp`, w.path)
  }
}
