import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { saveLevelThumbnails } from '../levelThumbs.ts'
const root = fileURLToPath(new URL('../../', import.meta.url))

test('regeneration re-saves each built course sequentially, with no supplied image or cache', async () => {
  const calls: { name: string; input: unknown }[] = []
  let closed = false
  await saveLevelThumbnails(root, undefined, async () => ({
    async call(name, input) {
      calls.push({ name, input })
      return { data: { thumbnail: { path: 'courses/saved.thumb.avif' } } }
    },
    async close() { closed = true },
  }))
  assert.equal(calls.length, 18)
  for (let i = 0; i < calls.length; i += 2) {
    assert.equal(calls[i].name, 'course_open')
    assert.deepEqual(calls[i + 1], { name: 'course_save', input: {} })
  }
  assert.equal(closed, true)
})

test('failed thumbnail save names the course and closes the client', async () => {
  let closed = false
  await assert.rejects(saveLevelThumbnails(root, 'I', async () => ({
    async call() { return { data: { thumbnail: { error: 'GPU unavailable' } } } },
    async close() { closed = true },
  })), /s1-i-honeycomb-heights: GPU unavailable/)
  assert.equal(closed, true)
})
