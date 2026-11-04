// Validate shipped meshes through the same decoder, compatibility key and payload checks as the browser: decodeMeshBytes,
// meshCacheKey and meshFileProblem, the code fetchMeshFile runs, so an asset listed here is one the page refuses.
// `--json` prints the list for SDF Modeler (sdfm.game.json "meshCheck"): the Assets tab shows these assets in red.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseGameAsset } from '../packages/game/src/gameAsset.ts'
import { meshFileProblem } from '../apps/web/src/sdf/meshFile.ts'
import type { MeshFileProblemCode } from '../apps/web/src/sdf/meshFile.ts'
import { decodeMeshBytes } from '../apps/web/src/sdf/meshWire.ts'
import { meshCacheKey } from '../apps/web/src/sdf/meshCache.ts'
import { meshHasParts, meshRequestOf } from '../apps/web/src/sdf/mamaApi.ts'
import { buildContentIndex, contentDir } from './content.ts'

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

export async function checkSavedMeshes(dir = contentDir()): Promise<void> {
  const { assets, issues } = await savedMeshIssues(dir)
  if (issues.length) throw new Error(`Invalid saved meshes (${issues.length}/${assets}):\n${issues.map(i => `${i.id}: ${i.reason}`).join('\n')}`)
  console.log(`saved meshes: ${assets}/${assets} valid`)
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.includes('--json')) {
    const { assets, issues } = await savedMeshIssues()
    process.stdout.write(`${JSON.stringify({ format: 'sdfm.mesh-check', version: 1, assets, stale: issues })}\n`)
  } else await checkSavedMeshes()
}
