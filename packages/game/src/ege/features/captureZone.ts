import type { FeatureSpec } from '@royal-fiesta/sim/course'
import { boxParam, numParam } from '@royal-fiesta/sim/features/params'
import type { FeatureEmitter } from '../featureEmitters.ts'
import { FEATURE_KIND_RANK, featureSalt, visualOf } from '../featureEmitters.ts'

// Source: packages/sim/src/features/capture.ts (captureZoneFeature). The zone has no body and an empty
// preStep: its postStep is run by scripts/ege/features/capture_zone.as.ts, which tallies the alive seats
// inside the box, advances progress, records the owner and scores every 60 owned ticks. This emitter
// copies the authored centre, half extents and capture seconds and starts owner and progress_team at -1
// with progress and owned_ticks at 0. The draw is candy.floor-disc at full size 2 * half; the initial
// tint is the base colour because no team owns the zone yet (E4 visual table). The visual child carries
// feature_capture_zone_visual {owner: course feature index, index: 0}; its owner is the feature index,
// not a team. Child name feature/<spec.id>/visual/0 follows the m7-capture-zone-records tree. These are
// entity names, not filesystem paths.
const ZONE_ASSET = 'candy.floor-disc'
const ORIGIN_ROT: [number, number, number, number] = [0, 0, 0, 1]

// no handoff: Emit carry items and their persistent records takes nothing from this card.
// no handoff: Run capture progress, ownership and scoring takes nothing callable from this card; it reads
// the feature_capture_zone and feature_capture_zone_visual records emitted here.
export const captureZoneEmitter: FeatureEmitter = (spec: FeatureSpec, ctx) => {
  const path = `${ctx.path}#/features/${ctx.index}`
  const box = boxParam(spec, path)
  const captureS = numParam(spec, path, 'captureS', 0.5, 60)
  const center: [number, number, number] = [box.center.x, box.center.y, box.center.z]
  const half: [number, number, number] = [box.half.x, box.half.y, box.half.z]
  const visual = visualOf(ZONE_ASSET, { x: half[0] * 2, y: half[1] * 2, z: half[2] * 2 })
  return {
    root: {
      name: `feature/${spec.id}`,
      components: {
        feature: { kind: FEATURE_KIND_RANK.captureZone, index: ctx.index, salt: featureSalt(ctx.index) },
        feature_capture_zone: {
          center, half, capture_s: captureS, owner: -1, progress_team: -1, progress: 0, owned_ticks: 0,
        },
        'ege.transform': { pos: center, rot: ORIGIN_ROT },
      },
    },
    children: [{
      name: `feature/${spec.id}/visual/0`,
      components: {
        feature_capture_zone_visual: { owner: ctx.index, index: 0 },
        'ege.transform': { pos: center, rot: ORIGIN_ROT },
        'ege.render': {
          shape: visual.shape,
          color: visual.color,
          visible: 1,
          params: visual.params,
        },
      },
    }],
  }
}
