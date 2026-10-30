import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { CameraPose, Vec3T, Viewport } from '../render/port.ts'

export const DPR_CAP = 2

export interface SplitCell { x: number; y: number; width: number; height: number; seat: number }

const DEG = Math.PI / 180

export function splitLayout(seats: number, overview: boolean): SplitCell[] {
  if (!Number.isInteger(seats) || seats < 1 || seats > 4) {
    refuse('client', 'splitLayout', `${seats} seats is outside 1..4; split screen shows 1 to 4 seats`)
  }
  if (seats === 1) return [{ x: 0, y: 0, width: 1, height: 1, seat: 0 }]
  if (seats === 2) {
    return [
      { x: 0, y: 0, width: 0.5, height: 1, seat: 0 },
      { x: 0.5, y: 0, width: 0.5, height: 1, seat: 1 },
    ]
  }
  const cells: SplitCell[] = [
    { x: 0, y: 0, width: 0.5, height: 0.5, seat: 0 },
    { x: 0.5, y: 0, width: 0.5, height: 0.5, seat: 1 },
    { x: 0, y: 0.5, width: 0.5, height: 0.5, seat: 2 },
  ]
  if (seats === 3 && !overview) return cells
  cells.push({ x: 0.5, y: 0.5, width: 0.5, height: 0.5, seat: seats === 3 ? -1 : 3 })
  return cells
}

function positive(name: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    refuse('client', `pixelViewports.${name}`, `${value} is not a finite positive number; pass the CSS size and device pixel ratio`)
  }
}

export function pixelViewports(cells: readonly SplitCell[], cssWidth: number, cssHeight: number, dpr: number): Viewport[] {
  positive('cssWidth', cssWidth)
  positive('cssHeight', cssHeight)
  positive('dpr', dpr)
  const W = Math.round(cssWidth * Math.min(dpr, DPR_CAP))
  const H = Math.round(cssHeight * Math.min(dpr, DPR_CAP))
  const out: Viewport[] = []
  for (const c of cells) {
    const x0 = Math.round(c.x * W)
    const x1 = Math.round((c.x + c.width) * W)
    const y0 = Math.round(c.y * H)
    const y1 = Math.round((c.y + c.height) * H)
    out.push({ x: x0, y: y0, width: x1 - x0, height: y1 - y0 })
  }
  return out
}

export function overviewCamera(course: ResolvedCourse): CameraPose {
  const points: [number, number, number][] = []
  for (const o of course.obstacles) points.push([o.t.x, o.t.y, o.t.z])
  for (const s of course.spawns) points.push([s.t.x, s.t.y, s.t.z])
  for (const c of course.checkpoints) points.push([c.box.center.x, c.box.center.y, c.box.center.z])
  if (course.finish !== null) points.push([course.finish.center.x, course.finish.center.y, course.finish.center.z])

  let cx = 0
  let cy = 0
  let cz = 0
  let radius = 5
  if (points.length > 0) {
    let minX = Infinity
    let minY = Infinity
    let minZ = Infinity
    let maxX = -Infinity
    let maxY = -Infinity
    let maxZ = -Infinity
    for (const p of points) {
      if (p[0] < minX) minX = p[0]
      if (p[0] > maxX) maxX = p[0]
      if (p[1] < minY) minY = p[1]
      if (p[1] > maxY) maxY = p[1]
      if (p[2] < minZ) minZ = p[2]
      if (p[2] > maxZ) maxZ = p[2]
    }
    cx = (minX + maxX) / 2
    cy = (minY + maxY) / 2
    cz = (minZ + maxZ) / 2
    radius = Math.max(Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2, 5)
  }
  const target: Vec3T = [cx, cy, cz]
  const d = radius / Math.sin(25 * DEG) * 1.1
  const eye: Vec3T = [cx, cy + d * Math.sin(50 * DEG), cz - d * Math.cos(50 * DEG)]
  return { eye, target, fovYDeg: 50, near: 0.1, far: d + 2 * radius }
}
