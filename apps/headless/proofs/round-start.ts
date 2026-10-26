// Two real-time clients use the existing hub harness assets and relay, stopping after startup.
import assert from 'node:assert/strict'
import { readdir } from 'node:fs/promises'
import { initRapier } from '@gamesaloon/rollback-rapier'
import { matchCourses } from '@royal-fiesta/game/courseSet'
import { LoopbackRelay } from '@royal-fiesta/game/net/loopbackRelay'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'
import { observeRoundLoad } from '@royal-fiesta/game/render/roundLoad'
import { InPageHubLoop } from '../../web/src/play/inpageHub.ts'
import { loadCourseFile, nodeFixtureResolver, readRepoText, repoPath } from '../src/files.ts'

const R = await initRapier()
const names = (await readdir(repoPath('fixtures/courses'))).filter(n => n.endsWith('.course.json')).sort()
const entries = await Promise.all(names.map(async name => {
  const path = `fixtures/courses/${name}`
  return { path, json: JSON.parse(await readRepoText(path)) }
}))
const resolver = nodeFixtureResolver()
const courses = await matchCourses(entries, resolver, 'sprint')
const plaza = await loadCourseFile('fixtures/courses/hub-plaza.course.json')
const assets = new Map<string, PrimsAsset>([['bean', (await resolver.resolve('bean')).asset]])
for (const c of [...courses, plaza]) {
  for (const o of c.obstacles) if (!assets.has(o.asset)) assets.set(o.asset, (await resolver.resolve(o.asset)).asset)
}
const ports = [new NullRenderPort(), new NullRenderPort()]
for (const port of ports) await port.init({ canvas: null, width: 960, height: 540, viewports: [{ x: 0, y: 0, width: 960, height: 540 }] })
const report: Record<string, number | string | readonly string[]> = {}
const stop = observeRoundLoad(() => {}, report)
const asset = (name: string): PrimsAsset => {
  const value = assets.get(name)
  assert.ok(value, `asset ${name} must be preloaded`)
  return value
}
const loop = new InPageHubLoop(R, 2, new LoopbackRelay({ seed: 8 }), {
  R, courses, plaza, partySize: 2, now: () => performance.now(), pilot: true,
}, ports, { assets: asset, bean: asset('bean') })
const start = performance.now()
let frames = 0
try {
  while (performance.now() - start < 30_000) {
    loop.frame(1 / 60)
    frames++
    assert.ok(!loop.events.some(e => e.state === 'failed'), JSON.stringify(loop.events.filter(e => e.state === 'failed')))
    if (loop.flows.length === 2 && loop.flows.every(f => f.match !== null && f.match.sim.tick >= 120)) break
    await new Promise(resolve => setTimeout(resolve, 17))
  }
  const hashes = loop.hashes()
  assert.equal(loop.flows.length, 2)
  assert.ok(loop.flows.every(f => f.match !== null && f.match.sim.tick >= 120), 'both clients must reach tick 120 within 30 seconds')
  assert.ok(hashes.ticksCompared > 0)
  assert.equal(hashes.mismatches, 0)
  console.log(JSON.stringify({ check: 'two clients start', renderer: 'null', frames, wallMs: performance.now() - start, ...hashes, ...report }))
} finally {
  loop.dispose()
  for (const port of ports) port.dispose()
  stop()
}
