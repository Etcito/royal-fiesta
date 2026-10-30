// Use the normal match content and RAA mesh port; only the far LOD is zone-specific.
import type { ProfileName } from '@royal-fiesta/sim/course'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderTarget } from '@royal-fiesta/game/render/port'
import { farFigureMesh } from '@royal-fiesta/game/render/farRender'
import { pickContent } from '../content/source.ts'
import { skinnedCharacterOf } from '../content/providers/sdf.ts'
import { loadSdfContent } from '../content/sdfLoad.ts'
import { createSdfPort } from '../sdf/sdfPort.ts'

// One load per profile for the page: two lobbies of one GPU job (zoneLobbyPair) share it.
const loads = new Map<ProfileName, ReturnType<typeof loadZoneContent>>()

async function loadZoneContent(profile: ProfileName) {
  const content = pickContent(new URLSearchParams({ content: 'sdf' }))
  await content.load(profile, () => {})
  // The second load reuses the normal content's memory mesh cache.
  const loaded = await loadSdfContent(profile, () => {})
  return { content, loaded }
}

export function zoneContent(profile: ProfileName) {
  let load = loads.get(profile)
  if (load === undefined) {
    load = loadZoneContent(profile)
    loads.set(profile, load)
    // A failed load is not cached: the next lobby retries it.
    load.catch(() => { if (loads.get(profile) === load) loads.delete(profile) })
  }
  return load.then(({ content, loaded }) => zoneContentOf(content, loaded))
}

function zoneContentOf(content: ReturnType<typeof pickContent>, loaded: Awaited<ReturnType<typeof loadSdfContent>>) {
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
