import { test } from 'node:test'
import assert from 'node:assert/strict'
import { NEUTRAL_CODE, inputCode } from '@royal-fiesta/sim/input'
import { REPLAY_SCRIPTS, REPLAY_TICKS, behaviourScenarios, codeAt } from '../src/scripts.ts'
import { loadCourseFile } from '../src/files.ts'
import type { InputScript } from '../src/scripts.ts'

const A = inputCode({ moveZ: 1 })
const B = inputCode({ moveX: 1, jump: true })

test('codeAt: from is inclusive and to is exclusive', () => {
  const script: InputScript = [
    { from: 5, to: 10, code: A },
    { from: 10, to: 20, code: B },
  ]
  assert.equal(codeAt(script, 5), A)
  assert.equal(codeAt(script, 9), A)
  assert.equal(codeAt(script, 10), B)
  assert.equal(codeAt(script, 19), B)
})

test('codeAt: neutral outside every step', () => {
  const script: InputScript = [{ from: 10, to: 20, code: A }]
  assert.equal(codeAt(script, -1), NEUTRAL_CODE)
  assert.equal(codeAt(script, 0), NEUTRAL_CODE)
  assert.equal(codeAt(script, 9), NEUTRAL_CODE)
  assert.equal(codeAt(script, 20), NEUTRAL_CODE)
  assert.equal(codeAt(script, 1000), NEUTRAL_CODE)
})

test('REPLAY_TICKS equals the contract list', () => {
  assert.deepEqual(REPLAY_TICKS, [0, 60, 120, 240, 480, 720, 1200, 1800])
})

test('REPLAY_SCRIPTS: 8 contiguous integer-step scripts over 0..1800', () => {
  assert.equal(REPLAY_SCRIPTS.length, 8)
  for (const script of REPLAY_SCRIPTS) {
    assert.ok(script.length > 0)
    assert.equal(script[0].from, 0)
    assert.equal(script[script.length - 1].to, 1800)
    for (let i = 0; i < script.length; i++) {
      const step = script[i]
      assert.ok(Number.isInteger(step.from) && Number.isInteger(step.to) && Number.isInteger(step.code), JSON.stringify(step))
      assert.ok(step.from < step.to, JSON.stringify(step))
      assert.ok(step.code >= 0 && step.code < 2 ** 19, JSON.stringify(step))
      if (i > 0) assert.equal(step.from, script[i - 1].to, JSON.stringify(step))
    }
  }
})

test('behaviour scenarios have the fixed labels and non-empty runs', () => {
  const scenarios = behaviourScenarios()
  assert.deepEqual(scenarios.map((s) => s.label), [
    'jump-apex', 'run-speed', 'dive-speed', 'spinner-bump', 'bounce-apex', 'conveyor', 'platform', 'grab',
  ])
  for (const scenario of scenarios) assert.ok(scenario.ticks > 0, scenario.label)
})

test('gallery obstacle indices and behavior constants match the fixture', async () => {
  const course = await loadCourseFile('fixtures/courses/obstacle-gallery.course.json')
  assert.equal(course.obstacles[13].id, 'spinner-1')
  assert.equal(course.obstacles[30].id, 'conveyor-2')
  assert.equal(course.obstacles[33].id, 'bounce-1')
  assert.equal(course.obstacles[37].id, 'platform-2')
  const belt = course.obstacles[30].motion
  assert.equal(belt.kind, 'conveyor')
  if (belt.kind === 'conveyor') assert.equal(Math.abs(belt.velocity.z), 3)
  const pad = course.obstacles[33].motion
  assert.equal(pad.kind, 'bouncePad')
  if (pad.kind === 'bouncePad') assert.equal(pad.speed, 14)
  const platform = course.obstacles[37].motion
  assert.equal(platform.kind, 'movingPlatform')
  if (platform.kind === 'movingPlatform') assert.equal(platform.periodTicks, 180)
})
