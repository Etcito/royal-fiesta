import type { RapierWorldSim } from '@gamesaloon/rollback-rapier'
import { CarryKind } from '../character/constants.ts'
import { inBox } from '../course.ts'
import type { Box, FeatureSpec } from '../course.ts'
import { G, groups } from '../groups.ts'
import { PlayerStatus } from '../match/roundSystem.ts'
import { refuse } from '../refusal.ts'
import { quatIdentity, v3 } from '../vec.ts'
import type { Vec3 } from '../vec.ts'
import type { CourseFeature, FeatureCtx, FeatureSeats } from './feature.ts'
import { boxParam } from './params.ts'

type Counted = { handle: number; team: number }
interface Bank { box: Box; team: 0 | 1 | null; inside: Counted[] }
const banksByPhysics = new WeakMap<RapierWorldSim, Bank[]>()
const dist2 = (a: Vec3, b: Vec3): number =>
  (a.x - b.x) ** 2 + (a.y - b.y) ** 2 + (a.z - b.z) ** 2

export function bankFeature(spec: FeatureSpec, path: string): CourseFeature {
  const box = boxParam(spec, path)
  const team = spec.params.team
  if (team !== null && team !== 0 && team !== 1) {
    refuse('feature', `${path}/team`, 'expected team 0, 1 or null; write a team index or null')
  }
  const bank: Bank = { box, team, inside: [] }
  let seats: FeatureSeats
  let banks: Bank[] = []
  const pos = v3(0, 0, 0), facing = v3(0, 0, 0)
  const bind = (ctx: FeatureCtx): void => {
    seats = ctx.seats
    banks = banksByPhysics.get(ctx.physics) ?? []
    if (!banks.includes(bank)) banks.push(bank)
    banksByPhysics.set(ctx.physics, banks)
  }
  const own = (other: Bank, i: number): boolean => other.team === null || other.team === seats.team(i)
  const credit = (p: Vec3): number => {
    if (team !== null) return team
    let nearest = -1, distance = Infinity
    for (let i = 0; i < seats.count; i++) {
      if (seats.status(i) !== PlayerStatus.alive) continue
      const d = dist2(p, seats.pos(i, pos))
      if (d < distance || (d === distance && (nearest < 0 || seats.seat(i) < seats.seat(nearest)))) {
        nearest = i
        distance = d
      }
    }
    return nearest < 0 ? -1 : seats.team(nearest)
  }

  return {
    id: spec.id,
    kind: 'bank',
    init(ctx) { bind(ctx); bank.inside = [] },
    preStep() {},
    postStep(ctx) {
      seats = ctx.seats
      const hands: Vec3[] = []
      for (let i = 0; i < seats.count; i++) {
        if (seats.carry(i) !== CarryKind.object) continue
        seats.pos(i, pos)
        seats.facing(i, facing)
        hands.push(v3(pos.x + facing.x * 0.55, pos.y + 0.25, pos.z + facing.z * 0.55))
      }
      // Rapier handles are f64 bit patterns. Persist the world's stable i32 body IDs.
      const ids = new Map<number, number>()
      for (const id of ctx.physics.ids()) ids.set(ctx.physics.body(id).handle, id)
      const found = new Map<number, Vec3>()
      ctx.physics.world.intersectionsWithShape(box.center, quatIdentity(),
        new ctx.R.Cuboid(box.half.x, box.half.y, box.half.z), collider => {
          if (((collider.collisionGroups() >>> 16) & G.DEBRIS) === 0) return true
          const body = collider.parent()
          if (!body || !body.isDynamic()) return true
          const p = body.translation(), id = ids.get(body.handle)
          if (id !== undefined && inBox(box, p) && !hands.some(hand => dist2(hand, p) <= 0.2 ** 2)) {
            found.set(id, p)
          }
          return true
        }, undefined, groups(0xffff, G.DEBRIS))
      const previous = new Map(bank.inside.map(entry => [entry.handle, entry.team]))
      const next: Counted[] = []
      for (const handle of [...found.keys()].sort((a, b) => a - b)) {
        const credited = previous.get(handle) ?? credit(found.get(handle)!)
        next.push({ handle, team: credited })
        if (!previous.has(handle) && ctx.roundTick >= 0 && credited >= 0) {
          ctx.emit('teamScore', credited, 1, 0)
          ctx.sound('obj.bank', box.center, 1)
        }
      }
      for (const entry of bank.inside) {
        if (!found.has(entry.handle) && ctx.roundTick >= 0 && entry.team >= 0) {
          ctx.emit('teamScore', entry.team, -1, 0)
          ctx.sound('obj.steal', box.center, 1)
        }
      }
      bank.inside = next
    },
    snapshot(w) {
      w.u16(bank.inside.length)
      for (const entry of bank.inside) { w.i32(entry.handle); w.u8(entry.team & 0xff) }
    },
    restore(r, ctx) {
      bind(ctx)
      const count = r.u16()
      bank.inside = []
      for (let i = 0; i < count; i++) bank.inside.push({ handle: r.i32(), team: (r.u8() << 24) >> 24 })
    },
    draw(out) {
      out.push({ asset: 'candy.wall-block', t: { ...box.center }, r: quatIdentity(),
        s: v3(box.half.x * 2, box.half.y * 2, box.half.z * 2),
        visible: true, tint: team === null ? 0 : team === 0 ? 2 : 3 })
    },
    grabCandidates(position, _facing, out) {
      for (let i = 0; i < seats.count; i++) {
        if (seats.carry(i) !== CarryKind.object || dist2(position, seats.pos(i, pos)) >= 1e-12) continue
        if (!banks.some(other => own(other, i) && inBox(other.box, position))) out.push({ id: -1, dist: 0 })
      }
    },
    botTarget(seat, position, out) {
      let i = -1
      for (let j = 0; j < seats.count; j++) if (seats.seat(j) === seat) { i = j; break }
      if (i < 0) return false
      const carrying = seats.carry(i) === CarryKind.object
      if (!carrying && seat % 3 !== 0) return false
      let best: Bank | undefined, distance = Infinity
      for (const other of banks) {
        if (carrying ? !own(other, i) : own(other, i) || other.inside.length === 0) continue
        const d = dist2(position, other.box.center)
        if (d < distance) { best = other; distance = d }
      }
      if (!best) return false
      Object.assign(out, best.box.center)
      return true
    },
  }
}
