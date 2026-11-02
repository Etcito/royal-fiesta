// Validate shipped meshes through the same decoder, compatibility key and payload checks as the browser.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseGameAsset } from '../packages/game/src/gameAsset.ts'
import { fetchMeshFile } from '../apps/web/src/sdf/meshFile.ts'
import { meshCacheKey } from '../apps/web/src/sdf/meshCache.ts'
import { meshHasParts, meshRequestOf } from '../apps/web/src/sdf/mamaApi.ts'
import { buildContentIndex, contentDir } from './content.ts'

export async function checkSavedMeshes(dir = contentDir()): Promise<void> {
  const issues: string[] = []
  const index = buildContentIndex(dir)
  for (const entry of index.assets) {
    try {
      if (!entry.mesh) throw new Error('missing .mesh; save the asset with SDF Modeler')
      const asset = await parseGameAsset(JSON.parse(readFileSync(join(dir, entry.path), 'utf8')), entry.path)
      const key = await meshCacheKey(asset, '', '', async bytes => createHash('sha256').update(bytes).digest('hex'))
      const mesh = await fetchMeshFile(entry.mesh, key, asset, (async () => new Response(readFileSync(join(dir, entry.mesh!)))) as typeof fetch)
      if (!mesh) throw new Error('stale .mesh; re-save the asset with SDF Modeler')
      if (!meshHasParts(mesh, meshRequestOf(asset).parts)) throw new Error('saved mesh lacks named physics parts')
    } catch (error) { issues.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`) }
  }
  if (issues.length) throw new Error(`Invalid saved meshes (${issues.length}/${index.assets.length}):\n${issues.join('\n')}`)
  console.log(`saved meshes: ${index.assets.length}/${index.assets.length} valid`)
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await checkSavedMeshes()
