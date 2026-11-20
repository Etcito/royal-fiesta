import { Column, emit, getComponent, isNull, newRecord, readColumn, readResource, setComponent, tick } from 'ege'
import {
  EgeRender, EgeTransform, Feature, FeatureCollectible, FeatureCollectibleSpot, RoundRes, ScoreEvent, Seat,
} from '../components.gen'
import { MODE_PARKED } from '../character/constants.as'
import { characterColumn, seatColumn } from '../lib/seats.as'
import { ticksOf } from '../lib/units.as'

// packages/sim/src/character/capsule.ts:50: the character capsule radius is 0.4 m.
const CAPSULE_RADIUS: f64 = 0.4
// packages/sim/src/features/collectibles.ts:12: pickup reaches CAPSULE.radius + 0.5 m.
const CONTACT_RADIUS: f64 = CAPSULE_RADIUS + 0.5
const CONTACT_RADIUS2: f64 = CONTACT_RADIUS * CONTACT_RADIUS
// packages/sim/src/match/roundSystem.ts:11: PlayerStatus.alive is 1.
const STATUS_ALIVE: u32 = 1

function setVisible(entity: u32, visible: u32): void {
  const render = getComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE)
  if (isNull<EgeRender>(render)) return
  if (render.visible == visible) return
  render.visible = visible
  setComponent<EgeRender>(entity, EgeRender.ID, EgeRender.SIZE, render)
}

function seatRow(seats: Column<Seat>, rank: u32): i32 {
  for (let i: u32 = 0; i < seats.count; i++) {
    if (seats.at(i).seat == rank) return <i32>i
  }
  return -1
}

// no handoff: Emit collectible spots supplies the feature_collectible and feature_collectible_spot
// records this system reads; its collectible module has no callable entry point for the behaviour.
export function rf_feature_collectible_pre(): void {
  // packages/sim/src/features/collectibles.ts:31-33: the source pre-step only records the tick.
  // The spot ready ticks start at 0 in the emitted records and post reads tick() directly.
}

export function rf_feature_collectible_post(): void {
  const round = readResource<RoundRes>(RoundRes.ID, RoundRes.SIZE)
  const features = readColumn<FeatureCollectible>(FeatureCollectible.ID, FeatureCollectible.SIZE)
  const spots = readColumn<FeatureCollectibleSpot>(FeatureCollectibleSpot.ID, FeatureCollectibleSpot.SIZE)
  const seats = seatColumn()
  const characters = characterColumn()
  const now = <i32>tick()
  // packages/sim/src/features/collectibles.ts:37: no pickup during the intro.
  const playing = now >= <i32>round.intro_ticks

  for (let f: u32 = 0; f < features.count; f++) {
    const feature = features.at(f)
    const owner = getComponent<Feature>(features.entity(f), Feature.ID, Feature.SIZE).index
    const regenTicks = ticksOf(feature.regen_s)
    for (let s: u32 = 0; s < spots.count; s++) {
      const spot = spots.at(s)
      if (spot.owner != owner) continue
      const spotEntity = spots.entity(s)
      if (playing && now >= spot.ready_tick) {
        let best: i32 = -1
        let bestD: f64 = CONTACT_RADIUS2
        // Ordered room seat, the tie rule of collectibles.ts:41-57: a lower seat keeps an equal distance.
        for (let rank: u32 = 0; rank < seats.count; rank++) {
          const row = seatRow(seats, rank)
          if (row < 0) continue
          const seat = seats.at(<u32>row)
          if (seat.status != STATUS_ALIVE) continue
          const entity = seats.entity(<u32>row)
          const chRow = characters.find(entity)
          if (chRow < 0) continue
          const ch = characters.at(<u32>chRow)
          if (ch.mode == MODE_PARKED) continue
          const transform = getComponent<EgeTransform>(entity, EgeTransform.ID, EgeTransform.SIZE)
          if (isNull<EgeTransform>(transform)) continue
          const dx = <f64>transform.pos_0 - spot.t_0
          const dy = <f64>transform.pos_1 - spot.t_1
          const dz = <f64>transform.pos_2 - spot.t_2
          const d = dx * dx + dy * dy + dz * dz
          if (d <= CONTACT_RADIUS2 && (best < 0 || d < bestD)) {
            best = row
            bestD = d
          }
        }
        if (best >= 0) {
          const seat = seats.at(<u32>best)
          const event = newRecord<ScoreEvent>(ScoreEvent.SIZE)
          event.seat = seat.seat
          event.a = <i32>feature.value
          event.b = 0
          emit<ScoreEvent>(ScoreEvent.ID, seats.entity(<u32>best), event, ScoreEvent.SIZE)
          spot.ready_tick = now + regenTicks
        }
      }
      // packages/sim/src/features/collectibles.ts:88: the spot is visible from its ready tick on.
      setVisible(spotEntity, now >= spot.ready_tick ? 1 : 0)
    }
  }
  spots.write()
}
