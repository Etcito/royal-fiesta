import assert from 'node:assert/strict'
import test from 'node:test'
import { applyCourseEnvironment, DEFAULT_LIGHT } from '../src/render/courseEnvironment.ts'

function mockEngine() {
  const calls: [string, ...unknown[]][] = []
  return {
    calls,
    applyEnvironment: (env: unknown) => { calls.push(['environment', env]) },
    setPassEnabled: (name: string, on: boolean) => { calls.push(['pass', name, on]) },
    setLight: (light: unknown) => { calls.push(['light', light]) },
    setAmbient: (ambient: unknown) => { calls.push(['ambient', ambient]) },
  }
}

for (const area of ['render', 'sdf']) {
  test(`${area}: RAA names pass unchanged and the requested passes are enabled`, () => {
    const engine = mockEngine()
    const sun = { dir: [-0.35, -1, -0.45] as [number, number, number], color: [1, 0.96, 0.9], intensity: 3.2 }
    applyCourseEnvironment(engine, { sky: 'day', fog: 'haze', post: 'candy', sun }, area, 'environment')
    assert.deepEqual(engine.calls[0], ['environment', { sky: 'day', fog: 'haze', post: 'candy' }])
    assert.deepEqual(engine.calls.slice(1, 4), [['pass', 'fog', true], ['pass', 'grading', true], ['pass', 'bloom', true]])
    assert.deepEqual(engine.calls[4], ['light', { direction: sun.dir, color: sun.color, intensity: sun.intensity }])
  })

  for (const [key, name, known] of [
    ['sky', 'candy-day', 'day, snow, jungle, night'],
    ['fog', 'candy-haze', 'clear, haze, snow, jungle, night'],
    ['post', 'candy-bright', 'neutral, candy, ice, jungle, neon'],
  ]) {
    test(`${area}: missing ${name} refuses before any engine mutation`, () => {
      const engine = mockEngine()
      assert.throws(() => applyCourseEnvironment(engine, { sky: 'day', [key]: name }, area, 'environment'), (error: Error) => {
        assert.ok(error.message.includes(`environment.${key}`))
        assert.ok(error.message.includes(name))
        assert.ok(error.message.includes(`known names: ${known}`))
        return true
      })
      assert.deepEqual(engine.calls, [])
    })
  }

  test(`${area}: null and omitted sections clear the previous course effects`, () => {
    for (const env of [null, {}]) {
      const engine = mockEngine()
      applyCourseEnvironment(engine, env, area, 'environment')
      assert.deepEqual(engine.calls[0], ['environment', { sky: 'day', fog: 'clear', post: 'neutral' }])
      assert.deepEqual(engine.calls.slice(1, 4), [['pass', 'fog', false], ['pass', 'grading', false], ['pass', 'bloom', false]])
      assert.deepEqual(engine.calls[4], ['light', DEFAULT_LIGHT])
    }
  })

  test(`${area}: an invalid sun refuses before applying a valid sky`, () => {
    const engine = mockEngine()
    assert.throws(() => applyCourseEnvironment(engine, { sky: 'day', sun: { dir: [0, 0, 0] } }, area, 'environment'), /environment.sun.dir/)
    assert.deepEqual(engine.calls, [])
  })
}
