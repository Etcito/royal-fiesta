import type { RenderPort, SkinnedAssetT, SkinPartT, SkinRigT } from '@royal-fiesta/game/render/port'

/** Part names follow the SDF port upload, including its duplicate-name disambiguation. */
export function assetSkin(data: unknown, document: Record<string, unknown>, penguin?: SkinRigT): SkinnedAssetT | null {
  const payload = data as { groups: { group: string; parts: { partId: string; name: string; skin?: SkinPartT['skin'] }[] }[] }
  const parts: SkinPartT[] = [], keys = new Set<string>()
  for (const group of payload.groups) for (const part of group.parts) {
    const name = keys.has(part.name) ? `${group.group}/${part.partId}` : part.name
    keys.add(name)
    if (part.skin) parts.push({ name, skin: part.skin })
  }
  if (!parts.length) return null
  const nodes = document.nodes as Record<string, { rig?: SkinRigT; clips?: unknown[]; asset?: { cosmetic?: { binding: string } } }>
  const owner = Object.values(nodes).find(n => n.rig)
  if (!owner?.rig) throw new Error('Skinned asset is missing its rig')
  if (penguin) {
    if (owner.asset?.cosmetic?.binding !== 'penguin') return null
    if (JSON.stringify(owner.rig.bones) !== JSON.stringify(penguin.bones)) throw new Error('Cosmetic rig must match penguin bone order and rest transforms')
  }
  return { rig: owner.rig, clips: owner.clips ?? [], parts }
}

/**
 * Registers every penguin-bound skinned cosmetic of `meshed` on `port` and returns how many. WornMounts and the
 * costume slots pose a cosmetic with the body only when port.skinOf knows it, so every port that draws worn
 * cosmetics calls this before it is presented; a port without it draws them rigid, at rest (the show rounds'
 * zone port, 2026-11-03). `characterId` is skipped: SceneView registers the character itself.
 */
export async function registerCosmeticSkins(
  port: Pick<RenderPort, 'registerSkinned'>,
  meshed: ReadonlyMap<string, { data: unknown }>,
  penguin: SkinRigT,
  documentOf: (id: string) => Promise<Record<string, unknown>>,
  characterId: string,
): Promise<number> {
  if (port.registerSkinned === undefined) return 0
  let count = 0
  for (const [id, entry] of meshed) {
    if (id === characterId) continue
    const payload = entry.data as { groups?: { parts: { skin?: unknown }[] }[] }
    if (!payload.groups?.some(g => g.parts.some(p => p.skin))) continue
    const skin = assetSkin(entry.data, await documentOf(id), penguin)
    if (skin) { port.registerSkinned(id, skin); count++ }
  }
  return count
}
