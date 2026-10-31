import { refuse } from '../refusal.ts'
import { v3 } from '../vec.ts'
import type { Vec3 } from '../vec.ts'
import type { FeatureFactory } from './feature.ts'
import { boolParam, intParam, numParam, ticksParam, vec3Param } from './params.ts'
import { TileCells, TileState } from './tiles.ts'
import type { TileCellSpec } from './tiles.ts'

// Axial directions in side-walk order. Direction 4 starts each ring.
const DIRECTIONS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]] as const

/** Axial ring walk converted to metre centres, with point-to-point along X. */
export function hexLayout(rings: number, flatM: number): Vec3[] {
  const centres = [v3(0, 0, 0)]
  for (let ring = 1; ring <= rings; ring++) {
    let q = -ring
    let r = ring
    for (const [dq, dr] of DIRECTIONS) {
      for (let step = 0; step < ring; step++) {
        centres.push(v3(Math.sqrt(3) / 2 * flatM * q, 0, flatM * (r + q / 2)))
        q += dq
        r += dr
      }
    }
  }
  return centres
}

export const hexFieldFeature: FeatureFactory = (spec, path) => {
  const origin = vec3Param(spec, path, 'origin')
  const layers = intParam(spec, path, 'layers', 1, 4)
  const layerSpacingM = numParam(spec, path, 'layerSpacingM', 0.05, 100)
  const rings = intParam(spec, path, 'rings', 1, 8)
  const cellsPerLayer = 3 * rings * (rings + 1) + 1
  if (layers * cellsPerLayer > 512) {
    refuse('feature', `${path}/rings`, 'expected at most 512 cells; reduce rings or layers')
  }
  const flatM = numParam(spec, path, 'flatM', 0.05, 100, 5.5)
  const pointM = numParam(spec, path, 'pointM', 0.05, 100, 6.4)
  const thickM = numParam(spec, path, 'thickM', 0.05, 100, 0.35)
  const warnTicks = ticksParam(spec, path, 'warnS', 0, 600)
  const decayTicks = ticksParam(spec, path, 'decayS', 0, 600)
  const scaleWithEntrants = boolParam(spec, path, 'scaleWithEntrants', false)
  const border = Math.min(0.1, thickM / 4)
  const half = v3(pointM / 2 - border, thickM / 2 - border, flatM / 2 - border)
  if (half.x <= 0) refuse('feature', `${path}/pointM`, 'expected pointM > twice the collider border in metres')
  if (half.z <= 0) refuse('feature', `${path}/flatM`, 'expected flatM > twice the collider border in metres')
  const layout = hexLayout(rings, flatM)
  const specs: TileCellSpec[] = []
  for (let layer = 0; layer < layers; layer++) {
    for (const centre of layout) {
      specs.push({
        t: v3(origin.x + centre.x, origin.y - layer * layerSpacingM, origin.z + centre.z),
        half,
        border,
      })
    }
  }
  const cells = new TileCells(specs)

  return {
    id: spec.id,
    kind: 'hexField',
    init(ctx) { cells.build(ctx) },
    preStep(_ctx) {},
    postStep(ctx) {
      const threshold = scaleWithEntrants
        ? Math.round(decayTicks * Math.max(0.25, Math.min(1, 12 / ctx.entrants)))
        : decayTicks
      cells.step(ctx, threshold, warnTicks, -1)
    },
    snapshot(w) { cells.snapshot(w) },
    restore(r, ctx) { cells.restore(r, ctx) },
    draw(out) {
      const start = out.length
      cells.draw(out, 'candy.floor-disc')
      // The existing disc has a 12 m diameter and 1 m collision thickness.
      for (let i = start; i < out.length; i++) out[i].s = v3(pointM / 12, thickM, flatM / 12)
    },
    botTarget(_seat, pos, out) {
      for (let layer = 0; layer < layers; layer++) {
        const top = origin.y - layer * layerSpacingM + thickM / 2
        if (top > pos.y + 0.5) continue
        let best = -1
        let bestDistance = Infinity
        const end = (layer + 1) * cellsPerLayer
        for (let cell = layer * cellsPerLayer; cell < end; cell++) {
          if (cells.state[cell] !== TileState.solid) continue
          const centre = cells.centre[cell]
          const distance = (centre.x - pos.x) ** 2 + (centre.z - pos.z) ** 2
          if (distance < bestDistance) {
            best = cell
            bestDistance = distance
          }
        }
        if (best < 0) continue
        out.x = cells.centre[best].x
        out.y = top
        out.z = cells.centre[best].z
        return true
      }
      return false
    },
  }
}
