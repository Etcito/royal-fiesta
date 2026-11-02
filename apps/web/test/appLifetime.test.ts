import assert from 'node:assert/strict'
import { getEventListeners } from 'node:events'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'

test('disposing an App removes its global errors before destroying its host; late errors reach only the current App', () => {
  const source = readFileSync(new URL('../src/game/main.ts', import.meta.url), 'utf8')
  const compiled = transpileModule(source + '\nexports.watch = App.prototype.observeErrors; exports.dispose = App.prototype.dispose; exports.fail = App.prototype.fail\n', {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText
  const page = Object.assign(new EventTarget(), { location: { search: '?mode=ops' }, origin: 'null' })
  const methods = {} as { watch(this: unknown): void; dispose(this: unknown): void; fail(this: unknown, message: string): void }
  runInNewContext(compiled, {
    exports: methods, window: page, URLSearchParams, performance, console, Error,
    require(id: string): unknown {
      if (id === '../content/roundOverlay.ts') return { roundOverlay: () => ({ hide() {} }) }
      if (id === './ops.ts') return { installGameOps() {} }
      if (id.endsWith('.json?raw')) return { default: '{"screens":[]}' }
      return {}
    },
  })
  const errors = [[], []] as string[][]
  const make = (index: number) => ({
    disposed: false, errorEvents: new AbortController(), fail: (message: string) => errors[index].push(message),
    loadingOverlay: { hide() {} }, stopMode() {}, economyScreens: { close() {} }, economy: { close() {} },
    startView: null, preparedLocal: null, viewsObserver: { disconnect() {} }, closeRemap() {},
    remapButton: { removeEventListener() {}, hidden: false }, remapRoot: { removeEventListener() {} },
    devices: { dispose() {} }, input: { dispose() {} }, sound: { async close() {} }, loaded: null,
    host: { destroy() { assert.equal(getEventListeners(page, 'error').length, index === 0 ? 1 : 0) } },
    views: { replaceChildren() {} }, screens: { replaceChildren() {} },
  })
  const old = make(0), current = make(1)
  methods.watch.call(old)
  methods.watch.call(current)
  assert.equal(getEventListeners(page, 'error').length, 2)
  assert.equal(getEventListeners(page, 'unhandledrejection').length, 2)
  methods.dispose.call(old)
  assert.equal(getEventListeners(page, 'error').length, 1)
  assert.equal(getEventListeners(page, 'unhandledrejection').length, 1)
  page.dispatchEvent(Object.assign(new Event('error'), { error: new Error('current device') }))
  page.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: new Error('current load') }))
  assert.deepEqual(errors, [[], ['current device', 'current load']])
  assert.doesNotThrow(() => methods.fail.call(old, 'abandoned load failed'))
  methods.dispose.call(current)
  assert.equal(getEventListeners(page, 'error').length, 0)
  assert.equal(getEventListeners(page, 'unhandledrejection').length, 0)
})
