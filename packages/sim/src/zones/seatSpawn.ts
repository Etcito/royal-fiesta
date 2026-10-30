// The start point of a zone seat. A zone room can hold more seats than the course has spawns (8 on the sprint
// courses, 14 seats in the two-Chrome gate): seat s used spawn s % n, so seats n.. started inside seats 0.., their
// capsules stacked and pushed each other off the race line. Seat s now starts on spawn s % n, moved back
// floor(s / n) rows along the spawn's facing; seats below n keep their course spawn exactly.
import type { ResolvedCourse, SpawnPoint } from '../course.ts'
import { refuse } from '../refusal.ts'

/** Metres between start rows; the course spawns are 1 m apart within a row. */
export const SPAWN_ROW_SPACING = 1

/** Start point of spawn index `index` (a seat id by default, or an explicit course spawn index below n). */
export function seatSpawn(course: ResolvedCourse, index: number, out?: SpawnPoint): SpawnPoint {
  const n = course.spawns.length
  if (n < 1 || !Number.isInteger(index) || index < 0) {
    refuse('fiestaDomain', `spawns/${index}`, 'missing spawn; provide a course spawn for every seat')
  }
  const base = course.spawns[index % n]
  const back = Math.floor(index / n) * SPAWN_ROW_SPACING
  const point = out ?? { t: { x: 0, y: 0, z: 0 }, facing: { x: 0, z: 0 } }
  point.t.x = base.t.x - base.facing.x * back
  point.t.y = base.t.y
  point.t.z = base.t.z - base.facing.z * back
  point.facing.x = base.facing.x
  point.facing.z = base.facing.z
  return point
}
