import { fnv1a32 } from '@gamesaloon/rollback'
import type { ProfileName, ResolvedCourse } from '../course.ts'
import { refuse } from '../refusal.ts'
import { MAX_PLAYERS } from '../world.ts'
import { coursePool } from './rules.ts'

export interface MatchProfile {
  name: ProfileName
  introTicks: number
  roundEndTicks: number
  intermissionTicks: number
  podiumTicks: number
  timeCapS: number | null
}

export const PROFILES: Readonly<Record<ProfileName, MatchProfile>> = Object.freeze({
  standard: Object.freeze({ name: 'standard', introTicks: 180, roundEndTicks: 180, intermissionTicks: 300, podiumTicks: 600, timeCapS: null }),
  sprint: Object.freeze({ name: 'sprint', introTicks: 60, roundEndTicks: 60, intermissionTicks: 60, podiumTicks: 120, timeCapS: 20 }),
})

export interface MatchSetup {
  seed: number
  playerCount: number
  humans: readonly boolean[]
  profile: ProfileName
  courses: readonly ResolvedCourse[]
}

export function validateSetup(s: MatchSetup): void {
  if (!Number.isInteger(s.seed) || s.seed < 0 || s.seed > 0xffffffff) {
    refuse('match', 'setup.seed', `${s.seed} is not a u32; pass an integer in 0..4294967295`)
  }
  if (!Number.isInteger(s.playerCount) || s.playerCount < 1 || s.playerCount > MAX_PLAYERS) {
    refuse('match', 'setup.playerCount', `${s.playerCount} is outside 1..${MAX_PLAYERS}; pass a player count in that range`)
  }
  if (s.humans.length !== s.playerCount) {
    refuse('match', 'setup.humans', `length ${s.humans.length} differs from playerCount ${s.playerCount}; give one flag per player`)
  }
  if (!Object.hasOwn(PROFILES, s.profile)) {
    refuse('match', 'setup.profile', `unknown profile '${s.profile}'; use standard or sprint`)
  }
  for (let i = 1; i < s.courses.length; i++) {
    const prev = s.courses[i - 1].id
    const id = s.courses[i].id
    if (id === prev) {
      refuse('match', `setup.courses[${i}]`, `duplicate course id '${id}'; pass each course once`)
    }
    if (id < prev) {
      refuse('match', `setup.courses[${i}]`, `course '${id}' comes after '${prev}'; sort courses by id`)
    }
  }
  if (coursePool(s.courses, 'race', s.profile).length === 0) {
    refuse('match', 'setup.courses', `no race course for profile ${s.profile}; add a race course whose profiles include it`)
  }
  if (coursePool(s.courses, 'survival', s.profile).length === 0) {
    refuse('match', 'setup.courses', `no survival course for profile ${s.profile}; add a survival course whose profiles include it`)
  }
}

// Hand-written canonical JSON (sorted keys, no spaces): sim cannot import game's canonicalJson.
function setupJson(s: MatchSetup): string {
  const humans: string[] = []
  for (let i = 0; i < s.humans.length; i++) humans.push(s.humans[i] ? 'true' : 'false')
  const courses: string[] = []
  for (let i = 0; i < s.courses.length; i++) {
    const c = s.courses[i]
    courses.push(`[${JSON.stringify(c.id)},${JSON.stringify(c.contentHash)}]`)
  }
  return `{"courses":[${courses.join(',')}],"humans":[${humans.join(',')}],"playerCount":${JSON.stringify(s.playerCount)},"profile":${JSON.stringify(s.profile)},"seed":${JSON.stringify(s.seed)}}`
}

export function setupHash(s: MatchSetup): number {
  return fnv1a32(new TextEncoder().encode(setupJson(s)))
}
