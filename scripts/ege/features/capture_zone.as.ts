import { Column, getComponent, isNull, readColumn, readResource, setComponent, tick } from 'ege'
import {
  Character, EgeRender, EgeTransform, Feature, FeatureCaptureZone, FeatureCaptureZoneVisual, RoundRes, Seat,
  TeamScoreEvent,
} from '../components.gen'
import { MODE_PARKED } from '../character/constants.as'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { inBox } from '../lib/boxes.as'
import { ticksOf } from '../lib/units.as'
import { recordShowEvent } from '../lib/show_events.as'

// packages/sim/src/features/capture.ts:15: an owning team scores every 60 owned ticks.
const SCORE_TICKS: u32 = 60
// packages/sim/src/match/roundSystem.ts:11: PlayerStatus.alive is 1.
const STATUS_ALIVE: u32 = 1
// E4 tint table: base colour while unowned, team tints 2/3 and contested tint 1.
const BASE_COLOR: u32 = 0xF2E6D0
const CONTESTED_COLOR: u32 = 0xFF6B9E
const TEAM_ZERO_COLOR: u32 = 0x54BAFF
const TEAM_ONE_COLOR: u32 = 0xFFD140

class Tally {
  leader: i32 = -1
  contested: bool = false
}

// packages/sim/src/features/capture.ts:47-75: only alive, non-parked seats inside the box count;
// a tie at the top leaves the zone contested with no leader.
function tally(zone: FeatureCaptureZone, seats: Column<Seat>, characters: Column<Character>): Tally {
  const out = new Tally()
  const teams = new Array<i32>(8)
  const counts = new Array<u32>(8)
  let used: u32 = 0
  for (let i: u32 = 0; i < seats.count; i++) {
    const seat = seats.at(i)
    if (seat.status != STATUS_ALIVE) continue
    const entity = seats.entity(i)
    const chRow = characters.find(entity)
    if (chRow >= 0 && characters.at(<u32>chRow).mode == MODE_PARKED) continue
    const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
    if (isNull<EgeTransform>(transform)) continue
    if (!inBox(zone.center_0, zone.center_1, zone.center_2, zone.half_0, zone.half_1, zone.half_2,
      transform.pos_0, transform.pos_1, transform.pos_2)) continue
    const team = <i32>seat.team
    let at: i32 = -1
    for (let u: u32 = 0; u < used; u++) {
      if (teams[u] == team) {
        at = <i32>u
        break
      }
    }
    if (at < 0) {
      at = <i32>used
      teams[used] = team
      counts[used] = 0
      used++
    }
    counts[<u32>at]++
  }
  let top: u32 = 0
  let leaders: u32 = 0
  let leader: i32 = -1
  for (let u: u32 = 0; u < used; u++) {
    const count = counts[u]
    if (count > top) {
      top = count
      leader = teams[u]
      leaders = 1
    } else if (count == top) {
      leaders++
    }
  }
  out.contested = top > 0 && leaders > 1
  out.leader = out.contested ? -1 : leader
  return out
}

function tintOf(owner: i32, contested: bool): u32 {
  if (contested) return CONTESTED_COLOR
  if (owner < 0) return BASE_COLOR
  return owner == 1 ? TEAM_ONE_COLOR : TEAM_ZERO_COLOR
}

// no handoff: Emit capture zones supplies the feature_capture_zone and feature_capture_zone_visual
// records this system reads; its captureZone module has no callable entry point for the behaviour.
// no handoff: Emit carry items and their persistent records takes nothing from this card; the two
// ege-features-objective shares write separate files and only read these records.
export function rf_feature_capture_zone_post(): void {
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const zones = readColumn<FeatureCaptureZone>(FeatureCaptureZone.ID, FeatureCaptureZone.SIZE)
  const visuals = readColumn<FeatureCaptureZoneVisual>(FeatureCaptureZoneVisual.ID, FeatureCaptureZoneVisual.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const now = tick()
  // packages/sim/src/features/capture.ts:84: the source postStep returns before the round starts.
  const playing = now >= round.intro_ticks
  for (let f: u32 = 0; f < zones.count; f++) {
    const zone = zones.at(f)
    const entity = zones.entity(f)
    const index = getComponent<Feature>(entity, Feature.ID, Feature.SIZE).index
    const result = tally(zone, seats, characters)
    if (playing) {
      const leader = result.leader
      const captureTicks = <u32>ticksOf(zone.capture_s)
      if (leader >= 0 && leader != zone.owner) {
        // packages/sim/src/features/capture.ts:88-90: another leader restarts the progress.
        if (zone.progress_team != leader) {
          zone.progress_team = leader
          zone.progress = 0
        }
        zone.progress++
        if (zone.progress >= captureTicks) {
          zone.owner = leader
          zone.progress = 0
          zone.owned_ticks = 0
        }
      }
      if (zone.owner >= 0) {
        zone.owned_ticks++
        // packages/sim/src/features/capture.ts:98-100: one team_score every 60 owned ticks.
        if (zone.owned_ticks % SCORE_TICKS == 0) {
          recordShowEvent(TeamScoreEvent.ID, entity, <u32>zone.owner, 1, 0)
        }
      }
    }
    // packages/sim/src/features/capture.ts:104-108: contested wins the tint, then owner, then base.
    for (let v: u32 = 0; v < visuals.count; v++) {
      const visual = visuals.at(v)
      if (visual.owner != index) continue
      const visualEntity = visuals.entity(v)
      const render = getComponent<EgeRender>(visualEntity, EgeRender.ID, EgeRender.SIZE)
      if (isNull<EgeRender>(render)) continue
      render.color = tintOf(zone.owner, result.contested)
      setComponent<EgeRender>(visualEntity, EgeRender.ID, EgeRender.SIZE, render)
    }
  }
  zones.write()
}
