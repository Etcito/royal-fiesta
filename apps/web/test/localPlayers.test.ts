import assert from 'node:assert/strict'
import test from 'node:test'
import { localPlayerCount } from '../src/game/localPlayers.ts'
import { splitLayout } from '../../../packages/game/src/client/splitLayout.ts'

test('players/local parses 1..4 and yields exactly N human viewports alongside course and bots', () => {
  assert.equal(localPlayerCount(new URLSearchParams()), null)
  for (let n = 1; n <= 4; n++) {
    for (const key of ['players', 'local']) {
      const count = localPlayerCount(new URLSearchParams(`${key}=${n}&course=s1-c1-diamond-citadel&bots=12`))!
      assert.equal(count, n)
      assert.deepEqual(splitLayout(count, false).map(v => v.seat), Array.from({ length: n }, (_, k) => k))
    }
  }
  assert.equal(localPlayerCount(new URLSearchParams('players=2&local=4')), 2)
})

test('invalid local human counts refuse clearly', () => {
  for (const raw of ['', '0', '5', '-1', '2.5', 'hello']) {
    assert.throws(() => localPlayerCount(new URLSearchParams(`players=${raw}`)), /1\.\.4/)
  }
})
