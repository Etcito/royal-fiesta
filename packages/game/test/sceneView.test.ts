import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { initRapier } from '@gamesaloon/rollback-rapier'
import type { RapierModule } from '@gamesaloon/rollback-rapier'
import type { ResolvedCourse } from '@royal-fiesta/sim/course'
import { neutralInput } from '@royal-fiesta/sim/input'
import { createMatchSim } from '@royal-fiesta/sim/match/matchSim'
import { fixtureResolver } from '../src/assets.ts'
import { matchCourses } from '../src/courseSet.ts'
import type { CourseEntry } from '../src/courseSet.ts'
import { netSetup } from '../src/net/tuning.ts'
import type { PrimsAsset } from '../src/prims.ts'
import { NullRenderPort } from '../src/render/nullPort.ts'
import { SceneView } from '../src/render/sceneView.ts'

const ROOT = new URL('../../../', import.meta.url)
const read = async (rel: string) => readFileSync(new URL(rel, ROOT), 'utf8')
const resolver = fixtureResolver(read)

const R: RapierModule = await initRapier()

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

const courses = await loadCourses()

// SceneView takes a synchronous lookup, so every asset the courses use is resolved up front.
const assets = new Map<string, PrimsAsset>()
for (const c of courses) {
  for (const o of c.obstacles) if (!assets.has(o.asset)) assets.set(o.asset, (await resolver.resolve(o.asset)).asset)
}
const bean = (await resolver.resolve('bean')).asset

test('SceneView keeps beans and obstacles on the port while the match runs', async () => {
  const sim = createMatchSim(R, netSetup(5, 1, 'sprint', courses))
  const port = new NullRenderPort()
  await port.init({ canvas: null, width: 960, height: 540, viewports: [{ x: 0, y: 0, width: 960, height: 540 }] })
  const used = new Set<string>()
  const view = new SceneView({
    port, viewport: 0, localPlayer: 0, bean,
    assets: name => {
      used.add(name)
      const a = assets.get(name)
      assert.ok(a, `asset ${name} preloaded`)
      return a
    },
  })
  try {
    const inputs = Array.from({ length: sim.setup.playerCount }, () => neutralInput())
    let transforms = port.calls.setTransform
    let grew = 0
    for (let i = 0; i < 200; i++) {
      sim.step(inputs)
      view.update(sim, null, 0.5, 1 / 60)
      if (sim.course() !== null) {
        assert.equal(view.instanceCount, 8 + sim.obstacleCount())
        assert.equal(view.courseIndex, courses.indexOf(sim.course()!))
      }
      if (port.calls.setTransform > transforms) grew++
      transforms = port.calls.setTransform
    }
    assert.ok(sim.course() !== null, 'a course is loaded')
    assert.ok(grew >= 190, `setTransform grew on ${grew} of 200 frames`)
    assert.equal(port.calls.registerAsset, used.size + 1, 'one registerAsset per distinct asset name (+ bean)')
    assert.equal(port.render().instances, view.instanceCount)
    assert.ok(view.camera !== null)
    assert.equal(view.camera.fovYDeg, 60)
  } finally {
    view.dispose()
    assert.equal(port.render().instances, 0)
    sim.free()
  }
})
