import type { SkinnedAssetT, SkinPartT, SkinRigT } from '@royal-fiesta/game/render/port'

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
