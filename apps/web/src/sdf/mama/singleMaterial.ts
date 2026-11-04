// One material per object (owner 2026-11-04), the game side of SDF Modeler's core/game/single-material.ts (same tags,
// same colours). ON (default): an asset part is drawn as ONE PBR object, one standard material (white base x vertex
// colour, the part's mean roughness and metallic; RAA Engine.setSingleMaterial + setInstanceMaterial) whose vertex colours
// are the shapes' own material colours blended by MAMA's smooth-min material weight (la/lb/t). OFF (group tagged
// 'per-face-materials'): each face keeps the graph material of the shape that makes it. A group's own material is never
// used for colour.
import { buildIndex } from '@etcito/mama/core/doc/tree.ts'
import type { SdfDocument } from '@etcito/mama/core/doc/types.ts'
import { cpuGraphOrNull } from '@etcito/mama/core/material-graph/cpu-eval.ts'
import type { Mesh } from '@etcito/mama/core/mesh/types.ts'
import type { SdfProgram } from '@etcito/mama/core/sdf/program.ts'

export const PER_FACE_MATERIALS_TAG = 'per-face-materials'
export const SINGLE_MATERIAL_TAG = 'single-material'

/** True when group/shape `id` draws one material per object: the nearest group (itself or above) with a tag decides; default ON. */
export function singleMaterialOf(doc: SdfDocument, id: string): boolean {
  if (!doc.nodes[id]) return true
  for (const n of [id, ...buildIndex(doc).ancestors(id)]) {
    const node = doc.nodes[n]
    if (node?.kind !== 'group') continue
    if (node.tags?.includes(PER_FACE_MATERIALS_TAG)) return false
    if (node.tags?.includes(SINGLE_MATERIAL_TAG)) return true
  }
  return true
}

interface MaterialLook { color: [number, number, number]; roughness: number; metallic: number }
const NEUTRAL_MASKS = { curvature: 0, cavity: 0, ao: 1, height: 0, proximity: 0 }
const looks = new WeakMap<object, MaterialLook | null>()

function materialLook(doc: SdfDocument, id: string | null | undefined): MaterialLook | null {
  const def = id ? doc.materials?.[id] : undefined
  if (!def) return null
  if (looks.has(def)) return looks.get(def)!
  let look: MaterialLook | null = null
  try {
    const graph = cpuGraphOrNull(def, doc)
    if (graph) {
      const v = graph.eval([0, 0, 0], [0, 0, 0], [0, 0, 1], () => NEUTRAL_MASKS)
      look = { color: [v.baseColor[0], v.baseColor[1], v.baseColor[2]], roughness: v.roughness, metallic: v.metallic }
    }
  } catch { look = null }
  looks.set(def, look)
  return look
}

/** Linear rgb per source-mesh vertex: the two owning shapes' material colours mixed by t; null without la/lb/t labels or materials. */
function blendedColours(doc: SdfDocument, mesh: Mesh, program: SdfProgram): Float32Array | null {
  const labels = mesh.labels
  if (!labels || !program.materialSlots.some(m => m && doc.materials?.[m])) return null
  const cache = new Map<number, readonly number[]>()
  const colourOf = (label: number): readonly number[] => {
    let c = cache.get(label)
    if (c) return c
    const l = program.labels[label]
    const slot = l?.materialSlot ?? -1
    c = materialLook(doc, slot >= 0 ? program.materialSlots[slot] : null)?.color ?? [1, 1, 1]
    cache.set(label, c)
    return c
  }
  const n = mesh.positions.length / 3, out = new Float32Array(n * 3)
  for (let v = 0; v < n; v++) {
    const a = colourOf(labels.la[v]), b = colourOf(labels.lb[v]), t = labels.lb[v] === labels.la[v] ? 0 : labels.t[v]
    for (let k = 0; k < 3; k++) out[v * 3 + k] = a[k] + (b[k] - a[k]) * t
  }
  return out
}

const key = (p: ArrayLike<number>, v: number): string => `${p[v * 3]},${p[v * 3 + 1]},${p[v * 3 + 2]}`

/**
 * The part's colouring for one material per object: `colors(mesh)` gives a payload mesh its linear rgba per vertex (found
 * by position in the mesher's mesh, which the material split and the repair copy exactly; a material-less mesh or an
 * unmatched vertex stays white, so a material-less part looks as before), and `look` the part's one roughness/metallic
 * (mean over its materials' vertices). Null when the mesh carries no la/lb/t labels or the part uses no material.
 */
export function partColouring(doc: SdfDocument, mesh: Mesh, program: SdfProgram): {
  colors(m: { material: string | null; positions: Float32Array }): Float32Array
  look(meshes: readonly { material: string | null; positions: Float32Array }[]): { roughness: number; metallic: number }
} | null {
  const blended = blendedColours(doc, mesh, program)
  if (!blended) return null
  const at = new Map<string, number>()
  for (let v = 0; v < mesh.positions.length / 3; v++) if (!at.has(key(mesh.positions, v))) at.set(key(mesh.positions, v), v)
  return {
    colors(m) {
      const n = m.positions.length / 3, out = new Float32Array(n * 4).fill(1)
      if (m.material === null) return out
      for (let v = 0; v < n; v++) {
        const s = at.get(key(m.positions, v))
        if (s !== undefined) out.set(blended.subarray(s * 3, s * 3 + 3), v * 4)
      }
      return out
    },
    look(meshes) {
      let w = 0, roughness = 0, metallic = 0
      for (const m of meshes) {
        const l = materialLook(doc, m.material), n = m.positions.length / 3
        if (!l || !n) continue
        w += n; roughness += l.roughness * n; metallic += l.metallic * n
      }
      return w ? { roughness: roughness / w, metallic: metallic / w } : { roughness: 0.5, metallic: 0 }
    },
  }
}
