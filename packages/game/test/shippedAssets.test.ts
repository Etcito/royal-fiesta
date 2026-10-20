// Every shipped asset is a valid raa.prims v0 file: checked by the published validator
// (@etcito/raa-assets-tools, the reference for schema/raa.prims.v0.schema.json), and read by the game's parser.
// The RAA loader (@etcito/raa) is not run here: loadPrimsAsset is an Engine method and createEngine needs
// WebGPU and a canvas, so the loader cannot run under node. Its last check is the browser (Chrome).
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { validateRaaPrims } from '@etcito/raa-assets-tools'
import { collidersOf, parsePrims } from '../src/prims.ts'

const DIR = join(process.cwd(), 'fixtures/assets')
const FILES = readdirSync(DIR).filter(f => f.endsWith('.prims.json')).sort()

test('every game asset file is present', () => {
  assert.ok(FILES.length >= 15, `expected at least 15 assets, found ${FILES.length}`)
})

for (const file of FILES) {
  test(`${file} is valid raa.prims v0 and reads in the game`, () => {
    const json: unknown = JSON.parse(readFileSync(join(DIR, file), 'utf8'))
    const result = validateRaaPrims(json)
    assert.ok(result.ok, `${file}: ${result.issues.map(i => `${i.path} ${i.message}`).join('; ')}`)
    const asset = parsePrims(json, `fixtures/assets/${file}`)
    assert.ok(collidersOf(asset, `fixtures/assets/${file}`).length >= 1)
    // The game hands the parsed asset to RAA as JSON, so that JSON must be the published file's content.
    assert.deepEqual(JSON.parse(JSON.stringify(asset)), asset)
    assert.ok(validateRaaPrims(JSON.parse(JSON.stringify(asset))).ok, `${file}: the parsed asset is not valid`)
  })
}
