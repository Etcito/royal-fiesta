// The build-time default relay (platform/relay.ts): it feeds Play online only; ?server= wins; none means no relay.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultRelay, onlineRelay } from '../src/platform/relay.ts'
import { RefusalError } from '../../../packages/sim/src/refusal.ts'

test('no build value means no default relay (empty and blank too)', () => {
  assert.equal(defaultRelay(undefined), null)
  assert.equal(defaultRelay(''), null)
  assert.equal(defaultRelay('  '), null)
})

test('a ws or wss build value is the default, trimmed', () => {
  assert.equal(defaultRelay(' wss://relay.example.invalid/ws '), 'wss://relay.example.invalid/ws')
  assert.equal(defaultRelay('ws://localhost:8080/ws'), 'ws://localhost:8080/ws')
})

test('a malformed build value is refused with the fix', () => {
  assert.throws(() => defaultRelay('https://relay.example.invalid'), (e: unknown) =>
    e instanceof RefusalError && e.message.includes('VITE_RF_SERVER') && e.message.includes('wss://host/ws'))
})

test('Play online uses ?server= first, then the build default, else nothing', () => {
  assert.equal(onlineRelay('wss://a.example.invalid', 'wss://b.example.invalid'), 'wss://a.example.invalid')
  assert.equal(onlineRelay(null, 'wss://b.example.invalid'), 'wss://b.example.invalid')
  assert.equal(onlineRelay(null, null), null)
})
