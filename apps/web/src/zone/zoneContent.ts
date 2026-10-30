// Use the normal match content and RAA mesh port; only the far LOD is zone-specific.
import type { ProfileName } from '@royal-fiesta/sim/course'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderTarget } from '@royal-fiesta/game/render/port'
import { farFigureMesh } from '@royal-fiesta/game/render/farRender'
import { pickContent } from '../content/source.ts'
import { skinnedCharacterOf } from '../content/providers/sdf.ts'
import { loadSdfContent } from '../content/sdfLoad.ts'
import { createSdfPort } from '../sdf/sdfPort.ts'

export async function zoneContent(profile: ProfileName) {
  const content = pickContent(new URLSearchParams({ content: 'sdf' }))
  await content.load(profile, () => {})
  // The second load reuses the normal content's memory mesh cache.
  const loaded = await loadSdfContent(profile, () => {})
  const id = 'zone.far-bean'
  const data = farFigureMesh()
  loaded.meshed.set(id, { assetId: id, hash: '', mesher: 'paramesh', parts: 1,
    triangles: data.groups[0].parts[0].meshes[0].indices.length / 3, data, transfer: [] })
  const bean: PrimsAsset = { format: 'raa.prims', version: 0, id, name: id,
    budget: { triangles: 0, segments: 0 }, nodes: [], materials: {}, anchors: {},
    collision: { mode: 'override', colliders: [] } }
  return {
    assets: (name: string) => content.assets(name),
    character: content.character(), bean, skinned: skinnedCharacterOf(content), dressing: content.dressing(),
    createPort: (target: RenderTarget) => createSdfPort(target, loaded.meshed, loaded.failed),
  }
}
