import { getComponent, pose, rng, readColumn, setComponent, setPose } from 'ege'
import {
  EgeBodyProps, EgeBoxCollider, EgeRender, EgeTransform,
  Feature, FeatureMemoryTiles, FeatureMemoryTilesCell, FeatureMemoryTilesCycle, FeatureMemoryTilesMarker,
} from '../components.gen'

// packages/sim/src/features/memoryTiles.ts:26-28 and :59-60: geometry constants.
const CELL_INSET_M: f64 = 0.05
const CELL_HALF_Y_M: f64 = 0.2
const MARKER_LIFT_M: f64 = 0.3
const FAR_EDGE_GAP_M: f64 = 0.5
const MARKER_HALF_Y_M: f64 = 0.1
// packages/sim/src/features/memoryTiles.ts:249 draws candy.floor-tile; E4 fixes its base colour.
const CELL_COLOR: u32 = 0xF5D0E0

// The cell record splits its twenty cycle symbols into two generated fields (contract m6-memory-records).
function writeCycleSymbol(cell: FeatureMemoryTilesCell, cycle: u32, symbol: u32): void {
  if (cycle < 16) {
    switch (cycle) {
      case 0: cell.cycle_symbols_0 = symbol; break
      case 1: cell.cycle_symbols_1 = symbol; break
      case 2: cell.cycle_symbols_2 = symbol; break
      case 3: cell.cycle_symbols_3 = symbol; break
      case 4: cell.cycle_symbols_4 = symbol; break
      case 5: cell.cycle_symbols_5 = symbol; break
      case 6: cell.cycle_symbols_6 = symbol; break
      case 7: cell.cycle_symbols_7 = symbol; break
      case 8: cell.cycle_symbols_8 = symbol; break
      case 9: cell.cycle_symbols_9 = symbol; break
      case 10: cell.cycle_symbols_10 = symbol; break
      case 11: cell.cycle_symbols_11 = symbol; break
      case 12: cell.cycle_symbols_12 = symbol; break
      case 13: cell.cycle_symbols_13 = symbol; break
      case 14: cell.cycle_symbols_14 = symbol; break
      default: cell.cycle_symbols_15 = symbol
    }
  } else {
    switch (cycle - 16) {
      case 0: cell.cycle_symbols_tail_0 = symbol; break
      case 1: cell.cycle_symbols_tail_1 = symbol; break
      case 2: cell.cycle_symbols_tail_2 = symbol; break
      default: cell.cycle_symbols_tail_3 = symbol
    }
  }
}

export function rf_feature_memory_tiles_pre(): void {
  const features = readColumn<FeatureMemoryTiles>(FeatureMemoryTiles.ID, FeatureMemoryTiles.SIZE)
  const cells = readColumn<FeatureMemoryTilesCell>(FeatureMemoryTilesCell.ID, FeatureMemoryTilesCell.SIZE)
  const cycles = readColumn<FeatureMemoryTilesCycle>(FeatureMemoryTilesCycle.ID, FeatureMemoryTilesCycle.SIZE)
  const markers = readColumn<FeatureMemoryTilesMarker>(FeatureMemoryTilesMarker.ID, FeatureMemoryTilesMarker.SIZE)
  for (let f: u32 = 0; f < features.count; f++) {
    const feature = features.at(f)
    const root = getComponent<Feature>(features.entity(f), Feature.ID, Feature.SIZE)
    if (feature.placed != 0) continue
    const owner = root.index
    const cellM = feature.cell_m
    const halfX = cellM / 2.0 - CELL_INSET_M
    const halfY = CELL_HALF_Y_M
    const halfZ = cellM / 2.0 - CELL_INSET_M
    const markerHalfX = cellM * 0.5
    const count = feature.cols * feature.rows
    for (let j: u32 = 0; j < cells.count; j++) {
      const cell = cells.at(j)
      if (cell.owner != owner) continue
      const column = cell.index % feature.cols
      const row = cell.index / feature.cols
      const x = feature.origin_0 + <f64>column * cellM
      const y = feature.origin_1
      const z = feature.origin_2 + <f64>row * cellM
      cell.t_0 = x
      cell.t_1 = y
      cell.t_2 = z
      cell.half_0 = halfX
      cell.half_1 = halfY
      cell.half_2 = halfZ
      const entity = cells.entity(j)
      setPose(entity, pose(<f32>x, <f32>y, <f32>z))
      const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      transform.pos_0 = <f32>x
      transform.pos_1 = <f32>y
      transform.pos_2 = <f32>z
      setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
      const collider = getComponent<EgeBoxCollider>(entity, EgeBoxCollider.ID, EgeBoxCollider.SIZE)
      collider.half_extents_0 = <f32>halfX
      collider.half_extents_1 = <f32>halfY
      collider.half_extents_2 = <f32>halfZ
      setComponent(entity, EgeBoxCollider.ID, EgeBoxCollider.SIZE, collider)
      const props = getComponent<EgeBodyProps>(entity, EgeBodyProps.ID, EgeBodyProps.SIZE)
      props.colliders_enabled = 1
      setComponent(entity, EgeBodyProps.ID, EgeBodyProps.SIZE, props)
      const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
      render.params_0 = <f32>halfX
      render.params_1 = <f32>halfY
      render.params_2 = <f32>halfZ
      render.params_3 = 0
      render.color = CELL_COLOR
      render.visible = 1
      setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
    }
    // packages/sim/src/features/memoryTiles.ts:244-262: one marker per cell and the far-edge target.
    for (let j: u32 = 0; j < markers.count; j++) {
      const marker = markers.at(j)
      if (marker.owner != owner) continue
      let x: f64 = feature.origin_0
      let y: f64 = feature.origin_1 + MARKER_LIFT_M
      let z: f64 = feature.origin_2
      if (marker.index < count) {
        const column = marker.index % feature.cols
        const row = marker.index / feature.cols
        x = feature.origin_0 + <f64>column * cellM
        y = feature.origin_1 + halfY + MARKER_LIFT_M
        z = feature.origin_2 + <f64>row * cellM
      } else {
        x = feature.origin_0 + <f64>(feature.cols - 1) * cellM / 2.0
        z = feature.origin_2 + <f64>(feature.rows - 1) * cellM + cellM / 2.0 + FAR_EDGE_GAP_M
      }
      const entity = markers.entity(j)
      const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
      transform.pos_0 = <f32>x
      transform.pos_1 = <f32>y
      transform.pos_2 = <f32>z
      setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
      const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
      render.params_0 = <f32>markerHalfX
      render.params_1 = <f32>(MARKER_HALF_Y_M / 2.0)
      render.params_2 = 0
      render.params_3 = 0
      setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
    }
    // packages/sim/src/features/memoryTiles.ts:135-138: cycle-major, cell-major, then the cycle target.
    const salt = root.salt
    for (let c: u32 = 0; c < feature.cycles; c++) {
      for (let j: u32 = 0; j < cells.count; j++) {
        const cell = cells.at(j)
        if (cell.owner != owner) continue
        writeCycleSymbol(cell, c, rng(salt) % feature.symbols)
      }
      const target = rng(salt) % feature.symbols
      for (let k: u32 = 0; k < cycles.count; k++) {
        const cycle = cycles.at(k)
        if (cycle.owner != owner || cycle.index != c) continue
        cycle.target = target
        break
      }
    }
    feature.placed = 1
  }
  features.write()
  cells.write()
  cycles.write()
}
