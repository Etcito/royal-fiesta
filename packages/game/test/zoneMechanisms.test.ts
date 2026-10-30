import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import test from 'node:test'
import { SnapReader, SnapWriter } from '@gamesaloon/rollback'
import type { DomainSpec, ShadowView } from '@gamesaloon/rollback/zones'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import { PROFILES } from '@royal-fiesta/sim/match/setup'
import { pose } from '@royal-fiesta/sim/vec'
import { FiestaDomain } from '@royal-fiesta/sim/zones/fiestaDomain'
import { createFiestaDomainFactory } from '@royal-fiesta/sim/zones/fiestaDomainFactory'
import { loadZonesFile } from '@royal-fiesta/sim/zones/zonesFile'
import { loadCourseV1 } from '../src/courseV1.ts'
import { assetFilePath, parseGameAsset } from '../src/gameAsset.ts'
import type { World } from '../src/gameAsset.ts'

const ROOT = new URL('../../../', import.meta.url)
const readText = (path: string): Promise<string> => readFile(new URL(path, ROOT), 'utf8')
const assets = {
  async resolve(id: string) {
    const path = assetFilePath(id.split('.')[0] as World, id)
    const json = JSON.parse(await readText(path))
    return { asset: await parseGameAsset(json, path), source: { path, json } }
  },
}
const noShadows: ShadowView = {
  count: 0, fromDomain() { throw new Error('no link') }, reader() { throw new Error('no link') },
}
const R = await initRapier()

async function load(id: string) {
  const path = `courses/${id}.course.json`
  const v1 = await loadCourseV1(JSON.parse(await readText(path)), path, assets)
  const course = v1.sim as ResolvedCourse
  const zones = await loadZonesFile(id, course, readText)
  return { course, zones }
}

function spec(seats: number[], cells: number[]): DomainSpec {
  return { id: seats.length ? seats[0] + 1 : 5 + cells[0], kind: seats.length ? 'seat' : 'field',
    seats, cells, replicas: [0, 1] }
}

function exported(domain: FiestaDomain): SnapReader {
  const w = new SnapWriter()
  domain.exportEntities(w)
  return new SnapReader(w.bytes().slice())
}

// Courses whose movers are free-track animations (a function of the tick, no switch needed).
for (const id of ['race-hammer-hill', 'race-bean-dash', 'obstacle-gallery']) {
  test(`${id}: animated mechanism bodies move in a zone domain, identically on every replica`, async t => {
    const { course, zones } = await load(id)
    assert.ok((course.mechanisms?.animations.length ?? 0) > 0, `${id} has animations`)
    const factory = createFiestaDomainFactory(R, {
      course, zones, profile: { ...PROFILES.sprint, introTicks: 0 }, kind: 'race', seatCount: 2,
    })
    const domainSpec = spec([0], [0])
    const a = factory.create(domainSpec, 0) as FiestaDomain
    const b = factory.create(domainSpec, 0) as FiestaDomain
    t.after(() => { a.inner.world.sim.free(); b.inner.world.sim.free() })
    const targets = course.mechanisms!.animations.map(animation => animation.target)
    const starts = targets.map(target => {
      const start = pose()
      assert.ok(a.mechanisms.bodyPose(a.ctx, target, start))
      return start
    })
    let moved = false
    const now = pose()
    for (let tick = 0; tick < 240; tick++) {
      a.step([neutralInput()], noShadows)
      b.step([neutralInput()], noShadows)
      assert.equal(a.hash(), b.hash(), `tick ${tick + 1}`)
      targets.forEach((target, k) => {
        a.mechanisms.bodyPose(a.ctx, target, now)
        const s0 = starts[k].t
        if (Math.abs(now.t.x - s0.x) + Math.abs(now.t.y - s0.y) + Math.abs(now.t.z - s0.z) > 1e-6) moved = true
      })
    }
    assert.ok(moved, 'an animated body left its rest pose')
  })
}

test('a rebuilt domain poses movers where the source has them, and its replicas keep in step', async t => {
  const { course, zones } = await load('neon-piston-alley')
  const factory = createFiestaDomainFactory(R, {
    course, zones, profile: { ...PROFILES.sprint, introTicks: 0 }, kind: 'race', seatCount: 2,
  })
  const source = factory.create(spec([0], [0]), 0) as FiestaDomain
  const together = spec([0], [0, 1])
  t.after(() => source.inner.world.sim.free())
  for (let tick = 0; tick < 97; tick++) source.step([neutralInput()], noShadows)
  const rebuilt = factory.rebuild(together, source.tick, [exported(source)]) as FiestaDomain
  t.after(() => rebuilt.inner.world.sim.free())
  const refs = course.mechanisms!.animations.map(animation => animation.target)
  const p = pose(), q = pose()
  for (const ref of refs) {
    assert.ok(source.mechanisms.bodyPose(source.ctx, ref, p))
    assert.ok(rebuilt.mechanisms.bodyPose(rebuilt.ctx, ref, q))
    assert.deepEqual(q.t, p.t)
    assert.deepEqual(q.r, p.r)
  }
  const twin = factory.rebuild(together, source.tick, [exported(source)]) as FiestaDomain
  t.after(() => twin.inner.world.sim.free())
  for (let tick = 0; tick < 60; tick++) {
    rebuilt.step([neutralInput()], noShadows)
    twin.step([neutralInput()], noShadows)
    assert.equal(rebuilt.hash(), twin.hash(), `tick ${rebuilt.tick}`)
  }
})
