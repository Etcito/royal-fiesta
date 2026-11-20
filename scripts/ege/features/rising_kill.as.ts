import { getComponent, readColumn, readResource, setComponent, tick } from 'ege'
import { EgeRender, EgeTransform, Feature, FeatureRisingKill, FeatureRisingKillVisual, RoundRes } from '../components.gen'
import { characterColumn, seatColumn } from '../lib/seats.as'

const WARN_S: f64 = 3.0
const PLANE_COLOR: u32 = 0xFF6B9E
const CLOCK_COLOR: u32 = 0xF2E6D0

function update(feature: FeatureRisingKill, now: f64): void {
  const total = (feature.end_y - feature.start_y) / feature.rise_mps
  const rise = Math.max(0.0, now / 60.0 - feature.start_s) + <f64>feature.overtime_ticks / 60.0
  if (rise >= total) {
    feature.kill_y = feature.end_y
    feature.left_s = 0
    feature.fraction = 0
    feature.rising = 0
    return
  }
  if (now / 60.0 < feature.start_s && feature.overtime_ticks == 0) {
    feature.kill_y = feature.start_y
    feature.left_s = feature.start_s - now / 60.0
    feature.fraction = 1
    feature.rising = 0
    return
  }
  const y = feature.start_y + feature.rise_mps * rise
  const previous = Math.max(feature.start_y, Math.floor(y + 1e-9))
  let next = Math.floor(y + 1e-9) + 1.0
  if (next > feature.end_y) next = feature.end_y
  const span = next - previous
  feature.kill_y = y
  feature.left_s = (next - y) / feature.rise_mps
  feature.fraction = span > 1e-12 ? Math.max(0.0, Math.min(1.0, (next - y) / span)) : 0
  feature.rising = 1
}

function placeVisual(entity: u32, x: f64, y: f64, z: f64): void {
  const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
  transform.pos_0 = <f32>x
  transform.pos_1 = <f32>y
  transform.pos_2 = <f32>z
  setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
}

function visuals(feature: FeatureRisingKill, owner: u32): void {
  const rows = readColumn<FeatureRisingKillVisual>(FeatureRisingKillVisual.ID, FeatureRisingKillVisual.SIZE)
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.owner != owner) continue
    const entity = rows.entity(i)
    const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
    if (row.index == 0) {
      placeVisual(entity, feature.clock_0, feature.kill_y, feature.clock_2)
      render.params_0 = <f32>(feature.half_m / 2.0)
      render.params_1 = 0.5
      render.params_2 = <f32>(feature.half_m / 2.0)
      render.color = PLANE_COLOR
    } else {
      placeVisual(entity, feature.clock_0, feature.clock_1, feature.clock_2)
      render.params_0 = <f32>feature.fraction
      render.params_1 = 0.05
      render.params_2 = <f32>feature.fraction
      render.color = feature.left_s > 0 && feature.left_s <= WARN_S ? PLANE_COLOR : CLOCK_COLOR
    }
    render.visible = 1
    setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
  }
}

export function rf_feature_rising_kill_pre(): void {
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const features = readColumn<FeatureRisingKill>(FeatureRisingKill.ID, FeatureRisingKill.SIZE)
  const now = <f64><i32>tick() - <i32>round.intro_ticks + 1.0
  for (let i: u32 = 0; i < features.count; i++) {
    const feature = features.at(i)
    const owner = getComponent<Feature>(features.entity(i), Feature.ID, Feature.SIZE).index
    update(feature, now)
    visuals(feature, owner)
    feature.placed = 1
  }
  features.write()
}

export function rf_feature_rising_kill_post(): void {
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const features = readColumn<FeatureRisingKill>(FeatureRisingKill.ID, FeatureRisingKill.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const now = <f64><i32>tick() - <i32>round.intro_ticks + 1.0
  for (let i: u32 = 0; i < features.count; i++) {
    const feature = features.at(i)
    if (round.phase == 2 && feature.overtime_ticks < 0xffffffff) feature.overtime_ticks++
    update(feature, now)
    const owner = getComponent<Feature>(features.entity(i), Feature.ID, Feature.SIZE).index
    visuals(feature, owner)
    for (let j: u32 = 0; j < seats.count; j++) {
      const seat = seats.at(j)
      if (seat.status != 1) continue
      const entity = seats.entity(j)
      const row = characters.find(entity)
      if (row < 0) continue
      const character = characters.at(<u32>row)
      if (<i32>tick() < seat.protect_until || <i32>tick() < character.protected_until) continue
      const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      if (transform.pos_1 < feature.kill_y) seat.kill_request = 1
    }
  }
  features.write()
  seats.write()
}
