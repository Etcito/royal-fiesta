// Rapier collision groups. Group word = (membership << 16) | filter.
export const G = { STATIC: 0x0001, MOVING: 0x0002, CHAR: 0x0004, DEBRIS: 0x0008, PROBE: 0x0010 } as const

export function groups(membership: number, filter: number): number {
  return ((membership & 0xffff) << 16 | (filter & 0xffff)) >>> 0
}
