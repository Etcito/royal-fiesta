import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'
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
      for (const name of ['countdowns', 'lobbyUnload', 'wardrobe', 'vote', 'm13Flow', 'shopEconomy', 'cameraLook']) {
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

// The whole page registration chain, in the game's order: the entry's placeholders, installNmcOps (additive),
// then installCheckOps with every check module. The placeholders are not duplicates: a call made on one before
// the game loaded reaches the check (the GPU wardrobe run failed on 'Duplicate check op: countdowns').
test('check ops replace the entry placeholders; a placeholder call reaches the check', async () => {
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
  // tools/chromeCheck.ts's adapter script, injected after the bundle: it wraps the wardrobe placeholder at once.
  const harness = readFileSync(new URL('../../../tools/chromeCheck.ts', import.meta.url), 'utf8')
  const adapter = /<script type="module" \$\{ADAPTER_MARK\}>([\s\S]*?)<\/script>`/.exec(harness)![1]
    .replace('${JSON.stringify(op)}', '"wardrobe"')
  const gpuAdapter = { info: { vendor: 'test', architecture: '', description: '' } }
  runInNewContext(adapter, {
    window: page, navigator: { gpu: { requestAdapter: async () => gpuAdapter } }, setInterval, clearInterval,
  })
  const placeholder = page.nmcGpu!.ops
  assert.equal((placeholder.wardrobe as unknown as { nmcCheckAdapter?: boolean }).nmcCheckAdapter, true)
  const pending = placeholder.wardrobe({ items: 1 }) as Promise<{ json: Record<string, unknown> }>
  const nmc = readFileSync(new URL('../src/nmc/ops.ts', import.meta.url), 'utf8')
  const install = /export function installNmcOps\(\): void \{([\s\S]*?)\n\}/.exec(nmc)![1]
  runInNewContext(ts.transpile(install, { target: ts.ScriptTarget.ES2022 }), {
    window: page, roundCapture: async () => 'round', frameTiming: async () => 'frame',
  })
  const checks = readdirSync(new URL('../src/game/checks/', import.meta.url))
    .filter(file => file.endsWith('.ts'))
    .map(file => {
      const found = /export const name = '(\w+)'/.exec(readFileSync(new URL(`../src/game/checks/${file}`, import.meta.url), 'utf8'))
      assert.ok(found, `checks/${file} exports no op name: helpers belong in src/game/checkSupport/`)
      const name = found[1]
      return { name, run: async (input: unknown) => ({ json: { name, input }, files: [] }) }
    })
  const ops = readFileSync(new URL('../src/game/checkOps.ts', import.meta.url), 'utf8')
  const installChecks = /export function installCheckOps\(.*\): void \{([\s\S]*?)\n\}/.exec(ops)![1]
    .replace(/import\.meta\.glob<CheckModule>\([^)]*\)/, 'checks')
  let taken = 0
  runInNewContext(ts.transpile(installChecks, { target: ts.ScriptTarget.ES2022 }), {
    window: page, checks, take: () => { taken++ }, bootGame: () => {}, adapterInfo: async () => ({}), Object, Set, Error,
  })
  assert.ok(checks.some(check => check.name === 'settingsPages'), 'settingsPages check module')
  // Every check op has an entry placeholder from the first script on: the GPU client looks the op up at page
  // load and refused settingsPages with 'Render operation unavailable' (run 12334) while it was missing here.
  for (const { name } of checks) {
    assert.equal((placeholder[name] as unknown as { pending?: boolean } | undefined)?.pending, true, `entry.ts placeholder for check ${name}`)
  }
  finish()
  const result = await pending
  assert.equal(result.json.name, 'wardrobe')
  assert.deepEqual({ ...(result.json.input as object) }, { items: 1 })
  assert.equal((result.json.adapter as { vendor: string }).vendor, 'test')
  assert.equal(taken, 1)
  // A real duplicate (an op already installed by the game) still throws.
  page.nmcGpu!.ops.extra = async () => 'x'
  const extra = [{ name: 'extra', run: async () => ({ json: null, files: [] }) }]
  assert.throws(() => runInNewContext(ts.transpile(installChecks, { target: ts.ScriptTarget.ES2022 }), {
    window: page, checks: extra, take() {}, bootGame() {}, adapterInfo: async () => ({}), Object, Set, Error,
  }), /Duplicate check op: extra/)
  // A helper module in checks/ (no name) is refused with its file, never read as a duplicate op `undefined`.
  assert.throws(() => runInNewContext(ts.transpile(installChecks, { target: ts.ScriptTarget.ES2022 }), {
    window: page, checks: { './checks/settingsTabs.ts': { focusTab() {} } }, take() {}, bootGame() {}, adapterInfo: async () => ({}), Object, Set, Error,
  }), /checks\/settingsTabs\.ts is in checks\/ but exports no op name/)
})

// GPU countdowns run (card 6541): brickBoot threw 'animBrick requires the game page operations' at
// DOMContentLoaded, before the game's dynamic import had installed gameCapture, and no check op ever ran.
// Loading brickBoot never throws; only an animBrick call refuses, and once the game is in it reaches gameCapture.
test('brickBoot registers animBrick at boot without the game ops; only a call refuses', async () => {
  const source = readFileSync(new URL('../src/anim/brickBoot.ts', import.meta.url), 'utf8')
  const compiled = ts.transpile(source, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS })
  type Op = (input: unknown) => Promise<{ json: Record<string, unknown> }>
  const page: { nmcGpu?: { ops: Record<string, Op> } } = { nmcGpu: { ops: {} } }
  const listeners: (() => void)[] = []
  const brick = { brickInfo: () => ({ id: 'b' }), selftest: () => ({ ok: true }) }
  runInNewContext(compiled, {
    window: page, console, exports: {}, Object,
    document: { readyState: 'loading', addEventListener: (_: string, f: () => void) => listeners.push(f) },
    require: () => ({ loadAnimBrick: async () => brick }),
  })
  assert.doesNotThrow(() => listeners.forEach(f => f()))
  const placeholder = page.nmcGpu!.ops
  assert.equal(typeof placeholder.animBrick, 'function')
  await assert.rejects(placeholder.animBrick({}), /animBrick requires the game page operations/)
  placeholder.gameCapture = async () => ({ json: { captures: [{ nonEmpty: true }] } })
  const result = await placeholder.animBrick({})
  assert.equal(result.json.nonEmpty, true)
  assert.deepEqual(result.json.brickInfo, { id: 'b' })
})
