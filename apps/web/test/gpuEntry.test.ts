import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { runInNewContext } from 'node:vm'
import ts from 'typescript'

test('game page registers check ops before loading game dependencies', async () => {
  const html = readFileSync(new URL('../game.html', import.meta.url), 'utf8')
  assert.match(html, /src="\/src\/game\/entry\.ts"/)
  const source = readFileSync(new URL('../src/game/entry.ts', import.meta.url), 'utf8')
  const compiled = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })
    .replace("import('./main.ts')", 'loadGame()')
    .replace(/export \{\};?/, '')
  const page: { nmcGpu?: { ops: Record<string, (input: unknown) => Promise<unknown>> } } = {}
  const failure = new Error('dependency failed')
  let loaded = false
  runInNewContext(compiled, {
    window: page,
    console: { error() {} },
    loadGame: () => {
      loaded = true
      for (const name of ['countdowns', 'lobbyUnload', 'wardrobe', 'vote']) {
        assert.equal(typeof page.nmcGpu?.ops[name], 'function', name)
      }
      return Promise.reject(failure)
    },
  })
  assert.equal(loaded, true)
  await assert.rejects(page.nmcGpu!.ops.countdowns({}), failure)
})

// The GPU page's DOMContentLoaded scripts (animBrick needs gameCapture, a render transport calls flowTour)
// run before the game's dynamic import finishes: every declared op must already exist then, and stay
// callable after the game installs its ops.
test('game page declares every manifest op before the game loads; the game install keeps other ops', async () => {
  const manifest = JSON.parse(readFileSync(new URL('../public/nmc.gpu.json', import.meta.url), 'utf8')) as { ops: string[] }
  const source = readFileSync(new URL('../src/game/entry.ts', import.meta.url), 'utf8')
  const compiled = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext })
    .replace("import('./main.ts')", 'loadGame()')
    .replace(/export \{\};?/, '')
  type Op = (...args: unknown[]) => Promise<unknown>
  const page: { nmcGpu?: { ops: Record<string, Op> } } = {}
  let finish!: () => void
  runInNewContext(compiled, {
    window: page, console: { error() {} },
    loadGame: () => new Promise<void>(resolve => { finish = resolve }),
  })
  // frameTiming is a client-page op: the game page deletes it.
  for (const name of manifest.ops.filter(name => name !== 'frameTiming')) {
    assert.equal(typeof page.nmcGpu?.ops[name], 'function', name)
  }
  const placeholder = page.nmcGpu!.ops
  placeholder.render = async request => placeholder.flowTour((request as { input: unknown }).input)
  // installNmcOps, then installGameOps' flowTour, as the game does once loaded.
  const nmc = readFileSync(new URL('../src/nmc/ops.ts', import.meta.url), 'utf8')
  const install = /export function installNmcOps\(\): void \{([\s\S]*?)\n\}/.exec(nmc)![1]
  runInNewContext(ts.transpile(install, { target: ts.ScriptTarget.ES2022 }), {
    window: page, roundCapture: async () => 'round', frameTiming: async () => 'frame',
  })
  page.nmcGpu!.ops.flowTour = async input => ({ tour: input })
  page.nmcGpu!.ops.gameCapture = async () => 'captured'
  assert.equal(typeof page.nmcGpu!.ops.render, 'function', 'installNmcOps dropped an op registered before it')
  finish()
  assert.deepEqual(await page.nmcGpu!.ops.render({ input: { width: 4 } }), { tour: { width: 4 } })
  // animBrick keeps the placeholder object it saw at DOMContentLoaded: its gameCapture reaches the game's.
  assert.equal(await placeholder.gameCapture({}), 'captured')
})
