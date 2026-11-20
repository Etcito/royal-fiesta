import {
  Column, emit, getComponent, newRecord, pose, rng, readColumn, readResource, setComponent, setPose, tick,
} from 'ege'
import {
  Character, EgeBodyProps, EgeBoxCollider, EgeRender, EgeTransform, Feature, FeatureMemoryTiles,
  FeatureMemoryTilesCell, FeatureMemoryTilesCycle, FeatureMemoryTilesMarker, FeatureMemoryTilesSeat,
  MatchEvent, RoundRes, Seat,
} from '../components.gen'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { ticksOf } from '../lib/units.as'
import { GRAVITY_Y } from '../character/constants.as'

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

function readCycleSymbol(cell: FeatureMemoryTilesCell, cycle: u32): u32 {
  if (cycle < 16) {
    switch (cycle) {
      case 0: return cell.cycle_symbols_0
      case 1: return cell.cycle_symbols_1
      case 2: return cell.cycle_symbols_2
      case 3: return cell.cycle_symbols_3
      case 4: return cell.cycle_symbols_4
      case 5: return cell.cycle_symbols_5
      case 6: return cell.cycle_symbols_6
      case 7: return cell.cycle_symbols_7
      case 8: return cell.cycle_symbols_8
      case 9: return cell.cycle_symbols_9
      case 10: return cell.cycle_symbols_10
      case 11: return cell.cycle_symbols_11
      case 12: return cell.cycle_symbols_12
      case 13: return cell.cycle_symbols_13
      case 14: return cell.cycle_symbols_14
      default: return cell.cycle_symbols_15
    }
  }
  switch (cycle - 16) {
    case 0: return cell.cycle_symbols_tail_0
    case 1: return cell.cycle_symbols_tail_1
    case 2: return cell.cycle_symbols_tail_2
    default: return cell.cycle_symbols_tail_3
  }
}

function markerColor(symbol: u32): u32 {
  switch (symbol % 4) {
    case 0: return 0xFF6B9E
    case 1: return 0x54BAFF
    case 2: return 0xFFD140
    default: return 0x73D966
  }
}

function emitMatch(entity: u32, seat: u32, result: i32, ticks: i32): void {
  const event = newRecord<MatchEvent>(MatchEvent.SIZE)
  event.seat = seat
  event.a = result
  event.b = ticks
  emit<MatchEvent>(MatchEvent.ID, entity, event, MatchEvent.SIZE)
}

// packages/sim/src/features/tiles.ts:17.
const FALL_TICKS: i32 = 30

function findSeatState(rows: Column<FeatureMemoryTilesSeat>, owner: u32, seatId: u32): i32 {
  for (let i: u32 = 0; i < rows.count; i++) {
    const row = rows.at(i)
    if (row.owner == owner && row.seat == seatId) return <i32>i
  }
  return -1
}

function findSeatRow(rows: Column<Seat>, seatId: u32): i32 {
  for (let i: u32 = 0; i < rows.count; i++) {
    if (rows.at(i).seat == seatId) return <i32>i
  }
  return -1
}

function restoreCells(cells: Column<FeatureMemoryTilesCell>, owner: u32): void {
  for (let i: u32 = 0; i < cells.count; i++) {
    const cell = cells.at(i)
    if (cell.owner != owner || (cell.state == 0 && cell.timer == 0)) continue
    cell.state = 0
    cell.timer = 0
    const entity = cells.entity(i)
    const props = getComponent<EgeBodyProps>(entity, EgeBodyProps.ID, EgeBodyProps.SIZE)
    props.colliders_enabled = 1
    setComponent(entity, EgeBodyProps.ID, EgeBodyProps.SIZE, props)
    setPose(entity, pose(<f32>cell.t_0, <f32>cell.t_1, <f32>cell.t_2))
    const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
    transform.pos_0 = <f32>cell.t_0
    transform.pos_1 = <f32>cell.t_1
    transform.pos_2 = <f32>cell.t_2
    setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
    const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
    render.color = CELL_COLOR
    render.visible = 1
    setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
  }
}

function stepFalling(cells: Column<FeatureMemoryTilesCell>, owner: u32): void {
  for (let i: u32 = 0; i < cells.count; i++) {
    const cell = cells.at(i)
    if (cell.owner != owner || cell.state != 2) continue
    const entity = cells.entity(i)
    const age = cell.timer + 1
    if (age >= <u32>FALL_TICKS) {
      cell.state = 3
      cell.timer = 0
      const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
      render.visible = 0
      setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
      continue
    }
    cell.timer = age
    const seconds = <f64>cell.timer / 60.0
    const y = cell.t_1 + 0.5 * GRAVITY_Y * seconds * seconds
    setPose(entity, pose(<f32>cell.t_0, <f32>y, <f32>cell.t_2))
    const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
    transform.pos_0 = <f32>cell.t_0
    transform.pos_1 = <f32>y
    transform.pos_2 = <f32>cell.t_2
    setComponent(entity, EgeTransform.ID, EgeTransform.SIZE, transform)
    const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
    render.color = CELL_COLOR
    render.visible = 1
    setComponent(entity, EgeRender.ID, EgeRender.SIZE, render)
  }
}

function startReveal(
  feature: FeatureMemoryTiles,
  owner: u32,
  cycle: u32,
  cells: Column<FeatureMemoryTilesCell>,
  cycleRows: Column<FeatureMemoryTilesCycle>,
  seatStates: Column<FeatureMemoryTilesSeat>,
): void {
  restoreCells(cells, owner)
  for (let i: u32 = 0; i < cycleRows.count; i++) {
    const row = cycleRows.at(i)
    if (row.owner == owner && row.index == cycle) feature.target = row.target
  }
  for (let i: u32 = 0; i < cells.count; i++) {
    const cell = cells.at(i)
    if (cell.owner == owner) cell.symbol = readCycleSymbol(cell, cycle)
  }
  for (let i: u32 = 0; i < seatStates.count; i++) {
    const row = seatStates.at(i)
    if (row.owner == owner) row.first_correct_tick = -1
  }
  feature.phase = 1
  feature.finalized = 0
}

function startChoice(feature: FeatureMemoryTiles, owner: u32, cells: Column<FeatureMemoryTilesCell>, now: i32): void {
  feature.choice_start_tick = now
  for (let i: u32 = 0; i < cells.count; i++) {
    const cell = cells.at(i)
    if (cell.owner != owner || cell.symbol == feature.target) continue
    cell.state = 2
    cell.timer = 0
    const entity = cells.entity(i)
    const props = getComponent<EgeBodyProps>(entity, EgeBodyProps.ID, EgeBodyProps.SIZE)
    props.colliders_enabled = 0
    setComponent(entity, EgeBodyProps.ID, EgeBodyProps.SIZE, props)
  }
}

function recordCrossings(
  owner: u32,
  feature: FeatureMemoryTiles,
  seats: Column<Seat>,
  characters: Column<Character>,
  cells: Column<FeatureMemoryTilesCell>,
  seatStates: Column<FeatureMemoryTilesSeat>,
  now: i32,
): void {
  for (let seatId: u32 = 0; seatId < 8; seatId++) {
    const seatRow = findSeatRow(seats, seatId)
    const stateRow = findSeatState(seatStates, owner, seatId)
    if (seatRow < 0 || stateRow < 0) continue
    const seat = seats.at(<u32>seatRow)
    const state = seatStates.at(<u32>stateRow)
    if (seat.status != 1 || state.first_correct_tick >= 0) continue
    const characterRow = characters.find(seats.entity(<u32>seatRow))
    if (characterRow < 0) continue
    const character = characters.at(<u32>characterRow)
    if (character.grounded == 0) continue
    const cellRow = cells.find(<u32>character.ground_entity)
    if (cellRow < 0) continue
    const cell = cells.at(<u32>cellRow)
    if (cell.owner == owner && cell.symbol == feature.target) state.first_correct_tick = now
  }
}

function finishChoice(
  feature: FeatureMemoryTiles,
  owner: u32,
  seats: Column<Seat>,
  seatStates: Column<FeatureMemoryTilesSeat>,
  penaltyTicks: i32,
): void {
  if (feature.finalized != 0) return
  for (let seatId: u32 = 0; seatId < 8; seatId++) {
    const seatRow = findSeatRow(seats, seatId)
    const stateRow = findSeatState(seatStates, owner, seatId)
    if (seatRow < 0 || stateRow < 0 || seats.at(<u32>seatRow).status != 1) continue
    const state = seatStates.at(<u32>stateRow)
    const entity = seats.entity(<u32>seatRow)
    if (state.first_correct_tick >= 0) {
      emitMatch(entity, seatId, 1, state.first_correct_tick - feature.choice_start_tick)
    } else {
      emitMatch(entity, seatId, 0, penaltyTicks)
    }
  }
  feature.finalized = 1
}

function updateMarkers(
  feature: FeatureMemoryTiles,
  owner: u32,
  cells: Column<FeatureMemoryTilesCell>,
  markers: Column<FeatureMemoryTilesMarker>,
): void {
  const count = feature.cols * feature.rows
  for (let i: u32 = 0; i < markers.count; i++) {
    const marker = markers.at(i)
    if (marker.owner != owner) continue
    const render = getComponent<EgeRender>(markers.entity(i), EgeRender.ID, EgeRender.SIZE)
    render.visible = 0
    if (feature.phase == 1 && marker.index < count) {
      for (let j: u32 = 0; j < cells.count; j++) {
        const cell = cells.at(j)
        if (cell.owner == owner && cell.index == marker.index) {
          render.color = markerColor(cell.symbol)
          render.visible = 1
          break
        }
      }
    } else if (feature.phase == 3 && marker.index == count) {
      render.color = markerColor(feature.target)
      render.visible = 1
    }
    setComponent(markers.entity(i), EgeRender.ID, EgeRender.SIZE, render)
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

export function rf_feature_memory_tiles_post(): void {
  const features = readColumn<FeatureMemoryTiles>(FeatureMemoryTiles.ID, FeatureMemoryTiles.SIZE)
  const cells = readColumn<FeatureMemoryTilesCell>(FeatureMemoryTilesCell.ID, FeatureMemoryTilesCell.SIZE)
  const cycleRows = readColumn<FeatureMemoryTilesCycle>(FeatureMemoryTilesCycle.ID, FeatureMemoryTilesCycle.SIZE)
  const seatStates = readColumn<FeatureMemoryTilesSeat>(FeatureMemoryTilesSeat.ID, FeatureMemoryTilesSeat.SIZE)
  const markers = readColumn<FeatureMemoryTilesMarker>(FeatureMemoryTilesMarker.ID, FeatureMemoryTilesMarker.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const now = <i32>tick()
  const roundTick = now - <i32>round.intro_ticks
  for (let i: u32 = 0; i < features.count; i++) {
    const feature = features.at(i)
    const owner = getComponent<Feature>(features.entity(i), Feature.ID, Feature.SIZE).index
    const revealTicks = <i32>Math.max(1.0, <f64>ticksOf(feature.reveal_s))
    const hideTicks = <i32>Math.max(1.0, <f64>ticksOf(feature.hide_s))
    const choiceTicks = <i32>Math.max(1.0, <f64>ticksOf(feature.choice_s))
    const penaltyTicks = <i32>Math.max(1.0, <f64>ticksOf(feature.penalty_s))
    const cycleTicks = revealTicks + hideTicks + choiceTicks
    if (roundTick >= 0) {
      const cycle = roundTick / cycleTicks
      if (cycle != feature.cycle) {
        if (feature.cycle >= 0 && <u32>feature.cycle < feature.cycles) {
          finishChoice(feature, owner, seats, seatStates, penaltyTicks)
        }
        feature.cycle = cycle
        if (<u32>cycle < feature.cycles) {
          startReveal(feature, owner, <u32>cycle, cells, cycleRows, seatStates)
        } else {
          feature.phase = 4
          restoreCells(cells, owner)
        }
      }
      if (<u32>feature.cycle >= feature.cycles) {
        feature.phase = 4
        restoreCells(cells, owner)
      } else {
        const offset = roundTick - feature.cycle * cycleTicks
        const nextPhase = offset < revealTicks ? 1 : offset < revealTicks + hideTicks ? 2 : 3
        if (feature.phase != <u32>nextPhase) {
          feature.phase = <u32>nextPhase
          if (nextPhase == 3) startChoice(feature, owner, cells, now)
        }
        if (feature.phase == 3) {
          recordCrossings(owner, feature, seats, characters, cells, seatStates, now)
          if (offset == cycleTicks - 1 && feature.finalized == 0) {
            finishChoice(feature, owner, seats, seatStates, penaltyTicks)
            if (<u32>feature.cycle == feature.cycles - 1) restoreCells(cells, owner)
          }
        }
      }
    }
    if (feature.phase == 4) restoreCells(cells, owner)
    stepFalling(cells, owner)
    updateMarkers(feature, owner, cells, markers)
  }
  features.write()
  cells.write()
  seatStates.write()
}
