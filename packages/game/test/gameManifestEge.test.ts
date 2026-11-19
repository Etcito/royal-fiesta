import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import test from 'node:test'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { parseGameManifest } from '../src/gameManifest.ts'

const PATH = 'sdfm.game.json'
const read = (): Record<string, any> => JSON.parse(readFileSync(new URL('../../../sdfm.game.json', import.meta.url), 'utf8'))

function refusesAt(json: unknown, prefix: string): void {
  assert.throws(() => parseGameManifest(json, PATH), (e: unknown) => {
    assert.ok(isRefusal(e), String(e))
    assert.equal(e.area, 'manifest')
    assert.ok(e.message.startsWith(`${prefix}: `), e.message)
    assert.match(e.reason, /; ./) // a problem then its fix
    return true
  })
}

test('the committed sdfm.game.json names its schema and scripts folder', () => {
  const m = parseGameManifest(read(), PATH)
  assert.equal(m.schema, 'ege.schema.json')
  assert.equal(m.scripts, 'scripts/ege')
})

test('a schema without a scripts folder refuses at /scripts', () => {
  const json = read()
  delete json.scripts
  refusesAt(json, `[manifest] ${PATH}#/scripts`)
})

test('a scripts folder without a schema refuses at /schema', () => {
  const json = read()
  delete json.schema
  refusesAt(json, `[manifest] ${PATH}#/schema`)
})

test('a schema that climbs out of the game folder refuses at /schema', () => {
  const json = read()
  json.schema = '../x.schema.json'
  refusesAt(json, `[manifest] ${PATH}#/schema`)
})

test('a scripts folder outside scripts refuses at /scripts', () => {
  const json = read()
  json.scripts = 'other/x'
  refusesAt(json, `[manifest] ${PATH}#/scripts`)
})

test('a schema that is not a .schema.json file refuses at /schema', () => {
  const json = read()
  json.schema = 'ege.json'
  refusesAt(json, `[manifest] ${PATH}#/schema`)
})

test('the named schema file exists at the repository root', () => {
  const m = parseGameManifest(read(), PATH)
  assert.ok(existsSync(new URL(`../../../${m.schema}`, import.meta.url)))
})
