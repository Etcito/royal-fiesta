// Canvas layout for the client page. One canvas per in-page client: each canvas owns one RenderPort
// (one RAA engine) and draws one full-canvas viewport, because RAA has one camera and no scissor
// (docs/brick-gaps.md). The clients are laid out in a CSS grid over the window.
import type { RenderPort, Viewport } from '@royal-fiesta/game/render/port'
import { refuse } from '@royal-fiesta/sim/refusal'

export interface ClientCell {
  client: number
  col: number
  row: number
  // Pixel size of this client's canvas (the canvas width and height attributes).
  canvasWidth: number
  canvasHeight: number
  // Always the one full-canvas viewport of this client's own canvas.
  viewport: Viewport
}

export interface CanvasPlan {
  cols: number
  rows: number
  cells: ClientCell[]
}

// 1 client: one cell. 2 clients: side by side. 3 or 4 clients: a 2x2 grid.
export function gridSize(count: number): { cols: number; rows: number } {
  if (!Number.isInteger(count) || count < 1 || count > 4) refuse('client', 'canvases', `${count} is outside 1..4; the client page lays out 1 to 4 clients`)
  const cols = count <= 2 ? count : 2
  return { cols, rows: Math.ceil(count / cols) }
}

export function planCanvases(width: number, height: number, count: number): CanvasPlan {
  const { cols, rows } = gridSize(count)
  const cw = Math.max(1, Math.floor(width / cols))
  const ch = Math.max(1, Math.floor(height / rows))
  const cells: ClientCell[] = []
  for (let k = 0; k < count; k++) {
    const col = k % cols
    const row = Math.floor(k / cols)
    cells.push({ client: k, col, row, canvasWidth: cw, canvasHeight: ch, viewport: { x: 0, y: 0, width: cw, height: ch } })
  }
  return { cols, rows, cells }
}

export interface MountedClient { canvas: unknown; port: RenderPort }

// Creates one canvas and one port per cell, and initialises each port on its own canvas with its
// single full-canvas viewport. The caller mounts the canvas (mount) and builds the port (makePort).
export async function initPerClient(
  plan: CanvasPlan,
  mount: (cell: ClientCell) => unknown,
  makePort: (cell: ClientCell) => Promise<RenderPort>,
): Promise<MountedClient[]> {
  const out: MountedClient[] = []
  for (const cell of plan.cells) {
    const canvas = mount(cell)
    const port = await makePort(cell)
    await port.init({ canvas, width: cell.canvasWidth, height: cell.canvasHeight, viewports: [cell.viewport] })
    out.push({ canvas, port })
  }
  return out
}
