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
