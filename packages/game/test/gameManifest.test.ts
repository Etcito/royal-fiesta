import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { manifestCoverage, parseGameManifest } from '../src/gameManifest.ts'

const PATH = 'sdfm.game.json'
const read = (): Record<string, any> => JSON.parse(readFileSync(new URL('../../../sdfm.game.json', import.meta.url), 'utf8'))

function refusesAt(json: unknown, prefix: string): void {
  assert.throws(() => parseGameManifest(json, PATH), (e: unknown) => {
    assert.ok(isRefusal(e), String(e))
    assert.equal(e.area, 'manifest')
    assert.ok(e.message.startsWith(`${prefix}: `), e.message)
    assert.match(e.reason, /; ./) // a fix follows the problem
    return true
  })
}

test('the committed sdfm.game.json parses and covers every motion and marker', () => {
  const m = parseGameManifest(read(), PATH)
  assert.equal(m.id, 'royal-fiesta')
  assert.deepEqual(m.worlds, ['candy', 'ice', 'jungle', 'neon', 'common'])
  assert.equal(m.play.dev, 'http://localhost:5173/game.html?course={id}')
  assert.deepEqual(manifestCoverage(m), { missingMotions: [], extraMotions: [], keyMismatches: [], missingMarkers: [] })
})

test('the committed file is 2-space JSON with a trailing newline', () => {
  const raw = readFileSync(new URL('../../../sdfm.game.json', import.meta.url), 'utf8')
  assert.equal(raw, JSON.stringify(JSON.parse(raw), null, 2) + '\n')
})

test('a removed motion key, an extra motion and a missing marker are reported', () => {
  const json = read()
  delete json.motions.spinner.phaseDeg
  delete json.motions.bouncePad
  json.motions.spinner.extra = 'number'
  json.motions.conveyor.velocity = 'number'
  json.motions.movingPlatform.wave = { enum: ['sine'] }
  json.motions.hover = { height: 'number' }
  delete json.markers.killPlane
  const cov = manifestCoverage(parseGameManifest(json, PATH))
  assert.deepEqual(cov.missingMotions, ['bouncePad'])
  assert.deepEqual(cov.extraMotions, ['hover'])
  assert.deepEqual(cov.missingMarkers, ['killPlane'])
  assert.deepEqual(cov.keyMismatches, [
    'spinner.phaseDeg: missing key',
    'spinner.extra: extra key',
    'conveyor.velocity: expected vec3, got number',
    'movingPlatform.wave: expected {enum:[sine,pingpong]}, got {enum:[sine]}',
  ])
})

test('an unknown top-level key refuses at its pointer', () => {
  const json = read()
  json.extraField = true
  refusesAt(json, '[manifest] sdfm.game.json#/extraField')
})

test('field types and fixed values are checked strictly', () => {
  const cases: [(j: Record<string, any>) => void, string][] = [
    [j => { j.markers.spawn.t = 'vector' }, '#/markers/spawn/t'],
    [j => { j.markers.checkpoint.respawn.yawDeg = 3 }, '#/markers/checkpoint/respawn/yawDeg'],
    [j => { j.motions.movingPlatform.wave = { enum: ['sine'], extra: 1 } }, '#/motions/movingPlatform/wave/extra'],
    [j => { j.motions.movingPlatform.wave = { enum: [] } }, '#/motions/movingPlatform/wave/enum'],
    [j => { j.format = 'sdfm.other' }, '#/format'],
    [j => { j.courseVersion = 0 }, '#/courseVersion'],
    [j => { j.worlds.push('lava') }, '#/worlds/5'],
    [j => { delete j.folders.ui }, '#/folders/ui'],
    [j => { j.play.dev = 'http://localhost:5173/game.html' }, '#/play/dev'],
  ]
  for (const [edit, ptr] of cases) {
    const json = read()
    edit(json)
    refusesAt(json, `[manifest] ${PATH}${ptr}`)
  }
})
