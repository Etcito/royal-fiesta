import type { ProfileName, ResolvedCourse } from '@royal-fiesta/sim/course'
import { refuse } from '@royal-fiesta/sim/refusal'
import type { AssetResolver } from './assets.ts'
import { loadCourse } from './course.ts'

export interface CourseEntry { path: string; json: unknown }

const MATCH_KINDS = ['race', 'survival'] as const

export async function resolveCourses(entries: readonly CourseEntry[], assets: AssetResolver, profile?: ProfileName): Promise<ResolvedCourse[]> {
  const loaded: ResolvedCourse[] = []
  const seen = new Set<string>()
  for (let i = 0; i < entries.length; i++) {
    const course = await loadCourse(entries[i].json, entries[i].path, assets)
    if (seen.has(course.id)) refuse('course', entries[i].path, `duplicate course id '${course.id}'; give each course a unique id`)
    seen.add(course.id)
    loaded.push(course)
  }
  const kept = profile === undefined ? loaded : loaded.filter(c => c.profiles.includes(profile))
  // Course order is part of the match setup hash: code-unit order by id.
  return kept.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

export async function matchCourses(entries: readonly CourseEntry[], assets: AssetResolver, profile: ProfileName): Promise<ResolvedCourse[]> {
  const courses = (await resolveCourses(entries, assets, profile)).filter(c => c.kind === 'race' || c.kind === 'survival')
  for (const kind of MATCH_KINDS) {
    if (!courses.some(c => c.kind === kind)) {
      refuse('course', 'courses', `no ${kind} course for profile '${profile}'; add a ${kind} course whose profiles include '${profile}'`)
    }
  }
  return courses
}
