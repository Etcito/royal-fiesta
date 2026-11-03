import assert from 'node:assert/strict'
import test from 'node:test'
import { localBotCount } from '../src/game/localBots.ts'

test('local roster query accepts 2..60, singular alias, and plural precedence', () => {
  for (const key of ['bots', 'bot']) for (const count of [2, 8, 60]) {
    assert.equal(localBotCount(new URLSearchParams(`${key}=${count}`)), count)
  }
  assert.equal(localBotCount(new URLSearchParams()), null)
  assert.equal(localBotCount(new URLSearchParams('bots=60&bot=8')), 60)
})

test('invalid local roster reports a clear console refusal', t => {
  const log = t.mock.method(console, 'error', () => {})
  for (const raw of ['', '1', '61', '-2', '2.5', 'NaN', 'Infinity']) {
    assert.throws(() => localBotCount(new URLSearchParams({ bots: raw })), /2\.\.60/)
  }
  assert.equal(log.mock.callCount(), 7)
})
