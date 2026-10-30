import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { PlayerInput } from '@royal-fiesta/sim/input'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { fixtureResolver } from '../src/assets.ts'
import { LocalMatch } from '../src/client/localMatch.ts'
import { matchCourses } from '../src/courseSet.ts'
import { Pilot } from '../src/net/pilot.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = async (rel: string) => readFileSync(new URL(rel, ROOT), 'utf8')

async function createMatch(seats = 2) {
  const R = await initRapier()
  const names = readdirSync(new URL('fixtures/courses/', ROOT))
    .filter(n => n.endsWith('.course.json')).sort()
  const entries = []
  for (const name of names) {
    const path = `fixtures/courses/${name}`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  const courses = await matchCourses(entries, fixtureResolver(read), 'sprint')
  return new LocalMatch({ R, seats, seed: 7, profile: 'sprint', courses })
}

test('LocalMatch refuses seat counts outside integer 1..4', () => {
  for (const seats of [0, -1, 5, 1.5, NaN, Infinity]) {
    assert.throws(() => new LocalMatch({
      R: null as unknown as RapierModule, seats, seed: 7, profile: 'sprint', courses: [],
    }), (e: unknown) => e instanceof RefusalError && e.area === 'client' && e.path === 'localMatch')
  }
})

test('LocalMatch accumulates fixed steps, samples each seat and caps catch-up at eight steps', async () => {
  const match = await createMatch(4)
  try {
    const order: number[] = []
    const buffers = new Map<number, PlayerInput>()
    const sample = (seat: number, out: PlayerInput) => {
      order.push(seat)
      if (buffers.has(seat)) assert.equal(out, buffers.get(seat))
      buffers.set(seat, out)
    }
    const tick = match.sim.tick
    assert.equal(match.frame(1 / 120, sample), 0.5)
    assert.equal(match.sim.tick, tick)
    assert.deepEqual(order, [])
    assert.equal(match.frame(1 / 120, sample), 0)
    assert.equal(match.sim.tick, tick + 1)
    assert.deepEqual(order, [0, 1, 2, 3])
    order.length = 0
    const before = match.sim.tick
    const alpha = match.frame(0.5, sample)
    const steps = match.sim.tick - before
    assert.ok(steps > 0 && steps <= 8, `steps: ${steps}`)
    assert.deepEqual(order, Array.from({ length: steps }, () => [0, 1, 2, 3]).flat())
    assert.equal(new Set(buffers.values()).size, 4)
    assert.ok(alpha >= 0 && alpha < 1)
    assert.equal(match.done, match.sim.done)
  } finally {
    match.dispose()
  }
})

test('LocalMatch: two piloted seats reach done with six bots', async () => {
  const match = await createMatch()
  const pilots = [new Pilot(0, 7), new Pilot(1, 7)]
  try {
    let alpha = 0
    for (let frame = 0; frame < 60 * 900 && !match.done; frame++) {
      alpha = match.frame(1 / 60, (seat, out) => { pilots[seat].sample(match.sim, out) })
    }
    assert.equal(match.done, true)
    assert.equal(match.done, match.sim.done)
    assert.equal(alpha, 1)
    assert.deepEqual(match.sim.log().humans, [true, true, false, false, false, false, false, false])
    const tick = match.sim.tick
    assert.equal(match.frame(0.5, () => assert.fail('completed matches must not sample')), 1)
    assert.equal(match.sim.tick, tick)
  } finally {
    match.dispose()
  }
})

test('LocalMatch disposal frees the simulation exactly once', async t => {
  const match = await createMatch(1)
  const free = t.mock.method(match.sim, 'free')
  match.dispose()
  match.dispose()
  assert.equal(free.mock.callCount(), 1)
})
