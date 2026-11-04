// Validate shipped meshes through the same decoder, compatibility key and payload checks as the browser: decodeMeshBytes,
// meshCacheKey and meshFileProblem, the code fetchMeshFile runs, so an asset listed here is one the page refuses.
// `--json` prints the list for SDF Modeler (sdfm.game.json "meshCheck"): the Assets tab shows these assets in red.
// The build (apps/web prebuild, no flag) re-meshes stale or missing saved meshes first (rebakeSavedMeshes); `--check`
// only checks.
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseGameAsset } from '../packages/game/src/gameAsset.ts'
import { meshFileProblem } from '../apps/web/src/sdf/meshFile.ts'
import type { MeshFileProblemCode } from '../apps/web/src/sdf/meshFile.ts'
import { decodeMesh, decodeMeshBytes, encodeMesh } from '../apps/web/src/sdf/meshWire.ts'
import { meshCacheKey } from '../apps/web/src/sdf/meshCache.ts'
import { meshHasParts, meshRequestOf } from '../apps/web/src/sdf/mamaApi.ts'
import { buildContentIndex, contentDir, meshCacheDir } from './content.ts'
import { MeshBaker } from './meshBake.ts'

/** missing: no .mesh; decode: the file cannot be decoded; parts: it lacks the named physics parts; else meshFileProblem. */
export type SavedMeshCode = 'missing' | 'decode' | 'parts' | 'asset-file' | MeshFileProblemCode
export interface SavedMeshIssue { id: string; path: string; code: SavedMeshCode; reason: string }

/** Every asset whose saved mesh the game page cannot use, with the reason; empty when all are valid. */
/** MAMA's MESH_COMPATIBILITY through the Node mesher module (a computed specifier: the root typecheck excludes it). */
export async function mamaMeshCompatibility(): Promise<string> {
  const node = await import(new URL('../apps/headless/src/mama/meshNode.ts', import.meta.url).href) as { meshCompatibility(): Promise<string> }
  return node.meshCompatibility()
}

export async function savedMeshIssues(dir = contentDir()): Promise<{ assets: number; issues: SavedMeshIssue[] }> {
  const issues: SavedMeshIssue[] = []
  const index = buildContentIndex(dir)
  let compatibility: string | null = null
  for (const entry of index.assets) {
    const issue = (code: SavedMeshCode, reason: string): void => { issues.push({ id: entry.id, path: entry.path, code, reason }) }
    if (!entry.mesh) { issue('missing', 'missing .mesh; save the asset with SDF Modeler'); continue }
    let asset
    try {
      asset = await parseGameAsset(JSON.parse(readFileSync(join(dir, entry.path), 'utf8')), entry.path)
    } catch (error) { issue('asset-file', `the asset file does not load: ${error instanceof Error ? error.message : String(error)}`); continue }
    let value
    try {
      value = await decodeMeshBytes(new Uint8Array(readFileSync(join(dir, entry.mesh))))
    } catch (error) { issue('decode', `the saved mesh cannot be decoded (${error instanceof Error ? error.message : String(error)})`); continue }
    compatibility ??= await mamaMeshCompatibility()
    const key = await meshCacheKey(asset, compatibility, async bytes => createHash('sha256').update(bytes).digest('hex'))
    const problem = meshFileProblem(value, key, asset)
    if (problem !== null) { issue(problem.code, problem.message); continue }
    if (!meshHasParts(value, meshRequestOf(asset).parts)) issue('parts', 'saved mesh lacks named physics parts')
  }
  return { assets: index.assets.length, issues }
}

export async function checkSavedMeshes(dir = contentDir(), unbaked: ReadonlyMap<string, string> = new Map()): Promise<void> {
  const { assets, issues } = await savedMeshIssues(dir)
  const why = (i: SavedMeshIssue): string => unbaked.has(i.id) ? `${i.reason} (the re-mesh failed: ${unbaked.get(i.id)})` : i.reason
  if (issues.length) throw new Error(`Invalid saved meshes (${issues.length}/${assets}):\n${issues.map(i => `${i.id}: ${why(i)}`).join('\n')}`)
  console.log(`saved meshes: ${assets}/${assets} valid`)
}

/**
 * Re-meshes every asset whose saved mesh is missing or stale (owner 2026-11-04: "stale meshes must be redone when we
 * build") with MeshBaker, the server mesher tools/wavedash.ts uses (its cache is shared by the clone's worktrees), and
 * writes each into the content dir as a saved mesh: the meshed asset plus its S16 key, next to the asset file. An asset
 * whose file does not load is left to the check. Returns why each asset that got no mesh could not be meshed.
 */
export async function rebakeSavedMeshes(dir = contentDir(), cache = meshCacheDir()): Promise<Map<string, string>> {
  const { issues } = await savedMeshIssues(dir)
  const redo = issues.filter(i => i.code !== 'asset-file')
  const unbaked = new Map<string, string>()
  if (redo.length === 0) return unbaked
  const baker = new MeshBaker(dir, cache, redo.map(i => i.id))
  await baker.scan()
  for (const issue of redo) {
    const key = baker.keyOf.get(issue.id)
    const base = key === undefined ? null : join(cache, key)
    if (base === null || !existsSync(base + '.mesh')) {
      unbaked.set(issue.id, base !== null && existsSync(base + '.failed')
        ? `${readFileSync(base + '.failed', 'utf8').trim()}; delete ${base}.failed to mesh it again`
        : 'the mesher wrote no mesh (another process holds its lock)')
      continue
    }
    const target = join(dir, issue.path.replace(/\.asset\.json$/, '.mesh'))
    writeFileSync(target + '.tmp', encodeMesh({ ...decodeMesh(new Uint8Array(readFileSync(base + '.mesh'))), key }))
    renameSync(target + '.tmp', target)
    console.log(`saved mesh: ${issue.id} re-meshed (was: ${issue.reason})`)
  }
  return unbaked
}

/** The build's step (apps/web prebuild): stale or missing saved meshes are re-meshed, then every saved mesh is checked. */
export async function prebuildSavedMeshes(dir = contentDir(), cache = meshCacheDir()): Promise<void> {
  await checkSavedMeshes(dir, await rebakeSavedMeshes(dir, cache))
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--json')) {
    const { assets, issues } = await savedMeshIssues()
    process.stdout.write(`${JSON.stringify({ format: 'sdfm.mesh-check', version: 1, assets, stale: issues })}\n`)
  } else if (process.argv.includes('--check')) await checkSavedMeshes()
  else await prebuildSavedMeshes()
}
