import assert from 'node:assert/strict'
import test from 'node:test'
import { oneAtATime } from '../src/render/raaEngine.ts'

test('RAA engine creations never overlap, and a failed one releases the next', async () => {
  const queue = oneAtATime()
  let running = 0
  let most = 0
  const order: string[] = []
  const work = (name: string, fail = false) => async () => {
    running++
    most = Math.max(most, running)
    await new Promise(done => setTimeout(done, 5))
    running--
    order.push(name)
    if (fail) throw new Error(name)
    return name
  }
  const results = await Promise.allSettled([queue(work('a')), queue(work('b', true)), queue(work('c'))])
  assert.equal(most, 1)
  assert.deepEqual(order, ['a', 'b', 'c'])
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'fulfilled'])
})
