import { getComponent, pose, readColumn, readResource, setComponent, setPose } from 'ege'
import { EgeBodyProps, EgeRender, EgeTransform, Feature, FeatureHexField, FeatureHexFieldHex, RoundRes } from '../components.gen'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { V3, v3 } from '../lib/vec.as'
import { ticksOf } from '../lib/units.as'
import { GRAVITY_Y } from '../character/constants.as'

// FALL_TICKS is packages/sim/src/features/tiles.ts:17.
const FALL_TICKS: i32 = 30
// The base floor-disc draw and size are packages/sim/src/features/hexField.ts:76-78.
const HEX_BASE_COLOR: u32 = 0xF2E6D0
// Warning tint 1 is packages/sim/src/features/tiles.ts:212; E4 maps it to 0xFF6B9E.
const HEX_WARNING_COLOR: u32 = 0xFF6B9E

// The axial ring walk of packages/sim/src/features/hexField.ts:10-25.
// `cell` is the index inside one layer; out.x is q and out.y is r.
function hexOffset(cell: u32, out: V3): void {
  let remaining: i32 = <i32>cell
  let q: i32 = 0
  let r: i32 = 0
  for (let ring: i32 = 1; remaining > 0; ring++) {
    let qq: i32 = -ring
    let rr: i32 = ring
    for (let direction: i32 = 0; direction < 6 && remaining > 0; direction++) {
      let dq: i32 = 0
      let dr: i32 = 0
      switch (direction) {
        case 0: dq = 1; dr = 0; break
        case 1: dq = 1; dr = -1; break
        case 2: dq = 0; dr = -1; break
        case 3: dq = -1; dr = 0; break
        case 4: dq = -1; dr = 1; break
        default: dq = 0; dr = 1
      }
      for (let step: i32 = 0; step < ring; step++) {
        remaining--
        if (remaining == 0) {
          q = qq
          r = rr
          break
        }
        qq += dq
        rr += dr
      }
    }
  }
  out.x = <f64>q
  out.y = <f64>r
}

export function rf_feature_hex_field_pre(): void {
  const features = readColumn<FeatureHexField>(FeatureHexField.ID, FeatureHexField.SIZE)
  const hexes = readColumn<FeatureHexFieldHex>(FeatureHexFieldHex.ID, FeatureHexFieldHex.SIZE)
  const offset = v3(0, 0, 0)
  for (let i: u32 = 0; i < features.count; i++) {
    const rootEntity = features.entity(i)
    const owner = getComponent<Feature>(rootEntity, Feature.ID, Feature.SIZE).index
    const feature = features.at(i)
    if (feature.placed != 0) continue
    const cellsPerLayer = 3 * feature.rings * (feature.rings + 1) + 1
    for (let j: u32 = 0; j < hexes.count; j++) {
      const entity = hexes.entity(j)
      const hex = hexes.at(j)
      if (hex.owner != owner) continue
      const layer = hex.index / cellsPerLayer
      hexOffset(hex.index - layer * cellsPerLayer, offset)
      const x = feature.origin_0 + Math.sqrt(3.0) / 2.0 * feature.flat_m * offset.x
      const y = feature.origin_1 - <f64>layer * feature.layer_spacing_m
      const z = feature.origin_2 + feature.flat_m * (offset.y + offset.x / 2.0)
      hex.t_0 = x
      hex.t_1 = y
      hex.t_2 = z
      setPose(entity, pose(<f32>x, <f32>y, <f32>z))
      const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      transform.pos_0 = <f32>x
      transform.pos_1 = <f32>y
      transform.pos_2 = <f32>z
      setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
      const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
      render.color = HEX_BASE_COLOR
      render.visible = 1
      // Same radius as the emitter: flat_m / 2, the centre spacing, so discs touch (hexField.ts emitter).
      render.params_0 = <f32>(feature.flat_m / 2.0)
      render.params_1 = <f32>(feature.thick_m / 2.0)
      render.params_2 = 0
      render.params_3 = 0
      setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
    }
    feature.placed = 1
  }
  features.write()
  hexes.write()
}

export function rf_feature_hex_field_post(): void {
  const features = readColumn<FeatureHexField>(FeatureHexField.ID, FeatureHexField.SIZE)
  const hexes = readColumn<FeatureHexFieldHex>(FeatureHexFieldHex.ID, FeatureHexFieldHex.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const rate: u32 = round.phase == 2 ? 2 : 1
  for (let i: u32 = 0; i < features.count; i++) {
    const rootEntity = features.entity(i)
    const owner = getComponent<Feature>(rootEntity, Feature.ID, Feature.SIZE).index
    const feature = features.at(i)
    let decayTicks = <u32>Math.max(1.0, <f64>ticksOf(feature.decay_s))
    if (feature.scale_with_entrants != 0) {
      const entrants = <f64>round.entrants
      const scale = Math.max(0.25, Math.min(1.0, 12.0 / entrants))
      decayTicks = <u32>Math.round(<f64>decayTicks * scale)
    }
    const warnTicks = <u32>Math.max(1.0, <f64>ticksOf(feature.warn_s))
    for (let j: u32 = 0; j < hexes.count; j++) {
      const entity = hexes.entity(j)
      const hex = hexes.at(j)
      if (hex.owner != owner) continue
      let changed = false
      if (hex.state == 0) {
        let contact = false
        for (let k: u32 = 0; k < seats.count; k++) {
          if (seats.at(k).status != 1) continue
          const characterRow = characters.find(seats.entity(k))
          if (characterRow < 0) continue
          const ch = characters.at(<u32>characterRow)
          if (ch.grounded != 0 && ch.ground_entity == entity) contact = true
        }
        if (contact) {
          const next = hex.timer + rate
          if (next < decayTicks) hex.timer = next
          else {
            hex.state = 1
            hex.timer = warnTicks
            changed = true
          }
        }
      } else if (hex.state == 1) {
        if (hex.timer > 1) hex.timer--
        else {
          hex.state = 2
          hex.timer = 0
          changed = true
        }
      } else if (hex.state == 2) {
        const age = hex.timer + 1
        if (age < <u32>FALL_TICKS) hex.timer = age
        else {
          hex.state = 3
          hex.timer = 0
          changed = true
        }
      }
      if (!changed && hex.state != 2) continue
      const body = getComponent<EgeBodyProps>(entity, EgeBodyProps.ID, EgeBodyProps.SIZE)
      const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
      const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      if (hex.state == 0 || hex.state == 1) {
        if (body.colliders_enabled != 1) {
          body.colliders_enabled = 1
          setComponent(entity, EgeBodyProps.ID, EgeBodyProps.SIZE, body)
        }
        render.visible = 1
        render.color = hex.state == 1 ? HEX_WARNING_COLOR : HEX_BASE_COLOR
      } else if (hex.state == 2) {
        if (body.colliders_enabled != 0) {
          body.colliders_enabled = 0
          setComponent(entity, EgeBodyProps.ID, EgeBodyProps.SIZE, body)
        }
        const s = <f64>hex.timer / 60.0
        const y = hex.t_1 + 0.5 * GRAVITY_Y * s * s
        setPose(entity, pose(<f32>hex.t_0, <f32>y, <f32>hex.t_2))
        transform.pos_0 = <f32>hex.t_0
        transform.pos_1 = <f32>y
        transform.pos_2 = <f32>hex.t_2
        render.visible = 1
        render.color = HEX_BASE_COLOR
      } else {
        if (body.colliders_enabled != 0) {
          body.colliders_enabled = 0
          setComponent(entity, EgeBodyProps.ID, EgeBodyProps.SIZE, body)
        }
        render.visible = 0
      }
      setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
      setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
    }
  }
  features.write()
  hexes.write()
}
