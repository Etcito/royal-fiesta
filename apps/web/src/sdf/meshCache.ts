// S16 client mesh cache: an in-memory Map over IndexedDB, keyed by sha256 of the asset hash,
// its canonical mesher, and both brick versions. Values are stored as they came from the mesher.
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import { canonicalJson } from '@royal-fiesta/game/course'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { MeshedAsset } from './mamaApi.ts'

const DB_NAME = 'royal-fiesta-mesh'
const STORE_NAME = 'meshes'
const DB_VERSION = 1

export async function meshCacheKey(a: GameAsset, mamaVersion: string, raaSdfmVersion: string, sha256Hex: (b: Uint8Array) => Promise<string>): Promise<string> {
  const material = `${a.hash}|${canonicalJson(a.mesher)}|${mamaVersion}|${raaSdfmVersion}`
  return sha256Hex(new TextEncoder().encode(material))
}

export interface MeshStore {
  get(key: string): Promise<MeshedAsset | null>
  put(key: string, v: MeshedAsset): Promise<void>
  delete(key: string): Promise<void>
}

export function memoryStore(): MeshStore {
  const map = new Map<string, MeshedAsset>()
  return {
    async get(key: string): Promise<MeshedAsset | null> { return map.get(key) ?? null },
    async put(key: string, v: MeshedAsset): Promise<void> { map.set(key, v) },
    async delete(key: string): Promise<void> { map.delete(key) },
  }
}

function openDb(factory: IDBFactory): Promise<IDBDatabase> {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const req = factory.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE_NAME)) db.createObjectStore(STORE_NAME)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error ?? new Error('cannot open the mesh cache database'))
    req.onblocked = () => reject(new Error('the mesh cache database is blocked by another tab'))
  })
}

function transact<T>(db: IDBDatabase, mode: IDBTransactionMode, run: (store: IDBObjectStore) => IDBRequest<any>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode)
    const req = run(tx.objectStore(STORE_NAME))
    tx.oncomplete = () => resolve(req.result as T)
    tx.onerror = () => reject(tx.error ?? new Error('mesh cache transaction failed'))
    tx.onabort = () => reject(tx.error ?? new Error('mesh cache transaction aborted'))
  })
}

export function idbStore(factory?: IDBFactory): MeshStore {
  // Resolved at call time: Node has no indexedDB, and the page may inject a test factory.
  const idb = factory ?? globalThis.indexedDB
  if (!idb) throw new RefusalError('sdf', 'IndexedDB', 'indexedDB is not available; keep the mesh cache in memory')
  let opened: Promise<IDBDatabase> | null = null
  const db = (): Promise<IDBDatabase> => {
    if (opened === null) opened = openDb(idb)
    return opened
  }
  return {
    async get(key: string): Promise<MeshedAsset | null> {
      return (await transact<MeshedAsset | null>(await db(), 'readonly', (s) => s.get(key))) ?? null
    },
    async put(key: string, v: MeshedAsset): Promise<void> {
      await transact(await db(), 'readwrite', (s) => s.put(v, key))
    },
    async delete(key: string): Promise<void> {
      await transact(await db(), 'readwrite', (s) => s.delete(key))
    },
  }
}

function validMeshed(v: unknown): v is MeshedAsset {
  if (typeof v !== 'object' || v === null) return false
  const m = v as Record<string, unknown>
  return typeof m.assetId === 'string' && typeof m.hash === 'string' && Array.isArray(m.transfer) &&
    typeof m.parts === 'number' && typeof m.triangles === 'number'
}

export class MeshCache {
  readonly stats: { memory: number; idb: number; miss: number; evictedCorrupt: number } = { memory: 0, idb: 0, miss: 0, evictedCorrupt: 0 }
  private readonly memory: MeshStore
  private readonly persistent: MeshStore | null

  constructor(layers: { memory: MeshStore; persistent: MeshStore | null }) {
    this.memory = layers.memory
    this.persistent = layers.persistent
  }

  async get(key: string): Promise<{ value: MeshedAsset; from: 'memory' | 'idb' } | null> {
    const inMemory = await this.memory.get(key)
    if (inMemory !== null) {
      if (validMeshed(inMemory)) {
        this.stats.memory++
        return { value: inMemory, from: 'memory' }
      }
      // An undecodable entry is a miss for this layer: drop it and let persistent answer.
      this.stats.evictedCorrupt++
      await this.memory.delete(key)
    }
    if (this.persistent === null) {
      this.stats.miss++
      return null
    }
    const fromIdb = await this.persistent.get(key)
    if (fromIdb === null) {
      this.stats.miss++
      return null
    }
    if (!validMeshed(fromIdb)) {
      this.stats.evictedCorrupt++
      await this.persistent.delete(key)
      this.stats.miss++
      return null
    }
    await this.memory.put(key, fromIdb)
    this.stats.idb++
    return { value: fromIdb, from: 'idb' }
  }

  async put(key: string, v: MeshedAsset): Promise<void> {
    // The value is never transformed: a hit is the same bytes the mesher produced.
    await this.memory.put(key, v)
    if (this.persistent !== null) await this.persistent.put(key, v)
  }
}
