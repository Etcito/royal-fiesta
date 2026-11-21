import assert from 'node:assert/strict'
import test from 'node:test'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import type { EngineModuleIdentity } from '../../../tools/egeScripts.ts'
import { parseEngineIdentity, requireEnginePeers, requireLegacyPeers } from '../src/ege/admission.ts'

const LOCAL: EngineModuleIdentity = { backend: 'engine', schemaKey: 12, moduleKey: 'mod-a' }
const MISSING = 'missing or malformed engine module identity; reload every client on the same ?engine=1 build'
const LOCAL_MISSING = 'the local offer has no valid engine module identity; rebuild the page so the scripts plugin publishes one'
const LEGACY = 'an ?engine=1 client joined a legacy show; reload every client with the same backend'
const payload = (engine: unknown) => ({ name: 'Bean', engine })

test('parseEngineIdentity accepts a valid identity and returns a new object', () => {
  const input = { backend: 'engine', schemaKey: 7, moduleKey: 'm7' }
  const parsed = parseEngineIdentity(input)
  assert.deepEqual(parsed, { backend: 'engine', schemaKey: 7, moduleKey: 'm7' })
  assert.notEqual(parsed, input)
  input.moduleKey = 'changed'
  assert.equal(parsed?.moduleKey, 'm7')
})

test('parseEngineIdentity returns null for every malformed value', () => {
  const invalid: unknown[] = [
    null, undefined, 3, 'engine', [], [{ backend: 'engine', schemaKey: 0, moduleKey: 'm' }],
    { backend: 'legacy', schemaKey: 0, moduleKey: 'm' },
    { schemaKey: 0, moduleKey: 'm' },
    { backend: 'engine', schemaKey: -1, moduleKey: 'm' },
    { backend: 'engine', schemaKey: 1.5, moduleKey: 'm' },
    { backend: 'engine', schemaKey: 2 ** 53, moduleKey: 'm' },
    { backend: 'engine', schemaKey: 0, moduleKey: '' },
    { backend: 'engine', schemaKey: 0, moduleKey: 5 },
    { backend: 'engine', schemaKey: 0, moduleKey: 'x'.repeat(257) },
  ]
  for (const value of invalid) assert.equal(parseEngineIdentity(value), null, String(value))
})

test('requireEnginePeers passes when every opponent including the local payload matches', () => {
  const opponents = [payload(LOCAL), payload({ ...LOCAL }), payload({ ...LOCAL, moduleKey: 'mod-a' })]
  assert.doesNotThrow(() => requireEnginePeers(LOCAL, opponents))
})

test('requireEnginePeers refuses a missing identity on opponent 1', () => {
  assert.throws(
    () => requireEnginePeers(LOCAL, [payload(LOCAL), { name: 'Bean' }]),
    (error: unknown) => error instanceof RefusalError && error.area === 'ege-online'
      && error.path === 'lobby.opps/1.engine' && error.reason === MISSING,
  )
})

test('requireEnginePeers names both keys on a schemaKey or moduleKey mismatch', () => {
  const schemaPeer = { backend: 'engine', schemaKey: 13, moduleKey: 'mod-a' }
  assert.throws(
    () => requireEnginePeers(LOCAL, [payload(LOCAL), payload(schemaPeer)]),
    (error: unknown) => error instanceof RefusalError && error.path === 'lobby.opps/1.engine'
      && error.reason === 'module identity mismatch: local mod-a/12, peer mod-a/13; reload every client on the same ?engine=1 build',
  )
  const modulePeer = { backend: 'engine', schemaKey: 12, moduleKey: 'mod-b' }
  assert.throws(
    () => requireEnginePeers(LOCAL, [payload(modulePeer)]),
    (error: unknown) => error instanceof RefusalError && error.path === 'lobby.opps/0.engine'
      && error.reason === 'module identity mismatch: local mod-a/12, peer mod-b/12; reload every client on the same ?engine=1 build',
  )
})

test('requireEnginePeers refuses an invalid local identity before the opponents', () => {
  const local = { backend: 'legacy', schemaKey: 0, moduleKey: 'm' } as unknown as EngineModuleIdentity
  assert.throws(
    () => requireEnginePeers(local, [payload(LOCAL)]),
    (error: unknown) => error instanceof RefusalError && error.path === 'lobby.local.engine' && error.reason === LOCAL_MISSING,
  )
})

test('requireLegacyPeers refuses the first payload carrying an engine key and passes legacy payloads', () => {
  assert.doesNotThrow(() => requireLegacyPeers([{ name: 'Bean' }, { g: 'royal-fiesta', v: 1 }]))
  assert.throws(
    () => requireLegacyPeers([{ name: 'Bean' }, payload(LOCAL), payload(LOCAL)]),
    (error: unknown) => error instanceof RefusalError && error.path === 'lobby.opps/1.engine' && error.reason === LEGACY,
  )
})
