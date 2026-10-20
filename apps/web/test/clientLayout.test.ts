// Headless checks for the client page's canvas plan and query defaults. The RAA port is faked:
// the fake refuses more than one viewport per canvas, as RaaRenderPort does.
import assert from 'node:assert/strict'
import test from 'node:test'
import type { CameraPose, RenderPort, RenderStats, RenderTarget, Viewport } from '@royal-fiesta/game/render/port'
import { RefusalError } from '@royal-fiesta/sim/refusal'
import { gridSize, initPerClient, planCanvases } from '../src/client/canvases.ts'
import { parseQuery } from '../src/client/query.ts'

class FakePort {
  readonly kind = 'raa' as const
  readonly inits: RenderTarget[] = []
  async init(target: RenderTarget): Promise<void> {
    if (target.viewports.length !== 1) throw new Error(`RAA draws one full-canvas viewport, got ${target.viewports.length}`)
    const [vp] = target.viewports
    if (vp.x !== 0 || vp.y !== 0 || vp.width !== target.width || vp.height !== target.height) throw new Error('viewport must cover the canvas')
    this.inits.push(target)
  }
  registerAsset(): number { return 0 }
  createInstance(): number { return 0 }
  setTransform(): void {}
  setVisible(): void {}
  destroyInstance(): void {}
  setCamera(_v: number, _c: CameraPose): void {}
  render(): RenderStats { return { frameMs: 0, drawCalls: 0, triangles: 0, instances: 0, visible: 0 } }
  async capture(): Promise<Uint8Array | null> { return null }
  dispose(): void {}
}

test('gridSize: 1 client is one cell, 2 are side by side, 3 and 4 are a 2x2 grid', () => {
  assert.deepEqual(gridSize(1), { cols: 1, rows: 1 })
  assert.deepEqual(gridSize(2), { cols: 2, rows: 1 })
  assert.deepEqual(gridSize(3), { cols: 2, rows: 2 })
  assert.deepEqual(gridSize(4), { cols: 2, rows: 2 })
})

test('gridSize refuses 0 and 5 clients', () => {
  assert.throws(() => gridSize(0), RefusalError)
  assert.throws(() => gridSize(5), RefusalError)
})

for (const n of [1, 2, 3, 4]) {
  test(`planCanvases: ${n} clients make ${n} cells, one full-canvas viewport each, inside the window`, () => {
    const plan = planCanvases(1920, 1080, n)
    assert.equal(plan.cells.length, n)
    const slots = new Set<string>()
    for (const cell of plan.cells) {
      assert.equal(cell.client, plan.cells.indexOf(cell))
      assert.equal(cell.col, cell.client % plan.cols)
      assert.equal(cell.row, Math.floor(cell.client / plan.cols))
      assert.ok(!slots.has(`${cell.col},${cell.row}`), 'two clients share a grid slot')
      slots.add(`${cell.col},${cell.row}`)
      assert.deepEqual(cell.viewport, { x: 0, y: 0, width: cell.canvasWidth, height: cell.canvasHeight })
    }
    assert.ok(plan.cols * planCanvases(1920, 1080, n).cells[0].canvasWidth <= 1920)
    assert.ok(plan.rows * plan.cells[0].canvasHeight <= 1080)
  })
}

test('planCanvases: the 4-client grid is 2x2 with 960x540 canvases on a 1920x1080 window', () => {
  const plan = planCanvases(1920, 1080, 4)
  assert.deepEqual([plan.cols, plan.rows], [2, 2])
  assert.deepEqual(plan.cells.map(c => [c.col, c.row]), [[0, 0], [1, 0], [0, 1], [1, 1]])
  assert.deepEqual([plan.cells[3].canvasWidth, plan.cells[3].canvasHeight], [960, 540])
})

for (const n of [1, 2, 3, 4]) {
  test(`initPerClient: ${n} clients create ${n} canvases and ${n} ports, each port gets one viewport on its own canvas`, async () => {
    const plan = planCanvases(1280, 720, n)
    const canvases: object[] = []
    const ports: FakePort[] = []
    const mounted = await initPerClient(
      plan,
      () => { const c = {}; canvases.push(c); return c },
      async () => { const p = new FakePort(); ports.push(p); return p as unknown as RenderPort },
    )
    assert.equal(canvases.length, n)
    assert.equal(new Set(canvases).size, n, 'each client gets its own canvas')
    assert.equal(ports.length, n, 'each client gets its own port')
    assert.equal(new Set(ports).size, n)
    for (let k = 0; k < n; k++) {
      assert.equal(mounted[k].canvas, canvases[k])
      assert.equal(ports[k].inits.length, 1)
      const [init] = ports[k].inits
      assert.equal(init.canvas, canvases[k])
      assert.equal(init.viewports.length, 1)
      const vp: Viewport = init.viewports[0]
      assert.deepEqual(vp, { x: 0, y: 0, width: init.width, height: init.height })
    }
  })
}

test('a port refuses a viewport that is not the one full-canvas viewport (the RAA rule)', async () => {
  const port = new FakePort()
  const target = { canvas: {}, width: 800, height: 600, viewports: [{ x: 0, y: 0, width: 400, height: 600 }, { x: 400, y: 0, width: 400, height: 600 }] }
  await assert.rejects(port.init(target), /one full-canvas viewport/)
  await assert.rejects(port.init({ ...target, viewports: [{ x: 0, y: 0, width: 400, height: 600 }] }), /cover the canvas/)
  assert.equal(port.inits.length, 0)
})

test('parseQuery: the default is one client; ?clients=2..4 opts into the in-page grid', () => {
  assert.equal(parseQuery('').clients, 1)
  assert.equal(parseQuery('').mode, 'inpage')
  assert.equal(parseQuery('?clients=2').clients, 2)
  assert.equal(parseQuery('?clients=4').clients, 4)
  assert.throws(() => parseQuery('?clients=5'), RefusalError)
  assert.throws(() => parseQuery('?clients=0'), RefusalError)
})

test('parseQuery: networked modes keep their 4-player default', () => {
  assert.equal(parseQuery('?mode=relay&server=ws://h:1/x').clients, 4)
  assert.equal(parseQuery('?mode=webrtc&server=ws://h:1/x&clients=2').clients, 2)
})

test('parseQuery: networked modes need ?server=', () => {
  assert.throws(() => parseQuery('?mode=relay'), RefusalError)
  assert.equal(parseQuery('?mode=relay&server=ws://h:1/x').server, 'ws://h:1/x')
})
