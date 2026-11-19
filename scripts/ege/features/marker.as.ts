import { getComponent, readColumn, setComponent, tick } from 'ege'
import { EgeRender, EgeTransform, FeatureMarker, Seat } from '../components.gen'

// The base floor-disc draw and size are in packages/sim/src/features/catalog.ts:89.
const MARKER_BASE_COLOR: u32 = 0xF2E6D0
// The active marker draw uses tint 4 in packages/sim/src/features/catalog.ts:91.
const MARKER_TOUCH_COLOR: u32 = 0x73D966

export function rf_feature_marker_post(): void {
  const seats = readColumn<Seat>(Seat.ID, Seat.SIZE)
  const features = readColumn<FeatureMarker>(FeatureMarker.ID, FeatureMarker.SIZE)
  const now = <i32>tick()
  for (let i: u32 = 0; i < features.count; i++) {
    const entity = features.entity(i)
    const marker = features.at(i)
    let touches: u32 = 0
    for (let j: u32 = 0; j < seats.count; j++) {
      const seatEntity = seats.entity(j)
      const transform = getComponent<EgeTransform>(seatEntity, EgeTransform.ID, EgeTransform.SIZE)
      const dx = <f64>transform.pos_0 - marker.t_0
      const dy = <f64>transform.pos_1 - marker.t_1
      const dz = <f64>transform.pos_2 - marker.t_2
      if (dx * dx + dy * dy + dz * dz <= marker.radius_m * marker.radius_m) touches++
    }
    marker.touches = touches
    if (touches > 0) marker.last_touch_tick = now
    const visualEntity = entity + 1
    const render = getComponent<EgeRender>(visualEntity, EgeRender.ID, EgeRender.SIZE)
    render.color = touches > 0 ? MARKER_TOUCH_COLOR : MARKER_BASE_COLOR
    setComponent(visualEntity, EgeRender.ID, EgeRender.SIZE, render)
  }
  features.write()
}
