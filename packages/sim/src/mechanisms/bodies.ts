import type { BodyId } from '@gamesaloon/rollback-rapier'
import type { ColliderSpec } from '../course.ts'
import { PI } from '../detmath.ts'
import { G, groups } from '../groups.ts'
import type { BodySpec, MechItem } from '../mechanismSpec.ts'
import { colliderDesc } from '../obstacles/colliders.ts'
import { refuse } from '../refusal.ts'
import type { Pose } from '../vec.ts'
import type { WorldCtx } from '../world.ts'

const COLLIDE_WITH = G.CHAR | G.DEBRIS | G.PROBE | G.MOVING | G.STATIC

// Volume of the convex hull of flat corners (x, y, z, ...): every facet plane (a triple with all corners on one side,
// coplanar corners merged into one polygon) contributes area * distance to the centroid / 3. Only + - * / and sqrt,
// and the polygon is ordered by cross products (no atan2), so the number is the same on every engine.
export function hullVolume(points: readonly number[]): number {
  const n = Math.floor(points.length / 3)
  const P = (i: number): [number, number, number] => [points[3 * i], points[3 * i + 1], points[3 * i + 2]]
  const pts = Array.from({ length: n }, (_, i) => P(i))
  if (n < 4) return 0
  const c = [0, 0, 0]
  let scale = 0
  for (const p of pts) for (let k = 0; k < 3; k++) { c[k] += p[k] / n; scale = Math.max(scale, Math.abs(p[k])) }
  const eps = 1e-9 * Math.max(scale, 1e-6)
  const planes: { n: [number, number, number]; d: number }[] = []
  let volume = 0
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) for (let k = j + 1; k < n; k++) {
    const a = pts[i], b = pts[j], q = pts[k]
    const u = [b[0] - a[0], b[1] - a[1], b[2] - a[2]], v = [q[0] - a[0], q[1] - a[1], q[2] - a[2]]
    let nx = u[1] * v[2] - u[2] * v[1], ny = u[2] * v[0] - u[0] * v[2], nz = u[0] * v[1] - u[1] * v[0]
    const len = Math.sqrt(nx * nx + ny * ny + nz * nz)
    if (len <= eps * eps) continue
    nx /= len; ny /= len; nz /= len
    let d = nx * a[0] + ny * a[1] + nz * a[2]
    // outward: the centroid is behind the plane
    if (nx * c[0] + ny * c[1] + nz * c[2] > d) { nx = -nx; ny = -ny; nz = -nz; d = -d }
    if (pts.some((p) => nx * p[0] + ny * p[1] + nz * p[2] > d + eps)) continue
    if (planes.some((pl) => Math.abs(pl.n[0] - nx) + Math.abs(pl.n[1] - ny) + Math.abs(pl.n[2] - nz) <= 1e-7 && Math.abs(pl.d - d) <= eps)) continue
    planes.push({ n: [nx, ny, nz], d })
    // the facet polygon: its coplanar corners in a 2D basis (e1, e2) of the plane, ordered around their mean
    const face = pts.filter((p) => Math.abs(nx * p[0] + ny * p[1] + nz * p[2] - d) <= eps)
    const ul = Math.sqrt(u[0] * u[0] + u[1] * u[1] + u[2] * u[2])
    const e1 = [u[0] / ul, u[1] / ul, u[2] / ul]
    const e2 = [ny * e1[2] - nz * e1[1], nz * e1[0] - nx * e1[2], nx * e1[1] - ny * e1[0]]
    const flat = face.map((p) => [p[0] * e1[0] + p[1] * e1[1] + p[2] * e1[2], p[0] * e2[0] + p[1] * e2[1] + p[2] * e2[2]])
    // 2D convex hull of the facet's corners (monotone chain), so a corner inside the facet never counts
    flat.sort((p, q) => p[0] - q[0] || p[1] - q[1])
    const cross = (o: number[], a2: number[], b2: number[]): number => (a2[0] - o[0]) * (b2[1] - o[1]) - (a2[1] - o[1]) * (b2[0] - o[0])
    const ring: number[][] = []
    for (const pass of [flat, [...flat].reverse()]) {
      const start = ring.length
      for (const f of pass) {
        while (ring.length >= start + 2 && cross(ring[ring.length - 2], ring[ring.length - 1], f) <= 0) ring.pop()
        ring.push(f)
      }
      ring.pop()
    }
    let area = 0
    for (let s = 0; s < ring.length; s++) {
      const p = ring[s], q = ring[(s + 1) % ring.length]
      area += p[0] * q[1] - q[0] * p[1]
    }
    volume += (Math.abs(area) / 2) * (d - (nx * c[0] + ny * c[1] + nz * c[2])) / 3
  }
  return volume
}

// Volume in m3, so mass = density * sum of the body's collider volumes.
export function colliderVolume(c: ColliderSpec): number {
  switch (c.shape) {
    case 'cuboid':
      return 8 * c.half.x * c.half.y * c.half.z
    case 'roundCuboid': {
      // Minkowski sum of the inner box and a ball of radius `border`:
      // box + face slabs + quarter-cylinder edges + eighth-ball corners.
      const a = c.half.x, b = c.half.y, d = c.half.z, r = c.border
      return 8 * a * b * d + 8 * r * (a * b + b * d + d * a) + 2 * PI * r * r * (a + b + d) + (4 / 3) * PI * r * r * r
    }
    case 'ball':
      return (4 / 3) * PI * c.radius * c.radius * c.radius
    case 'capsule':
      return PI * c.radius * c.radius * (2 * c.halfHeight) + (4 / 3) * PI * c.radius * c.radius * c.radius
    case 'cylinder':
      return PI * c.radius * c.radius * (2 * c.halfHeight)
    case 'cone':
      return (PI * c.radius * c.radius * (2 * c.halfHeight)) / 3
    case 'convexHull':
      return hullVolume(c.points)
    default: {
      const bad: never = c
      return refuse('mechanisms', 'collider/shape', `unknown shape '${(bad as { shape: unknown }).shape}'; primitive colliders only`)
    }
  }
}

// One Rapier body for a mechanism body, posed at its loaded rest pose.
// The loader has already placed `rest` in course space and scaled the colliders.
// Applying the item pose again would move physics away from the rendered parts.
// `type` is fixed here and never changed later: a
// kinematic body is kinematicPositionBased for its whole life.
export function createBody(ctx: WorldCtx<unknown>, item: MechItem, b: BodySpec, _itemPose: Pose): BodyId {
  const where = `mechanisms/items/${item.id}/bodies/${b.id}`
  if (!(b.density > 0) || !Number.isFinite(b.density)) {
    refuse('mechanisms', where, `density ${b.density} is not a positive finite kg/m3; pass density > 0`)
  }
  const R = ctx.R
  let desc: InstanceType<typeof R.RigidBodyDesc>
  switch (b.type) {
    case 'dynamic':
      desc = R.RigidBodyDesc.dynamic()
      break
    case 'kinematic':
      desc = R.RigidBodyDesc.kinematicPositionBased()
      break
    case 'fixed':
      desc = R.RigidBodyDesc.fixed()
      break
    default: {
      const bad: never = b.type
      return refuse('mechanisms', where, `unknown body type '${bad as string}'; use dynamic, kinematic or fixed`)
    }
  }
  const p = b.rest
  desc.setTranslation(p.t.x, p.t.y, p.t.z)
  desc.setRotation({ x: p.r.x, y: p.r.y, z: p.r.z, w: p.r.w })
  desc.setLinearDamping(b.linearDamping)
  desc.setAngularDamping(b.angularDamping)
  desc.setGravityScale(b.gravityScale)
  desc.setCcdEnabled(b.ccd)
  const word = groups(b.type === 'fixed' ? G.STATIC : G.MOVING, COLLIDE_WITH)
  const cols = []
  for (let k = 0; k < b.colliders.length; k++) {
    // setDensity, never setMass: the mass follows the shapes (density * volume).
    cols.push(colliderDesc(R, b.colliders[k])
      .setDensity(b.density)
      .setFriction(b.friction)
      .setRestitution(b.restitution)
      .setCollisionGroups(word))
  }
  return ctx.physics.createBody(desc, cols)
}
