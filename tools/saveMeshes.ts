import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { GameAsset } from '../packages/game/src/gameAsset.ts'
import { parseGameAsset } from '../packages/game/src/gameAsset.ts'
import { resolveGameRigs } from '../packages/game/src/rigReference.ts'
import type { MeshedAsset } from '../apps/web/src/sdf/mamaApi.ts'
import { meshRequestOf } from '../apps/web/src/sdf/mamaApi.ts'
import { meshCacheKey } from '../apps/web/src/sdf/meshCache.ts'
import { decodeMesh, encodeMesh } from '../apps/web/src/sdf/meshWire.ts'
import { MAMA_ABSENT_PREFIX, mamaSource } from './bricks.ts'
import { buildContentIndex, contentDir } from './content.ts'
import { meshTimeoutMs } from './meshBake.ts'

export interface SavedMeshResult { id: string; path: string; status: 'saved' | 'failed'; parts: number; field: number; refused: number; bytes: number; reason?: string }

type Options = { dir?: string; worlds?: readonly string[]; ids?: readonly string[]; jobs?: number; mesh?: (asset: GameAsset) => Promise<MeshedAsset>; compatibility?: string }
type NodeMesher = { meshCompatibility(): Promise<string>; meshGameAsset(asset: GameAsset, options: { timeoutMs: number }): Promise<MeshedAsset> }

// The names a saved mesh must keep: the asset's physics parts and every part a valid previous saved mesh still has.
function namedParts(value: MeshedAsset): Set<string> {
  const groups = (value.data as { groups?: { parts?: { name?: unknown }[] }[] } | null)?.groups ?? []
  return new Set(groups.flatMap(group => (group.parts ?? []).map(part => part.name)).filter((name): name is string => typeof name === 'string'))
}

function previousParts(path: string): Set<string> {
  try {
    return namedParts(decodeMesh(new Uint8Array(readFileSync(path))))
  } catch {
    return new Set()
  }
}

export async function saveMeshes(opts: Options = {}): Promise<SavedMeshResult[]> {
  const dir = opts.dir ?? contentDir()
  const entries = buildContentIndex(dir).assets
  const selected = entries.filter(e => e.mesh && (!opts.worlds?.length || opts.worlds.includes(e.world)) && (!opts.ids?.length || opts.ids.includes(e.id)))
  let node: NodeMesher | undefined
  if (!opts.mesh || opts.compatibility === undefined) {
    const source = mamaSource()
    if (source.kind === 'absent') throw new Error(MAMA_ABSENT_PREFIX + source.reason)
    node = await import(new URL('../apps/headless/src/mama/meshNode.ts', import.meta.url).href) as NodeMesher
  }
  const compatibility = opts.compatibility ?? await node!.meshCompatibility()
  const mesh = opts.mesh ?? ((asset: GameAsset) => node!.meshGameAsset(asset, { timeoutMs: meshTimeoutMs() }))
  const requested = opts.jobs ?? Number(process.env.NMC_CPUS ?? 1)
  const jobs = Number.isFinite(requested) && requested >= 1 ? Math.floor(requested) : 1
  const results = new Array<SavedMeshResult>(selected.length)
  let next = 0
  const readAsset = async (entry: typeof entries[number]): Promise<GameAsset> =>
    parseGameAsset(JSON.parse(await readFile(join(dir, entry.path), 'utf8')), entry.path)
  const work = async (): Promise<void> => {
    for (;;) {
      const i = next++
      if (i >= selected.length) return
      const entry = selected[i]
      const target = join(dir, entry.mesh!)
      const tmp = target + '.tmp'
      try {
        const asset = await readAsset(entry)
        asset.document = await resolveGameRigs(asset.document, async (game, id) => {
          const reference = entries.find(e => e.id === id)
          if (!reference) return null
          const source = await readAsset(reference)
          return source.game === game ? source.document : null
        })
        const key = await meshCacheKey(asset, compatibility, async bytes => createHash('sha256').update(bytes).digest('hex'))
        const value = await mesh(asset)
        // A previous save that lacks a physics part was merged by the mesher bug (one part named after the group,
        // committed by a re-save before 018a348): its names are not a reference, or the correct split is refused.
        const physics = meshRequestOf(asset).parts ?? []
        const previous = previousParts(target)
        const expected = new Set([...physics, ...(physics.every(name => previous.has(name)) ? previous : [])])
        const saved = namedParts(value)
        const missing = [...expected].filter(name => !saved.has(name))
        if (missing.length > 0) throw new Error(`the meshed asset lacks named physics parts (${missing.join(', ')}); the mesher merged parts or dropped their names`)
        const groups = (value.data as { groups: { parts: { fieldProgram?: unknown; fieldRefusal?: unknown }[] }[] }).groups
        const parts = groups.flatMap(group => group.parts)
        const bytes = encodeMesh({ ...value, key })
        await writeFile(tmp, bytes)
        await rename(tmp, target)
        results[i] = { id: entry.id, path: entry.mesh!, status: 'saved', parts: value.parts, field: parts.filter(p => p.fieldProgram != null).length, refused: parts.filter(p => p.fieldRefusal != null).length, bytes: bytes.length }
      } catch (error) {
        results[i] = { id: entry.id, path: entry.mesh!, status: 'failed', parts: 0, field: 0, refused: 0, bytes: 0, reason: error instanceof Error ? error.message : String(error) }
      } finally {
        await rm(tmp, { force: true })
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, selected.length) }, work))
  return results
}

export async function main(argv: string[], opts: Options = {}): Promise<number> {
  try {
    const worlds: string[] = []
    const ids: string[] = []
    for (let i = 0; i < argv.length; i++) {
      const flag = argv[i]
      if ((flag !== '--world' && flag !== '--id') || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('usage: npm run mesh:save -- [--world <w>]... [--id <id>]...')
      ;(flag === '--world' ? worlds : ids).push(argv[++i])
    }
    const results = await saveMeshes({ ...opts, worlds, ids })
    for (const result of results) {
      console.log(result.status === 'saved'
        ? `mesh:save: ${result.id} saved parts ${result.parts} field ${result.field} refused ${result.refused} ${result.bytes}`
        : `mesh:save: ${result.id} failed ${result.reason}`)
    }
    const failed = results.filter(r => r.status === 'failed').length
    console.log(`mesh:save: ${results.length - failed} saved, ${failed} failed`)
    return failed ? 1 : 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await main(process.argv.slice(2))
