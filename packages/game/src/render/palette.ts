export const PALETTE: readonly (readonly [number, number, number])[] = [
  [1, 0.42, 0.62],
  [0.33, 0.73, 1],
  [1, 0.82, 0.25],
  [0.45, 0.85, 0.4],
  [0.7, 0.5, 1],
  [1, 0.55, 0.25],
  [0.3, 0.9, 0.85],
  [0.95, 0.95, 0.95],
]

export const PALETTE_NAMES: readonly string[] = ['pink', 'sky', 'yellow', 'green', 'purple', 'orange', 'teal', 'white']

/** The tint of one seat. Seats beyond the palette (zoned matches exceed 8) wrap through it. */
export function seatTint(seat: number): readonly [number, number, number] {
  const n = PALETTE.length
  return PALETTE[((Math.trunc(seat) % n) + n) % n]
}
