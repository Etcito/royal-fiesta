// Use the normal match content and RAA mesh port; only the far LOD is zone-specific.
import type { ProfileName } from '@royal-fiesta/sim/course'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderTarget } from '@royal-fiesta/game/render/port'
import { farFigureMesh } from '@royal-fiesta/game/render/farRender'
import { SdfContent, skinnedCharacterOf } from '../content/providers/sdf.ts'
import { createSdfPort } from '../sdf/sdfPort.ts'

// Cache each course independently; a round never joins a pending full lobby load.
const loads = new Map<string, ReturnType<typeof loadZoneContent>>()

async function loadZoneContent(profile: ProfileName, courseId?: string) {
  const content = new SdfContent(courseId)
  await content.load(profile, () => {})
  // Reuse the exact mesh set already loaded by this content instance.
  const loaded = content.meshData()
  return { content, loaded }
}

export function zoneContent(profile: ProfileName, courseId?: string) {
  const key = `${profile}:${courseId ?? '*'}`
  let load = loads.get(key)
  if (load === undefined) {
    load = loadZoneContent(profile, courseId)
    loads.set(key, load)
    // A failed load is not cached: the next lobby retries it.
    load.catch(() => { if (loads.get(key) === load) loads.delete(key) })
  }
  return load.then(({ content, loaded }) => zoneContentOf(content, loaded))
}

function zoneContentOf(content: SdfContent, loaded: ReturnType<SdfContent['meshData']>) {
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
