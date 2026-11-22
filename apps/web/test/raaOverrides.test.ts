import { test } from 'node:test'
import assert from 'node:assert/strict'
import { applyRaaOverrides, parseRaa, raaCreationOptions, raaOptionValues, raaReportLines } from '../src/perf/raaOverrides.ts'

test('?raa= splits into creation options, graphics options and engine settings', () => {
  const list = parseRaa('?raa=msaa:1,aoQuality:0,shading:vertex,shadows.resolution:1024')
  assert.deepEqual(raaCreationOptions(list), { msaa: 1 })
  assert.deepEqual(raaOptionValues(list), { aoQuality: 0, shading: 'vertex' })
})

test('pass.<name> and <group>.<field> call the engine setters, one call per group', () => {
  const calls: unknown[][] = []
  const engine = {
    setPassEnabled: (...a: unknown[]) => calls.push(['pass', ...a]),
    setShadows: (s: unknown) => calls.push(['shadows', s]),
    setSsr: (s: unknown) => calls.push(['ssr', s]),
  }
  applyRaaOverrides(engine, parseRaa('?raa=pass.ao.gtao:0,shadows.resolution:1024,shadows.distance:30,ssr.enabled:0'))
  assert.deepEqual(calls, [['pass', 'ao.gtao', false], ['shadows', { resolution: 1024, distance: 30 }], ['ssr', { enabled: false }]])
})

test('an unknown key and a refusing engine are reported, never ignored', () => {
  const engine = { setFog: () => { throw new Error('api.invalid_argument: bad') } }
  applyRaaOverrides(engine, parseRaa('?raa=nothing:1,warp.speed:9,fog.density:-1'))
  const lines = new Map(raaReportLines().map(l => [l.split(' ')[1], l]))
  assert.match(lines.get('nothing:1') ?? '', /unknown/)
  assert.match(lines.get('warp.speed:9') ?? '', /unknown.*no setWarp/)
  assert.match(lines.get('fog.density:-1') ?? '', /rejected.*bad/)
})
