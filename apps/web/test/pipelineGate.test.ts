import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { courseWarmed, prepareCourse, RoundGate, roundStarts } from '../src/render/pipelineGate.ts'

class GatedPort {
  warmed: (readonly string[] | undefined)[] = []
  vertexColour = 0
  assets = ['course.ramp', 'course.wall']
  warmPipelines(assetIds?: readonly string[]): void { this.warmed.push(assetIds) }
  warmableAssets(): string[] { return this.assets }
  fallbackParts(): number { return this.vertexColour }
}

function capture(run: () => void): string[] {
  const errors: string[] = []
  const log = console.error
  console.error = (message: string) => { errors.push(message) }
  try { run() } finally { console.error = log }
  return errors
}

// Owner 2026-11-04: course assets appeared one after the other once the race had started.
test('a countdown starting with parts still in vertex colour names the course and the count', () => {
  const port = new GatedPort()
  assert.deepEqual(capture(() => assert.equal(roundStarts('sprint.ramps', port), 0)), [])
  port.vertexColour = 7
  const errors = capture(() => assert.equal(roundStarts('sprint.ramps', port), 7))
  assert.equal(errors.length, 1)
  assert.match(errors[0], /sprint\.ramps/)
  assert.match(errors[0], /7 parts still in vertex colour/)
  assert.deepEqual(capture(() => roundStarts('hub', {})), [], 'a port without fallbacks is not checked')
})

test('prepareCourse is the warm-up draw of the scene, once per course and port', async () => {
  const port = new GatedPort()
  await prepareCourse(port, 'sprint.ramps')
  assert.deepEqual(port.warmed, [['course.ramp', 'course.wall']])
  assert.equal(courseWarmed(port, 'sprint.ramps'), true)
  assert.equal(courseWarmed(new GatedPort(), 'sprint.ramps'), false)
  // Background: one asset per step (no pipeline is compiling in this test).
  const background = new GatedPort()
  await prepareCourse(background, 'sprint.ramps', { oneAtATime: true })
  assert.deepEqual(background.warmed, [['course.ramp'], ['course.wall']])
  const cancelled = new GatedPort()
  await prepareCourse(cancelled, 'sprint.ramps', { oneAtATime: true, cancelled: () => true })
  assert.deepEqual(cancelled.warmed, [])
  await prepareCourse({ render() {} }, 'sprint.ramps')
})

test('the round gate warms each shown course, hub and podium once and guards every countdown', () => {
  const gate = new RoundGate()
  const port = new GatedPort()
  const errors = capture(() => {
    gate.frame('hub', { port, course: 'hub' })
    gate.frame('hub', { port, course: 'hub' })
    gate.frame('countdown', null)
    port.vertexColour = 3
    gate.frame('countdown', { port, course: 'sprint.ramps' })
    gate.frame('countdown', { port, course: 'sprint.ramps' })
    gate.frame('round', { port, course: 'sprint.ramps' })
    port.vertexColour = 0
    gate.frame('podium', { port, course: 'podium' })
    gate.frame('countdown', { port, course: 'sprint.ramps' })
  })
  assert.equal(port.warmed.length, 3, 'hub, the course, the podium; the course is not warmed twice on its port')
  assert.equal(errors.length, 1)
  assert.match(errors[0], /round sprint\.ramps: the countdown starts with 3 parts still in vertex colour/)
  // A show round warmed in its prepare is only guarded.
  const show = new GatedPort()
  void prepareCourse(show, 'sprint.fall')
  gate.frame('countdown', { port: show, course: 'sprint.fall' })
  assert.equal(show.warmed.length, 1)
})

// Every path that shows a course (the voted and the next show rounds, the background first-course preload, local and
// online rounds, in-page matches, the podium and the hub return) reaches the gate: show rounds through ShowMode's
// prepare, every mode through the App frame passing its roundStage to RoundGate.
test('every round-start path goes through the shared gate', () => {
  const main = readFileSync(new URL('../src/game/main.ts', import.meta.url), 'utf8')
  const show = readFileSync(new URL('../src/game/showMode.ts', import.meta.url), 'utf8')
  // The App gates whatever mode drew this frame, right after it ran.
  assert.match(main, /const screen = mode\.frame\(\{[\s\S]*?\}\)\s*\n\s*if \(mode\.failure !== null\) return this\.fail\(mode\.failure\)\s*\n\s*this\.roundGate\.frame\(screen, mode\.roundStage\(\)\)/)
  // Every mode class has a stage (Mode.roundStage is required, so a new mode cannot skip it).
  const modes = [...main.matchAll(/^class (\w+) implements Mode \{/gm)].map(m => m[1])
  assert.deepEqual(modes.sort(), ['InPageMode', 'LocalMode', 'OnlineMode', 'ShowAdapter'])
  assert.match(main, /^interface Mode \{[\s\S]*?\n  roundStage\(\): RoundStage \| null\n\}/m)
  for (const mode of modes) {
    const body = main.slice(main.indexOf(`class ${mode} implements Mode {`))
    const end = body.indexOf('\n}\n')
    assert.match(body.slice(0, end), /\n  roundStage\(\): RoundStage \| null \{/, `${mode} has a roundStage`)
  }
  assert.match(main, /roundStage\(\): RoundStage \| null \{ return this\.show\.roundStage\(\) \}/)
  // Every show round (the first, voted or not, each next round and the preloaded one) is warmed in its prepare
  // before its world is released to the countdown.
  const prepare = show.slice(show.indexOf('private async prepare('), show.indexOf('private humanDomain('))
  assert.ok(prepare.indexOf('await prepareCourse(scene.port') > 0, 'the show round goes through prepareCourse')
  assert.ok(prepare.indexOf('await prepareCourse(scene.port') < prepare.indexOf('this.director?.worldReady(index)'))
  assert.match(show, /private loadRound\(\): void \{[\s\S]*?void this\.prepare\(round\)/)
  assert.match(show, /preload\(\): boolean \{[\s\S]*?this\.loadRound\(\)/)
  // Play adopts the preloaded show instead of loading the course again.
  assert.match(main, /show = show\?\.adopt\(look\) \?\? await ShowMode\.create\(/)
})
