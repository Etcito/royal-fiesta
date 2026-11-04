// One material per object (owner 2026-11-04). The option (singleMaterialOf: the 'per-face-materials' / 'single-material'
// group tags), the material look and the part look are MAMA's core/game/single-material.ts, the one copy SDF Modeler's
// Game view uses too; a shaded part carries them in its shading record (MAMA meshedPartShading). This file keeps only the
// vertex-colour fallback of a part without per-pixel shading: the shapes' own material colours blended by MAMA's
// smooth-min material weight (la/lb/t) on a white standard material with the part's one roughness and metallic.
import type { SdfDocument } from '@etcito/mama/core/doc/types.ts'
import type { Mesh } from '@etcito/mama/core/mesh/types.ts'
import type { SdfProgram } from '@etcito/mama/core/sdf/program.ts'
import { materialLook, objectLook } from '@etcito/mama/core/game/single-material.ts'

export { singleMaterialOf } from '@etcito/mama/core/game/single-material.ts'

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
    look(meshes) { return objectLook(doc, meshes) },
  }
}
