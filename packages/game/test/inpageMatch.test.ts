import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import { fixtureResolver } from '../src/assets.ts'
import { InPageMatch } from '../src/client/inpageMatch.ts'
import { controlsToInput, emptyControls } from '../src/client/inputMap.ts'
import { matchCourses } from '../src/courseSet.ts'
import type { CourseEntry } from '../src/courseSet.ts'
import type { PrimsAsset } from '../src/prims.ts'
import { NullRenderPort } from '../src/render/nullPort.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = async (rel: string) => readFileSync(new URL(rel, ROOT), 'utf8')
const resolver = fixtureResolver(read)

test('controlsToInput: forward follows the camera facing on XZ', () => {
  const c = emptyControls()
  c.forward = true
  const out = controlsToInput(c, { x: 1, z: 0 }, neutralInput())
  assert.ok(Math.abs(out.moveX - 1) < 1e-12, `moveX ${out.moveX}`)
  assert.ok(Math.abs(out.moveZ) < 1e-12, `moveZ ${out.moveZ}`)
  // Looking along +Z, right is +X.
  const r = emptyControls()
  r.right = true
  const o2 = controlsToInput(r, { x: 0, z: 1 }, neutralInput())
  assert.ok(Math.abs(o2.moveX - 1) < 1e-12 && Math.abs(o2.moveZ) < 1e-12)
})

test('controlsToInput: the stick length is clamped to 1', () => {
  const c = emptyControls()
  c.stickX = 1
  c.stickY = 1
  const out = controlsToInput(c, { x: 0, z: 1 }, neutralInput())
  assert.ok(Math.abs(Math.sqrt(out.moveX * out.moveX + out.moveZ * out.moveZ) - 1) < 1e-12)
  const k = emptyControls()
  k.forward = true
  k.right = true
  const o2 = controlsToInput(k, { x: 0, z: 1 }, neutralInput())
  assert.ok(Math.sqrt(o2.moveX * o2.moveX + o2.moveZ * o2.moveZ) <= 1 + 1e-12)
})

test('controlsToInput: buttons map to jump, dive and grab', () => {
  const c = emptyControls()
  c.jump = true
  c.grab = true
  const out = controlsToInput(c, { x: 0, z: 1 }, neutralInput())
  assert.deepEqual([out.jump, out.dive, out.grab], [true, false, true])
  c.jump = false
  c.dive = true
  c.grab = false
  controlsToInput(c, { x: 0, z: 1 }, out)
  assert.deepEqual([out.jump, out.dive, out.grab], [false, true, false])
  assert.equal(out.moveX, 0)
  assert.equal(out.moveZ, 0)
})

async function loadCourses(): Promise<ResolvedCourse[]> {
  const names = readdirSync(new URL('fixtures/courses/', ROOT), { withFileTypes: true })
    .filter(e => e.isFile() && e.name.endsWith('.course.json')).map(e => e.name).sort()
  const entries: CourseEntry[] = []
  for (const n of names) {
    const path = `fixtures/courses/${n}`
    entries.push({ path, json: JSON.parse(await read(path)) as unknown })
  }
  return matchCourses(entries, resolver, 'sprint')
}

test('InPageMatch: 2 piloted clients on in-page NetSim agree on every confirmed hash', async () => {
  const R: RapierModule = await initRapier()
  const courses = await loadCourses()
  const assets = new Map<string, PrimsAsset>()
  for (const c of courses) {
    for (const o of c.obstacles) if (!assets.has(o.asset)) assets.set(o.asset, (await resolver.resolve(o.asset)).asset)
  }
  const bean = (await resolver.resolve('bean')).asset
  const ports = [new NullRenderPort(), new NullRenderPort()]
  for (const p of ports) await p.init({ canvas: null, width: 960, height: 540, viewports: [{ x: 0, y: 0, width: 960, height: 540 }] })
  const match = new InPageMatch({
    R, clients: 2, seed: 7, profile: 'sprint', courses, ports, bean,
    assets: name => {
      const a = assets.get(name)
      assert.ok(a, `asset ${name} preloaded`)
      return a
    },
    net: { rttMs: 60, jitterMs: 5, loss: 0 }, pilots: [true, true],
  })
  try {
    let withCourse = 0
    for (let i = 0; i < 600; i++) {
      match.frame(1 / 60)
      const sim = match.matches[0].sim
      if (sim.course() !== null) {
        assert.equal(match.views[0].instanceCount, 8 + sim.obstacleCount())
        withCourse++
      }
    }
    assert.ok(withCourse > 0, 'a course was loaded')
    const h = match.hashes()
    assert.ok(h.ticksCompared > 0, `ticksCompared ${h.ticksCompared}`)
    assert.equal(h.mismatches, 0)
    assert.equal(ports[0].calls.render, 600)
    assert.equal(ports[1].calls.render, 600)
  } finally {
    match.dispose()
  }
})

test('InPageMatch refuses bad client, pilot and port counts', () => {
  const base = {
    R: null as unknown as RapierModule, seed: 1, profile: 'sprint' as const, courses: [],
    assets: () => { throw new Error('unused') }, bean: null as unknown as PrimsAsset, net: { rttMs: 0, jitterMs: 0, loss: 0 },
  }
  const p = new NullRenderPort()
  assert.throws(() => new InPageMatch({ ...base, clients: 5, ports: [p], pilots: [true, true, true, true, true] }), /1\.\.4/)
  assert.throws(() => new InPageMatch({ ...base, clients: 2, ports: [p], pilots: [true] }), /pilots/)
  assert.throws(() => new InPageMatch({ ...base, clients: 3, ports: [p, p], pilots: [true, true, true] }), /ports/)
})
