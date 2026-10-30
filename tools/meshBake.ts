// Persistent, bounded server meshing. A lock excludes duplicate work across play and CLI processes.
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, unlinkSync, openSync, closeSync, statSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseGameAsset } from '@royal-fiesta/game/gameAsset'
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import { meshCacheKey } from '../apps/web/src/sdf/meshCache.ts'
import { encodeMesh } from '../apps/web/src/sdf/meshWire.ts'
import { buildContentIndex, contentDir, meshCacheDir } from './content.ts'
import type { MeshedAsset } from '../apps/web/src/sdf/mamaApi.ts'

interface NodeMesher {
  mamaVersion(): string
  raaSdfmVersion(): string
  meshWholeAsset(asset: GameAsset, timeoutMs: number, signal?: AbortSignal): Promise<MeshedAsset>
}
export { meshCacheDir }
export const meshTimeoutMs = (): number => positive(process.env.RF_MESH_TIMEOUT_S, 300) * 1000
function positive(value: string | undefined, fallback: number): number {
  const n = value === undefined ? fallback : Number(value)
  if (!Number.isFinite(n) || n <= 0) throw new Error('mesh limits must be positive finite numbers')
  return n
}
export class MeshBaker {
  readonly pending = new Set<string>()
  private running: Promise<void> | null = null
  private readonly controller = new AbortController()
  stop(): void { this.controller.abort() }
  private readonly reported = new Set<string>()
  readonly dir: string
  readonly cache: string
  constructor(dir = contentDir(), cache = meshCacheDir()) { this.dir = dir; this.cache = cache }
  scan(): Promise<void> {
    this.running ??= this.bake().finally(() => { this.running = null })
    return this.running
  }
  private async bake(): Promise<void> {
    const moduleUrl = new URL('../apps/headless/src/mama/meshNode.ts', import.meta.url).href
    const node = await import(moduleUrl) as NodeMesher
    const mama = node.mamaVersion(), raa = node.raaSdfmVersion()
    const timeout = meshTimeoutMs()
    const queue: { asset: GameAsset; key: string }[] = []
    mkdirSync(this.cache, { recursive: true })
    for (const entry of buildContentIndex(this.dir).assets) {
      const asset = await parseGameAsset(JSON.parse(readFileSync(join(this.dir, entry.path), 'utf8')), entry.path)
      const key = await meshCacheKey(asset, mama, raa, async bytes => createHash('sha256').update(bytes).digest('hex'))
      queue.push({ asset, key })
      this.pending.add(key)
    }
    const work = async (): Promise<void> => {
      for (;;) {
        if (this.controller.signal.aborted) return
        const item = queue.shift()
        if (!item) return
        const { asset, key } = item
        const base = join(this.cache, key)
        const start = performance.now()
        try {
          if (existsSync(base + '.mesh') || existsSync(base + '.failed')) {
            if (!this.reported.has(key)) console.log(`mesh: ${asset.id} cached ${key}`)
            this.reported.add(key)
            continue
          }
          let lock: number
          try { lock = openSync(base + '.lock', 'wx') } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
            // a lock older than the meshing limit belongs to a process that was killed: take it over
            if (Date.now() - statSync(base + '.lock').mtimeMs <= timeout + 60_000) continue
            unlinkSync(base + '.lock')
            lock = openSync(base + '.lock', 'wx')
          }
          closeSync(lock)
          try {
            const value = await node.meshWholeAsset(asset, timeout, this.controller.signal)
            writeFileSync(base + '.tmp', encodeMesh(value))
            renameSync(base + '.tmp', base + '.mesh')
            console.log(`mesh: ${asset.id} ${((performance.now() - start) / 1000).toFixed(2)}s ${value.triangles} triangles ${key}`)
          } catch (error) {
            if (this.controller.signal.aborted) return
            const reason = error instanceof Error ? error.message : String(error)
            writeFileSync(base + '.failed', reason)
            console.log(`mesh: ${asset.id} ${((performance.now() - start) / 1000).toFixed(2)}s FAILED ${reason} ${key}`)
          } finally { unlinkSync(base + '.lock') }
        } finally { this.pending.delete(key) }
      }
    }
    await Promise.all(Array.from({ length: Math.max(1, Math.floor(positive(process.env.RF_MESH_JOBS, 3))) }, work))
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await new MeshBaker().scan()
}
