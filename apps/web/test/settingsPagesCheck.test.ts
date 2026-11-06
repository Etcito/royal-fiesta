import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

// A second boot in the one GPU page (dispose, then a new App and a new uaa GPU device) froze the GPU client in
// requestDevice ("awaiting: UI GPU device", runs 12341 and 12345). settingsPages runs both sizes on one App and
// keeps going past a missed state, so one GPU job lists every failure.
const source = readFileSync(new URL('../src/game/checks/settingsPages.ts', import.meta.url), 'utf8').replace(/\/\/.*$/gm, '')

test('settingsPages boots one App, outside any loop and outside the per-size pass', () => {
  assert.equal(source.match(/deps\.boot\(/g)?.length, 1, 'one deps.boot call')
  const runBody = source.slice(source.indexOf('export async function run('))
  assert.ok(runBody.includes('deps.boot('), 'the boot is in run(), not in runSize()')
  const loop = /(for|while)\s*\([^)]*\)\s*\{[^}]*deps\.boot\(/s
  assert.ok(!loop.test(runBody), 'the boot is not repeated per size')
})

test('settingsPages reports a failed section and runs the next one', () => {
  const sections = [...source.matchAll(/await section\('([^']+)'/g)].map(m => m[1])
  assert.deepEqual(sections, ['Audio page', 'Graphics page', 'Controls page', 'Gameplay page', 'Back to start', 'Pause Controls page'])
  assert.match(source, /catch \(error\) \{ report\(/, 'a section catches and reports')
})

test('a UI GPU request that never settles rejects naming the resource, requester and last phase', async () => {
  const { gpuDeadline } = await import('../src/ui/uaaHost.ts')
  await assert.rejects(gpuDeadline('UI GPU device', new Promise(() => {}), 20),
    /UI GPU device: no answer within 0\.02 s \(requester: createUaaHost; last phase: none\)/)
  assert.equal(await gpuDeadline('UI GPU adapter', Promise.resolve(7), 20), 7)
})
