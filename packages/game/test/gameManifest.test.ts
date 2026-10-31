import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { FEATURE_KINDS } from '@royal-fiesta/sim/features/catalog'
import { ROUND_KINDS, STAGE_IDS } from '@royal-fiesta/sim/season/kinds'
import { manifestCoverage, parseGameManifest } from '../src/gameManifest.ts'

const S13_KEYS = [
  'season', 'map', 'kind', 'finalRule', 'stages', 'capacity', 'usual', 'quota',
  'timeCapS', 'overtimeS', 'respawn', 'route', 'teams', 'homes', 'groups', 'grab',
]
const GROUP_ROLES = ['floor', 'wall', 'hazard', 'mover', 'objective', 'respawn', 'route', 'decor']

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
  assert.deepEqual(manifestCoverage(m), { missingMotions: [], extraMotions: [], keyMismatches: [], missingMarkers: [], audioFolder: 'audio', mechanisms: null })
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

test('folders.audio and mechanisms are optional, parsed and reported', () => {
  const plain = parseGameManifest(read(), PATH)
  assert.equal(plain.folders.audio, 'audio')
  assert.equal(plain.mechanisms, undefined)
  const json = read()
  json.folders.audio = 'sounds'
  json.mechanisms = { version: 1, jointKinds: ['hinge', 'spring'], linkTargets: ['motor', 'door', 'spring', 'animation'], presets: ['seesaw', 'door'] }
  const m = parseGameManifest(json, PATH)
  assert.equal(m.folders.audio, 'sounds')
  assert.deepEqual(m.mechanisms?.presets, ['seesaw', 'door'])
  const cov = manifestCoverage(m)
  assert.equal(cov.audioFolder, 'sounds')
  assert.deepEqual(cov.mechanisms, {
    missingJointKinds: ['fixed', 'slider', 'ball', 'rope'],
    missingLinkTargets: [],
    missingPresets: ['piston', 'crane', 'springPlatform', 'lever', 'pressurePlate'],
  })
})

test('an unknown mechanism preset refuses at its pointer', () => {
  const json = read()
  json.mechanisms = { version: 1, jointKinds: [], linkTargets: [], presets: ['seesaw', 'trampoline'] }
  refusesAt(json, `[manifest] ${PATH}#/mechanisms/presets/1`)
})

test('the committed level and features schemas parse in the M3 shape', () => {
  const m = parseGameManifest(read(), PATH)
  assert.ok(m.level)
  assert.deepEqual(m.level.groupRoles, GROUP_ROLES)
  assert.deepEqual(m.level.fields.kind, { type: 'enum', enum: [...ROUND_KINDS] })
  assert.deepEqual(m.level.fields.finalRule, { type: 'enum', enum: ['crown', 'lastStanding'] })
  assert.deepEqual(m.level.fields.stages, { type: 'list', items: { type: 'enum', enum: [...STAGE_IDS] } })
  assert.deepEqual(m.level.fields.capacity, { type: 'integer', min: 1, max: 60 })
  assert.deepEqual(m.level.fields.timeCapS, { type: 'number', min: 0 })
  assert.deepEqual(m.level.fields.homes, {
    type: 'list',
    items: {
      type: 'object',
      fields: {
        team: { type: 'integer', min: 0, max: 1 },
        center: { type: 'vec3' },
        half: { type: 'vec3' },
        respawn: {
          type: 'list',
          items: { type: 'object', fields: { t: { type: 'vec3' }, yawDeg: { type: 'number' } } },
        },
      },
    },
  })
  assert.deepEqual(Object.keys(m.features!), Object.keys(FEATURE_KINDS))
})

test('level.fields covers exactly the S13 keys', () => {
  const m = parseGameManifest(read(), PATH)
  assert.deepEqual(Object.keys(m.level!.fields).sort(), [...S13_KEYS].sort())
})

test('features keys equal Object.keys(FEATURE_KINDS)', () => {
  const m = parseGameManifest(read(), PATH)
  assert.deepEqual(Object.keys(m.features!).sort(), Object.keys(FEATURE_KINDS).sort())
})

test('level and feature schemas refuse an enum without values, a list without items and min > max', () => {
  const cases: [(j: Record<string, any>) => void, string][] = [
    [j => { j.level.fields.kind = { type: 'enum' } }, '#/level/fields/kind/enum'],
    [j => { j.level.fields.kind = { type: 'enum', enum: [] } }, '#/level/fields/kind/enum'],
    [j => { j.level.fields.stages = { type: 'list' } }, '#/level/fields/stages/items'],
    [j => { j.level.fields.capacity = { type: 'integer', min: 61, max: 60 } }, '#/level/fields/capacity/min'],
    [j => { j.features.marker.radiusM = { type: 'number', min: 10, max: 0.1 } }, '#/features/marker/radiusM/min'],
    [j => { j.level.fields.grab = { type: 'object', fields: { players: { type: 'list' } } } }, '#/level/fields/grab/fields/players/items'],
  ]
  for (const [edit, ptr] of cases) {
    const json = read()
    edit(json)
    refusesAt(json, `[manifest] ${PATH}${ptr}`)
  }
})
