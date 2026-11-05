// Lightweight game adapter for MAMA's rigRef wire format. The mesher validates the complete resolved rig in MAMA.
// No animation evaluation here: the game and SDF Modeler use the raa-anim WASM brick.
import { refuse } from '@royal-fiesta/sim/refusal'

type Obj = Record<string, any>
export type RigAssetLoader = (game: string, id: string) => Promise<Record<string, unknown> | null>

/** Palette routing only: vertex weights are produced by MAMA, including legacy whole-costume binding handling.
 * Keep each inherited bone's own pose; extra bones follow their nearest penguin ancestor until jiggle overrides it. */
export function rigReferenceSourceBones(bones: readonly { name: string; parent: string | null }[],
  penguin: readonly { name: string }[]): number[] {
  const indices = new Map(penguin.map((b, i) => [b.name, i]))
  return bones.map(b => {
    const inherited = indices.get(b.name)
    const at = inherited ?? (b.parent === null ? undefined : indices.get(b.parent))
    if (at === undefined) throw new Error(`Referenced cosmetic bone '${b.name}' has no penguin ancestor`)
    indices.set(b.name, at)
    return at
  })
}

export function validateGameRigReferences(document: Record<string, unknown>): void {
  const nodes = document.nodes as Record<string, Obj>
  for (const [id, node] of Object.entries(nodes ?? {})) {
    if (node.rigRef === undefined) continue
    const ref = node.rigRef
    const fail = (why: string): never => refuse('asset', `nodes/${id}/rigRef`, `invalid rig reference: ${why}`)
    if (node.kind !== 'group' || !ref || typeof ref !== 'object' || Array.isArray(ref)) fail('expected a group with a rigRef object')
    for (const k of Object.keys(ref)) if (!['game', 'id', 'node', 'extraBones', 'bindings', 'smooth'].includes(k)) fail(`unknown field '${k}'`)
    if (typeof ref.game !== 'string' || !/^[a-z][a-z0-9-]*$/.test(ref.game) || typeof ref.id !== 'string' || !/^[a-z][a-z0-9]*(\.[a-z0-9-]+)+$/.test(ref.id) || typeof ref.node !== 'string' || !ref.node) fail('expected game, asset id and source node id')
    if (!Array.isArray(ref.extraBones) || ref.extraBones.length > 255) fail('expected at most 255 extraBones')
    const names = new Set<string>()
    const vector = (v: unknown, n: number): v is number[] => Array.isArray(v) && v.length === n && v.every(x => typeof x === 'number' && Number.isFinite(x))
    for (const b of ref.extraBones) {
      if (!b || typeof b.name !== 'string' || !/^[A-Za-z0-9_.-]{1,32}$/.test(b.name) || names.has(b.name)) fail('invalid or duplicate extra bone name')
      names.add(b.name)
      if (typeof b.parent !== 'string' || !b.parent) fail(`extra bone '${b.name}' needs a parent bone`)
      if (!b.rest || !vector(b.rest.t, 3) || !vector(b.rest.r, 4) || Math.abs(Math.hypot(...b.rest.r) - 1) > 1e-3 || !vector(b.rest.s, 3) || b.rest.s.some((x: number) => x <= 0)) fail(`invalid rest transform of '${b.name}'`)
    }
    if (ref.bindings !== undefined && !Array.isArray(ref.bindings)) fail('bindings must be an array')
  }
}

export async function resolveGameRigs(document: Record<string, unknown>, load: RigAssetLoader, stack: readonly string[] = []): Promise<Record<string, unknown>> {
  validateGameRigReferences(document)
  const nodes = document.nodes as Record<string, Obj>
  let resolved: Record<string, Obj> | undefined
  for (const [id, node] of Object.entries(nodes ?? {})) {
    const ref = node.rigRef as Obj | undefined
    if (ref === undefined) continue
    const path = `nodes/${id}/rigRef`
    const fail = (why: string): never => refuse('asset', path, `rig reference ${ref.game}/${ref.id}#${ref.node}: ${why}; restore the source armature or fix rigRef`)
    if (!ref || typeof ref.game !== 'string' || typeof ref.id !== 'string' || typeof ref.node !== 'string' || !Array.isArray(ref.extraBones)) fail('expected game, id, node and extraBones')
    const key = `${ref.game}/${ref.id}#${ref.node}`
    if (stack.includes(key)) fail('cyclic reference')
    const source = await load(ref.game, ref.id)
    if (!source) fail('asset not found')
    const sourceNodes = source!.nodes as Record<string, Obj>
    const raw = sourceNodes?.[ref.node]
    if (!raw || raw.kind !== 'group') fail('rig node not found')
    const owner = raw.rigRef
      ? ((await resolveGameRigs({ nodes: { [ref.node]: raw } }, load, [...stack, key])).nodes as Record<string, Obj>)[ref.node] : raw
    if (!owner.rig) fail('node has no armature')
    const rig = structuredClone(owner.rig)
    const names = new Set(rig.bones.map((b: Obj) => b.name))
    for (const b of ref.extraBones) {
      if (!b || typeof b.name !== 'string' || names.has(b.name)) fail('extra bone shadows a referenced bone or is invalid')
      if (typeof b.parent !== 'string' || !names.has(b.parent)) fail(`unknown or unordered extra bone parent '${b.parent}'`)
      names.add(b.name)
    }
    rig.bones.push(...structuredClone(ref.extraBones))
    rig.bindings = structuredClone(ref.bindings ?? [])
    if (ref.smooth !== undefined) rig.smooth = ref.smooth
    delete rig.parentBone
    for (const row of rig.bindings) for (const b of row.bones) if (!names.has(b.bone)) fail(`binding names unknown bone '${b.bone}'`)
    resolved ??= { ...nodes }
    resolved[id] = { ...node, rig, clips: structuredClone(owner.clips ?? []) }
  }
  return resolved ? { ...document, nodes: resolved } : document
}
