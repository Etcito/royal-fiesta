import { CONTROL_NO_CELL } from '@gamesaloon/rollback/zones'

interface CellGrid {
  origin: [number, number]
  cell: [number, number]
  cols: number
  rows: number
}

/** Cell id of a world point, or CONTROL_NO_CELL outside the grid. */
export function cellOf(grid: CellGrid, x: number, z: number): number {
  const col = Math.floor((x - grid.origin[0]) / grid.cell[0])
  const row = Math.floor((z - grid.origin[1]) / grid.cell[1])
  if (!(col >= 0) || !(row >= 0) || col >= grid.cols || row >= grid.rows) return CONTROL_NO_CELL
  return row * grid.cols + col
}

/** Chebyshev distance between two cells, or CONTROL_NO_CELL when either has none. */
export function cellDistance(grid: CellGrid, a: number, b: number): number {
  if (a === CONTROL_NO_CELL || b === CONTROL_NO_CELL) return CONTROL_NO_CELL
  const aRow = Math.floor(a / grid.cols)
  const aCol = a % grid.cols
  const bRow = Math.floor(b / grid.cols)
  const bCol = b % grid.cols
  return Math.max(Math.abs(aRow - bRow), Math.abs(aCol - bCol))
}

/** Cell id of a world point clamped to the grid's edge cells, or CONTROL_NO_CELL for a non-finite point. */
export function clampedCellOf(grid: CellGrid, x: number, z: number): number {
  if (!Number.isFinite(x) || !Number.isFinite(z)) return CONTROL_NO_CELL
  const col = Math.min(grid.cols - 1, Math.max(0, Math.floor((x - grid.origin[0]) / grid.cell[0])))
  const row = Math.min(grid.rows - 1, Math.max(0, Math.floor((z - grid.origin[1]) / grid.cell[1])))
  return row * grid.cols + col
}
