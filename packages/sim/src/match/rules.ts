import type { Rng } from '@gamesaloon/rollback'
import type { ProfileName, ResolvedCourse } from '../course.ts'
import type { MatchProfile } from './setup.ts'

export interface RoundPlan { index: number; kind: 'race' | 'survival'; final: boolean; target: number }

export function qualifyTarget(alive: number): number {
  if (alive <= 3) return 1
  return Math.min(Math.max(Math.floor(alive * 2 / 3), 2), alive - 1)
}

export function planRound(index: number, alive: number): RoundPlan {
  if (alive <= 3) return { index, kind: 'survival', final: true, target: 1 }
  return { index, kind: index % 2 === 0 ? 'race' : 'survival', final: false, target: qualifyTarget(alive) }
}

export function roundTicks(course: ResolvedCourse, profile: MatchProfile): number {
  const cap = profile.timeCapS ?? Infinity
  return Math.round(Math.min(course.timeLimitS, cap) * 60)
}

export function coursePool(courses: readonly ResolvedCourse[], kind: 'race' | 'survival', profile: ProfileName): number[] {
  const pool: number[] = []
  for (let i = 0; i < courses.length; i++) {
    const c = courses[i]
    if (c.kind === kind && c.profiles.includes(profile)) pool.push(i)
  }
  return pool
}

// The pool must not be empty: validateSetup guarantees one race and one survival course.
export function pickCourse(pool: readonly number[], lastCourse: number, rng: Rng): number {
  const candidates: number[] = []
  for (let i = 0; i < pool.length; i++) {
    if (pool.length <= 1 || pool[i] !== lastCourse) candidates.push(pool[i])
  }
  return candidates[rng.int(0, candidates.length - 1)]
}
