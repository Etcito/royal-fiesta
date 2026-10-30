// The assets an SDF load meshes for a profile. Pure, so the server baker meshes exactly what a page loads.
import type { CourseV1 } from '@royal-fiesta/game/courseV1'
import type { ProfileName } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'

export const PODIUM_ID = 'podium'
export const CHARACTER_ID = 'penguin.body'

// The playlist for the profile, the hub and the podium, plus the character, sorted.
export function assetSet(courses: readonly CourseV1[], byId: ReadonlyMap<string, CourseV1>, profile: ProfileName): string[] {
  const ids = new Set<string>([CHARACTER_ID])
  for (const c of courses) {
    if ((c.kind === 'race' || c.kind === 'survival') && c.sim !== null && c.sim.profiles.includes(profile)) {
      for (const id of c.assetIds) ids.add(id)
    }
  }
  const hubs = courses.filter(c => c.kind === 'hub')
  if (hubs.length !== 1) {
    refuse('content', 'courses/*.course.json', `expected exactly one kind hub course, found ${hubs.length} (${hubs.map(c => c.id).join(', ') || 'none'}); keep one kind hub course`)
  }
  for (const id of hubs[0].assetIds) ids.add(id)
  const podium = byId.get(PODIUM_ID)
  if (podium === undefined || podium.kind !== 'podium') {
    refuse('content', `courses/${PODIUM_ID}.course.json`, `no kind podium course '${PODIUM_ID}'; add courses/${PODIUM_ID}.course.json`)
  }
  for (const id of podium.assetIds) ids.add(id)
  return [...ids].sort()
}
