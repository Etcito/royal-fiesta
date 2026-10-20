import assert from 'node:assert/strict'
import test from 'node:test'
import { Rng, fnv1a32 } from '@gamesaloon/rollback'
import type { CourseKind, ProfileName, ResolvedCourse } from '../src/course.ts'
import { coursePool, pickCourse, planRound, qualifyTarget, roundTicks } from '../src/match/rules.ts'
import { PROFILES, setupHash, validateSetup } from '../src/match/setup.ts'
import type { MatchSetup } from '../src/match/setup.ts'

function course(id: string, kind: CourseKind, profiles: ProfileName[], timeLimitS = 120, contentHash = 1): ResolvedCourse {
  return {
    id, name: id, kind, profiles, timeLimitS, killPlaneY: -12,
    spawns: [], checkpoints: [], finish: null, path: [], regions: [], queuePad: null,
    obstacles: [], contentHash,
  }
}

const COURSES: ResolvedCourse[] = [
  course('race-a', 'race', ['standard', 'sprint'], 120, 11),
  course('race-b', 'race', ['standard'], 90, 12),
  course('race-c', 'race', ['standard', 'sprint'], 60, 13),
  course('surv-a', 'survival', ['sprint'], 15, 21),
  course('surv-b', 'survival', ['standard', 'sprint'], 100, 22),
]

function setup(over: Partial<MatchSetup> = {}): MatchSetup {
  return { seed: 123, playerCount: 4, humans: [true, false, false, false], profile: 'sprint', courses: COURSES, ...over }
}

test('qualifyTarget', () => {
  const cases: [number, number][] = [[8, 5], [5, 3], [4, 2], [3, 1], [2, 1]]
  for (const [alive, target] of cases) assert.equal(qualifyTarget(alive), target, `alive ${alive}`)
})

test('planRound chains 8->5->3->1 and 4->2->1', () => {
  assert.deepEqual(planRound(0, 8), { index: 0, kind: 'race', final: false, target: 5 })
  assert.deepEqual(planRound(1, 5), { index: 1, kind: 'survival', final: false, target: 3 })
  assert.deepEqual(planRound(2, 3), { index: 2, kind: 'survival', final: true, target: 1 })
  assert.deepEqual(planRound(0, 4), { index: 0, kind: 'race', final: false, target: 2 })
  assert.deepEqual(planRound(1, 2), { index: 1, kind: 'survival', final: true, target: 1 })
})

test('roundTicks applies the profile cap', () => {
  assert.equal(roundTicks(course('r', 'race', ['sprint'], 120), PROFILES.sprint), 1200)
  assert.equal(roundTicks(course('r', 'race', ['sprint'], 15), PROFILES.sprint), 900)
  assert.equal(roundTicks(course('r', 'race', ['standard'], 120), PROFILES.standard), 7200)
  assert.equal(roundTicks(course('r', 'race', ['standard'], 0.5), PROFILES.standard), 30)
})

test('profiles hold the contract values', () => {
  assert.deepEqual(PROFILES.standard, { name: 'standard', introTicks: 180, roundEndTicks: 180, intermissionTicks: 300, podiumTicks: 600, timeCapS: null })
  assert.deepEqual(PROFILES.sprint, { name: 'sprint', introTicks: 60, roundEndTicks: 60, intermissionTicks: 60, podiumTicks: 120, timeCapS: 20 })
})

test('coursePool filters by kind and profile', () => {
  assert.deepEqual(coursePool(COURSES, 'race', 'sprint'), [0, 2])
  assert.deepEqual(coursePool(COURSES, 'race', 'standard'), [0, 1, 2])
  assert.deepEqual(coursePool(COURSES, 'survival', 'sprint'), [3, 4])
  assert.deepEqual(coursePool(COURSES, 'survival', 'standard'), [4])
})

test('pickCourse avoids lastCourse and is seeded', () => {
  const pool = [0, 1, 2]
  const rng = new Rng(7)
  let last = 1
  const seen = new Set<number>()
  for (let i = 0; i < 200; i++) {
    const pick = pickCourse(pool, last, rng)
    assert.notEqual(pick, last)
    assert.ok(pool.includes(pick))
    seen.add(pick)
    last = pick
  }
  assert.equal(seen.size, 3)
  assert.equal(pickCourse([4], 4, new Rng(1)), 4)
  const seq = (seed: number) => {
    const r = new Rng(seed)
    const out: number[] = []
    let prev = -1
    for (let i = 0; i < 20; i++) out.push(prev = pickCourse(pool, prev, r))
    return out
  }
  assert.deepEqual(seq(42), seq(42))
})

test('validateSetup accepts a valid setup', () => {
  validateSetup(setup())
  validateSetup(setup({ profile: 'standard', playerCount: 8, humans: new Array(8).fill(false), seed: 0xffffffff }))
})

test('validateSetup refusals', () => {
  const swapped = [COURSES[1], COURSES[0], ...COURSES.slice(2)]
  const dup = [COURSES[0], COURSES[0], ...COURSES.slice(1)]
  const cases: [Partial<MatchSetup>, string][] = [
    [{ seed: -1 }, '[match] setup.seed: -1 is not a u32; pass an integer in 0..4294967295'],
    [{ seed: 1.5 }, '[match] setup.seed: 1.5 is not a u32; pass an integer in 0..4294967295'],
    [{ seed: 0x100000000 }, '[match] setup.seed: 4294967296 is not a u32; pass an integer in 0..4294967295'],
    [{ playerCount: 0, humans: [] }, '[match] setup.playerCount: 0 is outside 1..8; pass a player count in that range'],
    [{ playerCount: 9, humans: new Array(9).fill(false) }, '[match] setup.playerCount: 9 is outside 1..8; pass a player count in that range'],
    [{ humans: [true] }, '[match] setup.humans: length 1 differs from playerCount 4; give one flag per player'],
    [{ courses: swapped }, "[match] setup.courses[1]: course 'race-a' comes after 'race-b'; sort courses by id"],
    [{ courses: dup }, "[match] setup.courses[1]: duplicate course id 'race-a'; pass each course once"],
    [{ courses: COURSES.slice(3) }, '[match] setup.courses: no race course for profile sprint; add a race course whose profiles include it'],
    [{ courses: COURSES.slice(0, 3) }, '[match] setup.courses: no survival course for profile sprint; add a survival course whose profiles include it'],
    [{ profile: 'standard', courses: COURSES.slice(0, 4) }, '[match] setup.courses: no survival course for profile standard; add a survival course whose profiles include it'],
  ]
  for (const [over, message] of cases) {
    assert.throws(() => validateSetup(setup(over)), { name: 'RefusalError', message })
  }
})

test('setupHash is stable and sensitive to seed and contentHash', () => {
  const h = setupHash(setup())
  assert.equal(setupHash(setup()), h)
  assert.ok(Number.isInteger(h) && h >= 0 && h <= 0xffffffff)
  assert.notEqual(setupHash(setup({ seed: 124 })), h)
  const changed = COURSES.map((c, i) => i === 2 ? { ...c, contentHash: 99 } : c)
  assert.notEqual(setupHash(setup({ courses: changed })), h)
  assert.notEqual(setupHash(setup({ profile: 'standard' })), h)
})

test('setupHash hashes the canonical JSON', () => {
  const s = setup({ seed: 5, playerCount: 2, humans: [true, false], courses: [COURSES[0], COURSES[3]] })
  const json = '{"courses":[["race-a",11],["surv-a",21]],"humans":[true,false],"playerCount":2,"profile":"sprint","seed":5}'
  assert.equal(setupHash(s), fnv1a32(new TextEncoder().encode(json)))
})
