import type { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { CharMode } from '../character/constants.ts'
import { inBox } from '../course.ts'
import type { Box } from '../course.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import type { Vec3 } from '../vec.ts'
import type { CourseFeature, FeatureCtx, FeatureDraw, FeatureFactory, FeatureSeats } from './feature.ts'
import { boxParam, ticksParam } from './params.ts'

const SCORE_TICKS = 60

interface CaptureZoneEntry {
  readonly center: Vec3
  owner(): number
}

const zonesByPhysics = new WeakMap<RapierWorldSim, CaptureZoneEntry[]>()

function register(physics: RapierWorldSim, entry: CaptureZoneEntry): void {
  let zones = zonesByPhysics.get(physics)
  if (zones === undefined) {
    zones = []
    zonesByPhysics.set(physics, zones)
  }
  const at = zones.indexOf(entry)
  if (at >= 0) zones.splice(at, 1)
  zones.push(entry)
}

function unregister(physics: RapierWorldSim, entry: CaptureZoneEntry): void {
  const zones = zonesByPhysics.get(physics)
  if (zones === undefined) return
  const at = zones.indexOf(entry)
  if (at >= 0) zones.splice(at, 1)
}

function dist2(a: Vec3, b: Vec3): number {
  const x = a.x - b.x
  const y = a.y - b.y
  const z = a.z - b.z
  return x * x + y * y + z * z
}

interface Tally {
  leader: number
  contested: boolean
}

function tally(seats: FeatureSeats, box: Box, scratch: Vec3): Tally {
  const counts = new Map<number, number>()
  for (let i = 0; i < seats.count; i++) {
    if (seats.status(i) !== PlayerStatus.alive) continue
    if (seats.mode(i) === CharMode.parked) continue
    if (!inBox(box, seats.pos(i, scratch))) continue
    const team = seats.team(i)
    counts.set(team, (counts.get(team) ?? 0) + 1)
  }
  let leader = -1
  let top = 0
  let leaders = 0
  for (const [team, count] of counts) {
    if (count > top) {
      top = count
      leader = team
      leaders = 1
    } else if (count === top) {
      leaders++
    }
  }
  const contested = top > 0 && leaders > 1
  return { leader: contested ? -1 : leader, contested }
}

export const captureZoneFeature: FeatureFactory = (spec, path) => {
  const box = boxParam(spec, path)
  const captureTicks = ticksParam(spec, path, 'captureS', 0.5, 60)
  const scratch: Vec3 = { x: 0, y: 0, z: 0 }
  let owner = -1
  let progressTeam = -1
  let progress = 0
  let ownedTicks = 0
  let physics: RapierWorldSim | undefined
  let seats: FeatureSeats | undefined
  const entry: CaptureZoneEntry = { center: box.center, owner: () => owner }
  const feature: CourseFeature = {
    id: spec.id,
    kind: 'captureZone',
    init(ctx: FeatureCtx) {
      if (physics !== undefined && physics !== ctx.physics) unregister(physics, entry)
      physics = ctx.physics
      seats = ctx.seats
      register(physics, entry)
    },
    preStep() {},
    postStep(ctx: FeatureCtx) {
      if (ctx.roundTick < 0) return
      const { leader } = tally(ctx.seats, box, scratch)
      if (leader >= 0 && leader !== owner) {
        if (progressTeam !== leader) {
          progressTeam = leader
          progress = 0
        }
        progress++
        if (progress >= captureTicks) {
          owner = leader
          progress = 0
          ownedTicks = 0
          ctx.sound('obj.capture', box.center, 1)
        }
      }
      if (owner >= 0) {
        ownedTicks++
        if (ownedTicks % SCORE_TICKS === 0) ctx.emit('teamScore', owner, 1, 0)
      }
    },
    snapshot(w: SnapWriter) {
      w.u8(owner & 0xff)
      w.u8(progressTeam & 0xff)
      w.u32(progress)
      w.u32(ownedTicks)
    },
    restore(r: SnapReader) {
      owner = (r.u8() << 24) >> 24
      progressTeam = (r.u8() << 24) >> 24
      progress = r.u32()
      ownedTicks = r.u32()
    },
    draw(out: FeatureDraw[]) {
      const contested = seats !== undefined && tally(seats, box, scratch).contested
      const tint: 0 | 1 | 2 | 3 = contested ? 1 : owner < 0 ? 0 : owner === 1 ? 3 : 2
      out.push({
        asset: 'candy.floor-disc',
        t: { x: box.center.x, y: box.center.y, z: box.center.z },
        r: { x: 0, y: 0, z: 0, w: 1 },
        s: { x: box.half.x * 2, y: box.half.y * 2, z: box.half.z * 2 },
        visible: true,
        tint,
      })
    },
    botTarget(seat: number, pos: Vec3, out: Vec3): boolean {
      const zones = physics === undefined ? undefined : zonesByPhysics.get(physics)
      if (zones === undefined || zones.length === 0) return false
      let team = -1
      if (seats !== undefined) {
        for (let i = 0; i < seats.count; i++) {
          if (seats.seat(i) === seat) {
            team = seats.team(i)
            break
          }
        }
      }
      let best: CaptureZoneEntry | undefined
      let bestD = Infinity
      for (let i = 0; i < zones.length; i++) {
        const zone = zones[i]
        if (team >= 0 && zone.owner() === team) continue
        const d = dist2(pos, zone.center)
        if (d < bestD) {
          bestD = d
          best = zone
        }
      }
      if (best === undefined) {
        for (let i = 0; i < zones.length; i++) {
          const zone = zones[i]
          const d = dist2(pos, zone.center)
          if (d < bestD) {
            bestD = d
            best = zone
          }
        }
      }
      if (best === undefined) return false
      out.x = best.center.x
      out.y = best.center.y
      out.z = best.center.z
      return true
    },
  }
  return feature
}
