import assert from 'node:assert/strict'
import { test } from 'node:test'
import { NO_DRESSING } from '@royal-fiesta/game/content'
import type { ContentProvider, GameContent } from '@royal-fiesta/game/content'
import { NullRenderPort } from '@royal-fiesta/game/render/nullPort'

test('NO_DRESSING resets the environment and creates nothing', async () => {
  const p = new NullRenderPort()
  await p.init({ canvas: null, width: 64, height: 64, viewports: [{ x: 0, y: 0, width: 64, height: 64 }] })
  p.setEnvironment({ sky: 'x' })
  NO_DRESSING.enter(p, 'race-sprint')
  assert.equal(p.lastEnvironment, null)
  NO_DRESSING.leave(p)
  assert.equal(p.calls.createInstance, 0)
})

test('a minimal provider stub typechecks', () => {
  const stub = {
    id: 'v0',
    async load(_profile, onProgress) { onProgress({ phase: 'done', done: 1, total: 1, label: 'ok' }) },
    playlist: () => [],
    course() { throw new Error('none') },
    hub() { throw new Error('none') },
    podium() { throw new Error('none') },
    assets() { throw new Error('none') },
    character() { throw new Error('none') },
    async createPort() { return new NullRenderPort() },
    dressing: () => NO_DRESSING,
    report: () => ({})
  } satisfies GameContent
  const provider: ContentProvider = { id: 'v0', priority: 0, create: () => stub }
  assert.equal(provider.create().id, 'v0')
})
