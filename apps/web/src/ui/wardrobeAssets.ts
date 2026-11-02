import type { UiAsset, RenderList } from '@etcito/uaa'

// Small corner radii keep thumbnail cards rectangular at phone sizes. The shared
// gold panel has 140px corners, which would consume a whole thumbnail card.
export function wardrobeAssets(base: UiAsset): UiAsset[] {
  const frame = { min: [0, 0] as [number, number], max: [.2, .2] as [number, number] }
  function round(inset: number, yOffset = 0): number[] {
    const lo = inset, hi = .2-inset, r = .014
    const points: number[] = []
    for (const [cx, cy, from] of [[hi-r, hi-r, 0], [lo+r, hi-r, 90], [lo+r, lo+r, 180], [hi-r, lo+r, 270]]) {
      for (let i = 0; i <= 8; i++) { const a = (from+i*90/8)*Math.PI/180; points.push(cx+Math.cos(a)*r, cy+Math.sin(a)*r+yOffset) }
    }
    return points
  }
  return [
    ['wardrobe.panel', '#d9b8f4', '#663682'],
    ['wardrobe.card', '#fff9ff', '#9d78bd'],
    ['wardrobe.focus', '#ffe579', '#ed3091'],
    ['wardrobe.backdrop', '#70d0eb', '#3f8ecc'],
  ].map(([id, fill, rim]) => {
    const template = base.states.normal.items[0]
    const items = [[0, '#573268', -.007], [0, rim, 0], [.004, fill, 0], [.007, '#ffffff', .002]].map(([inset, color, offset], i) => ({
      ...template, element: `${id}-${i}`, opacity: i === 3 ? .22 : 1, effects: [], bounds: frame,
      parts: [{ ...template.parts[0], loops: [new Float64Array(round(Number(inset), Number(offset)))], paint: { kind: 'solid' as const, color: String(color), opacity: 1 } }],
    }))
    const normal: RenderList = { ...base.states.normal, items }
    return { ...base, id, hash: `${base.hash}:${id}:1`, frame, nineSlice: { l: .02, r: .02, t: .02, b: .02 }, textSlots: [],
      states: { normal, hover: normal, pressed: normal, disabled: normal, focus: normal } }
  })
}
