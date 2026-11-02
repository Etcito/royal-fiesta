import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { BOOT_REFUSAL, run } from '../../apps/web/src/game/checks/boot.ts'
import type { TourDeps, TourGame } from '../../apps/web/src/game/uiTour.ts'
import { DEFAULT_GPU_WAIT_S, exitCode, gpuWaitSeconds, makeReport, prepareGpuCopy, takeCheckDiagnostics } from '../chromeCheck.ts'

test('checkBoot clicks Retry after the deliberate refusal and reaches loading then start', async () => {
  const old = { requestAnimationFrame: globalThis.requestAnimationFrame, window: globalThis.window, MouseEvent: globalThis.MouseEvent, PointerEvent: globalThis.PointerEvent }
  Object.assign(globalThis, { requestAnimationFrame: (callback: () => void) => { queueMicrotask(callback); return 0 }, window: {}, MouseEvent: Event, PointerEvent: Event })
  let disposed = false
  let clicked = false
  try {
    const deps = { boot: async onScreen => {
      let screen = 'error'
      let frames = 0
      console.error(`[error-screen] ${BOOT_REFUSAL}`)
      onScreen({ from: null, to: screen })
      return {
        host: { widgetRect: () => ({ x: 0, y: 0, w: 100, h: 30 }) },
        ui: { getBoundingClientRect: () => ({ left: 0, top: 0 }), dispatchEvent: (e: Event) => { if (e.type === 'click') clicked = true } },
        step: (dt: number) => {
          assert.equal(dt, 1 / 60)
          assert.equal(clicked, true)
          if (++frames === 1) return // Retry can take another frame to leave error.
          const next = screen === 'error' ? 'loading' : 'start'
          onScreen({ from: screen, to: next }); screen = next
        },
        dispose: () => { disposed = true },
      } as unknown as TourGame
    } } as TourDeps
    const result = await run({}, deps)
    assert.deepEqual(result.json, { ok: true, screen: 'start', transitions: ['error', 'loading', 'start'] })
    assert.equal(disposed, true)
  } finally { Object.assign(globalThis, old) }
})

test('checkBoot preserves an unexpected boot error and does not retry', async () => {
  const result = await run({}, { boot: async onScreen => {
    console.error('[error-screen] content failed')
    onScreen({ from: null, to: 'error' })
    return { dispose() {}, step() { assert.fail('must not retry') } } as unknown as TourGame
  } } as TourDeps)
  assert.equal(result.json.ok, false)
  assert.equal(result.json.error, 'content failed')
})

test('checkBoot boots straight to start with no error when the refusal is not armed', async () => {
  const old = { requestAnimationFrame: globalThis.requestAnimationFrame }
  Object.assign(globalThis, { requestAnimationFrame: (callback: () => void) => { queueMicrotask(callback); return 0 } })
  const errors: unknown[][] = []
  const log = console.error
  console.error = (...args: unknown[]) => { errors.push(args); log.apply(console, args) }
  try {
    const deps = { boot: async (onScreen, options) => {
      assert.equal(options, undefined, 'a check op must not pass boot options')
      let screen = 'loading'
      let frames = 0
      onScreen({ from: null, to: screen })
      return {
        host: { widgetRect: () => null },
        ui: { getBoundingClientRect: () => ({ left: 0, top: 0 }), dispatchEvent: () => assert.fail('must not click Retry') },
        step: () => { if (++frames === 2) { onScreen({ from: screen, to: 'start' }); screen = 'start' } },
        dispose() {},
      } as unknown as TourGame
    } } as TourDeps
    const result = await run({}, deps)
    assert.deepEqual(result.json, { ok: true, screen: 'start', transitions: ['loading', 'start'] })
    assert.equal(errors.length, 0, 'the direct boot logs no error screen')
  } finally { Object.assign(globalThis, old); console.error = log }
})

test('only the uiTour runner arms refuseFirstLoad; every check op boots directly', () => {
  const load = (path: string): string => readFileSync(new URL(path, import.meta.url), 'utf8')
  const tour = load('../../apps/web/src/game/uiTour.ts')
  assert.equal((tour.match(/refuseFirstLoad\s*:\s*true/g) ?? []).length, 1)
  for (const name of ['boot', 'countdowns', 'lobbyUnload', 'vote', 'wardrobe']) {
    assert.doesNotMatch(load(`../../apps/web/src/game/checks/${name}.ts`), /refuseFirstLoad/)
  }
})

test('the GPU wait defaults to 900 s and rejects invalid values', () => {
  assert.equal(gpuWaitSeconds(undefined), DEFAULT_GPU_WAIT_S)
  assert.equal(gpuWaitSeconds(''), 900)
  assert.equal(gpuWaitSeconds('600'), 600)
  assert.throws(() => gpuWaitSeconds('0'))
  assert.throws(() => gpuWaitSeconds('soon'))
})

test('prepareGpuCopy appends the op in the copy, leaves the source, and applies test=1', () => {
  const root = mkdtempSync(join(tmpdir(), 'chrome-check-copy-'))
  const source = join(root, 'dist')
  const target = join(root, 'scratch')
  mkdirSync(join(source, 'assets'), { recursive: true })
  const manifest = `${JSON.stringify({ page: 'game.html', ops: ['lobbyUnload'] }, null, 2)}\n`
  const html = '<!doctype html><html><body><script type="module" crossorigin src="./assets/index-abc.js"></script></body></html>'
  writeFileSync(join(source, 'nmc.gpu.json'), manifest)
  writeFileSync(join(source, 'game.html'), html)
  writeFileSync(join(source, 'assets', 'index-abc.js'), '// bundle\n')
  try {
    prepareGpuCopy(source, 'wardrobe', target)
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'nmc.gpu.json'), 'utf8')), { page: 'game.html', ops: ['lobbyUnload', 'wardrobe'] })
    assert.equal(readFileSync(join(source, 'nmc.gpu.json'), 'utf8'), manifest, 'the source manifest is untouched')
    assert.equal(readFileSync(join(source, 'game.html'), 'utf8'), html, 'the source page is untouched')
    const copied = readFileSync(join(target, 'game.html'), 'utf8')
    assert.match(copied, /url\.searchParams\.set\("test", "1"\)/)
    assert.match(copied, /history\.replaceState\(null, "", url\.pathname \+ url\.search \+ url\.hash\)/)
    assert.match(copied, /nmcCheckAdapter/)
    assert.match(copied, /window\.__nmcCheck/)
    assert.match(copied, /addEventListener\("error"/)
    const query = copied.indexOf('data-nmc-test-query')
    const bundle = copied.indexOf('./assets/index-abc.js')
    assert.ok(query >= 0 && query < bundle, 'the test query must run before the game bundle')
    assert.match(readFileSync(join(target, 'assets', 'index-abc.js'), 'utf8'), /bundle/)
    assert.deepEqual(JSON.parse(readFileSync(join(target, 'rf-build.json'), 'utf8')), { commit: null, builtAt: 'dev' })
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('--software labels the report software:true and always fails wardrobe, vote and countdowns', () => {
  for (const op of ['wardrobe', 'vote', 'countdowns']) {
    const report = makeReport({ ok: true }, 'software')
    assert.equal(report.software, true)
    assert.equal(report.adapter, null)
    assert.equal(exitCode(op, report, 'software'), 1, `${op} must never pass on SwiftShader`)
  }
  const lobby = makeReport({ ok: true }, 'software')
  assert.equal(lobby.software, true)
  assert.equal(exitCode('lobbyUnload', lobby, 'software'), 0)
})

test('the GPU report carries page errors, console errors and failed requests from the copied page', () => {
  const hardware = { vendor: 'nvidia', architecture: 'ampere', description: '', software: false }
  const checked = takeCheckDiagnostics({ ok: true, adapter: hardware, software: false,
    chromeCheck: { pageErrors: ['boom'], consoleErrors: ['[error-screen] refused'], failedRequests: ['https://example.invalid/a.js HTTP 404'] } })
  assert.deepEqual(checked.json, { ok: true, adapter: hardware, software: false })
  const report = makeReport(checked.json, 'gpu', checked.failures)
  assert.deepEqual(report.pageErrors, ['boom'])
  assert.deepEqual(report.consoleErrors, ['[error-screen] refused'])
  assert.deepEqual(report.failedRequests, ['https://example.invalid/a.js HTTP 404'])
  assert.equal(exitCode('checkBoot', report, 'gpu'), 1, 'a page error fails the op')
  const failed = takeCheckDiagnostics({ ok: true, adapter: hardware, software: false,
    chromeCheck: { pageErrors: [], consoleErrors: [], failedRequests: ['game.wasm HTTP 404'] } })
  assert.equal(exitCode('checkBoot', makeReport(failed.json, 'gpu', failed.failures), 'gpu'), 1, 'a failed request fails the op')
  const clean = takeCheckDiagnostics({ ok: true, adapter: hardware, software: false,
    chromeCheck: { pageErrors: [], consoleErrors: [], failedRequests: [] } })
  assert.equal(exitCode('checkBoot', makeReport(clean.json, 'gpu', clean.failures), 'gpu'), 0)
  assert.deepEqual(takeCheckDiagnostics({ ok: true }).failures, {}, 'an op outside the copy keeps its json')
})

test('the GPU route fails on a software adapter and on a missing adapter', () => {
  const hardware = makeReport({ ok: true, adapter: { vendor: 'nvidia', architecture: 'ampere', description: '', software: false }, software: false }, 'gpu')
  assert.equal(exitCode('wardrobe', hardware, 'gpu'), 0)
  const software = makeReport({ ok: true, adapter: { vendor: 'Google', architecture: 'SwiftShader', description: '', software: true }, software: true }, 'gpu')
  assert.equal(exitCode('wardrobe', software, 'gpu'), 1)
  assert.equal(exitCode('wardrobe', makeReport({ ok: true }, 'gpu'), 'gpu'), 1, 'an unproven adapter cannot pass')
})
