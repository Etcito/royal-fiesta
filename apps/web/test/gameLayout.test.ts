// Layout math of game.html's local canvas (S26): the split cells and the DPR-capped pixel viewports
// main.ts hands port.resize. Layout tests use the DOM-free splitLayout module; the boot regression
// evaluates main.ts with fake browser/render dependencies because its imports include Vite-only modules.
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { runInNewContext } from 'node:vm'
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript'
import { DPR_CAP, pixelViewports, splitLayout } from '@royal-fiesta/game/client/splitLayout'

interface Rect { x: number; y: number; width: number; height: number }

// The canvas backing size a viewport list covers: the union's far edge.
function backing(rects: readonly Rect[]): { width: number; height: number } {
  let width = 0
  let height = 0
  for (const r of rects) {
    width = Math.max(width, r.x + r.width)
    height = Math.max(height, r.y + r.height)
  }
  return { width, height }
}

// Integer, in-bounds rects whose areas sum to the backing: no gap and no overlap.
function assertCovers(rects: readonly Rect[], width: number, height: number): void {
  let area = 0
  for (const r of rects) {
    for (const n of [r.x, r.y, r.width, r.height]) assert.ok(Number.isInteger(n), `rect ${JSON.stringify(r)} has a non-integer edge`)
    assert.ok(r.x >= 0 && r.y >= 0 && r.x + r.width <= width && r.y + r.height <= height, `rect ${JSON.stringify(r)} leaves ${width}x${height}`)
    assert.ok(r.width > 0 && r.height > 0, `rect ${JSON.stringify(r)} is empty`)
    area += r.width * r.height
  }
  assert.equal(area, width * height, 'the rects do not cover the canvas without gaps or overlap')
  assert.deepEqual(backing(rects), { width, height })
}

test('pixelViewports: 1..4 seats cover 1920x1080 at dpr 1', () => {
  for (let seats = 1; seats <= 4; seats++) {
    const cells = splitLayout(seats, seats === 3)
    const rects = pixelViewports(cells, 1920, 1080, 1)
    assert.equal(rects.length, seats < 3 ? seats : 4, `${seats} seats: 1, 2, 4 and 4 rects`)
    assertCovers(rects, 1920, 1080)
  }
})

test('pixelViewports: the DPR is capped at 2', () => {
  assert.equal(DPR_CAP, 2)
  const cells = splitLayout(3, true)
  const cases: readonly (readonly [number, number, number])[] = [[1, 1920, 1080], [2, 3840, 2160], [3, 3840, 2160]]
  for (const [dpr, width, height] of cases) {
    const rects = pixelViewports(cells, 1920, 1080, dpr)
    assertCovers(rects, width, height)
    assert.deepEqual(backing(rects), { width, height }, `dpr ${dpr}`)
  }
})

test('pixelViewports: a resize from 1280x720 to 844x390 at dpr 3 backs at 1688x780', () => {
  const cells = splitLayout(3, true)
  assertCovers(pixelViewports(cells, 1280, 720, 3), 2560, 1440)
  const rects = pixelViewports(cells, 844, 390, 3)
  assert.equal(rects.length, 4)
  assertCovers(rects, 1688, 780)
})

test('local boot finishes pipeline warmup without animation callbacks, before title', async () => {
  // Evaluate the real readiness method with a fake port: the GPU host can withhold rAF even
  // after compilation finishes. The tour's own App steps cannot resolve that callback.
  const source = readFileSync(new URL('../src/game/main.ts', import.meta.url), 'utf8')
  const compiled = transpileModule(source + '\nexports.ready = LocalMode.prototype.ready\n', {
    compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
  }).outputText
  const exports = {} as { ready(this: unknown): Promise<void> }
  let pending = 1
  let animationRequests = 0
  runInNewContext(compiled, {
    exports, URLSearchParams, performance, setTimeout,
    window: { location: { search: '?mode=ops' } },
    requestAnimationFrame: () => { animationRequests++; return 1 },
    require(id: string): unknown {
      if (id === '../render/asyncPipelines.ts') return { pendingPipelines: () => pending }
      if (id === '../content/roundOverlay.ts') return { roundOverlay: () => ({ hide() {} }) }
      if (id === './ops.ts') return { installGameOps() {} }
      if (id.endsWith('.json?raw')) return { default: '{"screens":[]}' }
      return {}
    },
  })
  const calls: string[] = []
  const port = {
    render() { assert.equal(pending, 0); calls.push('render') },
    async capture() { calls.push('capture'); return new Uint8Array([1]) },
  }
  const local = {
    c: { loaded: { ports: [port] }, q: { colour: 0 } },
    prepared: { match: {} }, match: null,
    presenter: { draw() { calls.push('draw round') } },
    hubLayer: { setVisible(on: boolean) { calls.push(`hub ${on}`) } },
    matchLayer: { setVisible(on: boolean) { calls.push(`round ${on}`) } },
    hub: { tick: 0, state() { return {} }, emote() { return 0 } },
    hubView: { update() { calls.push('draw hub') } },
    local: {},
  }
  const ready = exports.ready.call(local)
  assert.deepEqual(calls, [], 'must still wait for compilation')
  // GPU compilation completes independently of animation frames.
  pending = 0
  let deadline: ReturnType<typeof setTimeout> | undefined
  try {
    await Promise.race([
      ready,
      new Promise<never>((_, reject) => {
        deadline = setTimeout(() => reject(new Error('boot still waits for an animation callback after compilation')), 200)
      }),
    ])
  } finally { clearTimeout(deadline) }
  assert.equal(animationRequests, 0)
  assert.deepEqual(calls, [
    'hub false', 'round true', 'draw round', 'render', 'capture',
    'round false', 'hub true', 'draw hub', 'render', 'capture',
  ], 'load can enter title only after the prepared round and hub have rendered and read back')
})
