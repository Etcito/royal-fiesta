import { getComponent, readColumn, readResource, setComponent, setPose, pose } from 'ege'
import { EgeBodyProps, EgeRender, EgeTransform, Feature, FeatureTileField, FeatureTileFieldTile, RoundRes } from '../components.gen'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { ticksOf } from '../lib/units.as'
import { GRAVITY_Y } from '../character/constants.as'

// FALL_TICKS is packages/sim/src/features/tiles.ts:17.
const FALL_TICKS: i32 = 30
const TILE_BASE_COLOR: u32 = 0xF5D0E0
const TILE_WARNING_COLOR: u32 = 0xFF6B9E

export function rf_feature_tile_field_post(): void {
  const features = readColumn<FeatureTileField>(FeatureTileField.ID, FeatureTileField.SIZE)
  const tiles = readColumn<FeatureTileFieldTile>(FeatureTileFieldTile.ID, FeatureTileFieldTile.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const rate: u32 = round.phase == 2 ? 2 : 1
  for (let i: u32 = 0; i < features.count; i++) {
    const rootEntity = features.entity(i)
    const owner = getComponent<Feature>(rootEntity, Feature.ID, Feature.SIZE).index
    const feature = features.at(i)
    const decayTicks = <u32>Math.max(1, ticksOf(feature.decay_s))
    const warnTicks = <u32>Math.max(1, ticksOf(feature.warn_s))
    const resetTicks = feature.mode == 0 ? <u32>Math.max(1, ticksOf(feature.reset_s)) : 0xFFFFFFFF
    for (let j: u32 = 0; j < tiles.count; j++) {
      const tileEntity = tiles.entity(j)
      const tile = tiles.at(j)
      if (tile.owner != owner) continue
      let changed = false
      if (tile.state == 0) {
        let contact = false
        for (let k: u32 = 0; k < seats.count; k++) {
          const seat = seats.at(k)
          if (seat.status != 1) continue
          const characterRow = characters.find(seats.entity(k))
          if (characterRow < 0) continue
          const ch = characters.at(<u32>characterRow)
          if (ch.grounded != 0 && ch.ground_entity == tileEntity) contact = true
        }
        if (contact) {
          const next = tile.timer + rate
          if (next < decayTicks) tile.timer = next
          else {
            tile.state = 1
            tile.timer = warnTicks
            changed = true
          }
        }
      } else if (tile.state == 1) {
        if (tile.timer > 1) tile.timer--
        else {
          tile.state = 2
          tile.timer = 0
          changed = true
        }
      } else if (tile.state == 2) {
        const age = tile.timer + 1
        if (age < <u32>FALL_TICKS) tile.timer = age
        else {
          tile.state = 3
          tile.timer = 0
          changed = true
        }
      } else if (tile.state == 3 && resetTicks != 0xFFFFFFFF) {
        const age = tile.timer + 1
        if (age < resetTicks) tile.timer = age
        else {
          tile.state = 0
          tile.timer = 0
          changed = true
        }
      }
      if (!changed && tile.state != 2) continue
      const body = getComponent<EgeBodyProps>(tileEntity, EgeBodyProps.ID, EgeBodyProps.SIZE)
      const render = getComponent<EgeRender>(tileEntity, EgeRender.ID, EgeRender.SIZE)
      const transform = getComponent<EgeTransform>(tileEntity, EgeTransform.ID, EgeTransform.SIZE)
      if (tile.state == 0 || tile.state == 1) {
        if (tile.state == 0 && body.colliders_enabled != 1) {
          body.colliders_enabled = 1
          setComponent(tileEntity, EgeBodyProps.ID, EgeBodyProps.SIZE, body)
        }
        setPose(tileEntity, pose(<f32>tile.t_0, <f32>tile.t_1, <f32>tile.t_2))
        transform.pos_0 = <f32>tile.t_0
        transform.pos_1 = <f32>tile.t_1
        transform.pos_2 = <f32>tile.t_2
        render.visible = 1
        render.color = tile.state == 1 ? TILE_WARNING_COLOR : TILE_BASE_COLOR
      } else if (tile.state == 2) {
        if (body.colliders_enabled != 0) {
          body.colliders_enabled = 0
          setComponent(tileEntity, EgeBodyProps.ID, EgeBodyProps.SIZE, body)
        }
        const s = <f64>tile.timer / 60.0
        const y = tile.t_1 + 0.5 * GRAVITY_Y * s * s
        setPose(tileEntity, pose(<f32>tile.t_0, <f32>y, <f32>tile.t_2))
        transform.pos_0 = <f32>tile.t_0
        transform.pos_1 = <f32>y
        transform.pos_2 = <f32>tile.t_2
        render.visible = 1
        render.color = TILE_BASE_COLOR
      } else {
        if (body.colliders_enabled != 0) {
          body.colliders_enabled = 0
          setComponent(tileEntity, EgeBodyProps.ID, EgeBodyProps.SIZE, body)
        }
        render.visible = 0
      }
      setComponent(tileEntity, EgeRender.ID, EgeRender.SIZE, render)
      setComponent(tileEntity, EgeTransform.ID, EgeTransform.SIZE, transform)
    }
  }
  features.write()
  tiles.write()
}
