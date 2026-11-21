import assert from 'node:assert/strict'
import test from 'node:test'
import { isZoneQueuePayload } from '../src/net/zoneRelayProtocol.ts'
import type { ZoneQueuePayload } from '../src/net/zoneRelayProtocol.ts'

const LEGACY: ZoneQueuePayload = {
  g: 'royal-fiesta', v: 1, zones: 1, name: 'Bean', seats: 2, course: 'race-sprint', tuning: 7,
  m: { cpuMs: 2, bandwidthKbps: 1000, latencyMs: 25, spareSlots: 3 },
}

test('the current legacy payload object is accepted', () => {
  assert.equal(isZoneQueuePayload(LEGACY), true)
})

test('the same payload with a valid engine identity is accepted', () => {
  const payload = { ...LEGACY, engine: { backend: 'engine', schemaKey: 4, moduleKey: 'mod-4' } }
  assert.equal(isZoneQueuePayload(payload), true)
})

test('a malformed engine identity is rejected', () => {
  const invalid: unknown[] = [
    null, {}, { backend: 'legacy', schemaKey: 1, moduleKey: 'm' }, { backend: 'engine', schemaKey: -1, moduleKey: 'm' },
    { backend: 'engine', schemaKey: 1, moduleKey: '' }, { backend: 'engine', schemaKey: 1.5, moduleKey: 'm' },
  ]
  for (const engine of invalid) assert.equal(isZoneQueuePayload({ ...LEGACY, engine }), false, String(engine))
})

test('seats 0 and seats 5 are still rejected', () => {
  assert.equal(isZoneQueuePayload({ ...LEGACY, seats: 0 }), false)
  assert.equal(isZoneQueuePayload({ ...LEGACY, seats: 5 }), false)
})
