// Supplemental CPU microbenchmark. The animPerf Chrome op is the hardware acceptance check.
import { readFileSync } from 'node:fs'
import { VisualIk } from '../packages/game/src/anim/ik.ts'
import { AnimDriver } from '../packages/game/src/anim/driver.ts'
const read = (name: string) => readFileSync(new URL(`../assets/common/${name}`, import.meta.url), 'utf8')
const { bindings, smooth, ...rig } = JSON.parse(read('penguin.body.asset.json')).document.nodes.penguin.rig
const clips = JSON.parse(read('penguin.body.asset.json')).document.nodes.penguin.clips.map((c: unknown) => JSON.stringify(c))
let ikMs = 0
const evaluate = VisualIk.prototype.evaluate
VisualIk.prototype.evaluate = function (...args) { const t = performance.now(); const out = evaluate.apply(this, args); ikMs += performance.now() - t; return out; }
for (const count of [12, 30, 60]) {
  const driver = await AnimDriver.load(read('penguin.animgraph.json'), JSON.stringify(rig), clips)
  const observations = Array.from({ length: count }, (_, id) => ({ id, mode: 0, emote: 0, surface: 'normal', grounded: true, vel: { x: 0, y: 0, z: 3 },
    xf: { pos: { x: id * 2, y: 1, z: 0 }, facing: { x: 0, z: 1 } }, ik: { mode: 0, look: { x: id * 2, y: 1, z: 10 }, grab: null, ground: { point: { x: id * 2, y: 0, z: 0 }, normal: { x: 0, y: 1, z: 0 } } } }))
  let total = 0, totalIk = 0
  for (let tick = 0; tick < 300; tick++) {
    const t = performance.now()
    ikMs = 0
    driver.observeTick(tick, observations)
    if (tick >= 60) {
      total += performance.now() - t
      totalIk += ikMs
    }
  }
  console.log(JSON.stringify({ count, animMs: total / 240, ikMs: totalIk / 240 }))
  driver.dispose()
}
