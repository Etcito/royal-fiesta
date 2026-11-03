import { assetMapping, type AssetCommand, type UiAsset, type RenderList } from '@etcito/uaa'

const THEMES: Record<string, [string, string, string]> = {
  'wallet.ticket': ['#ffb9ec', '#f72fa0', '#9232b8'],
  'wardrobe.panel': ['#f7d8ff', '#cd8bed', '#842cb3'],
  'wardrobe.card': ['#ffffff', '#e1e8ff', '#8270ca'],
  'wardrobe.focus': ['#fff6b6', '#ffc950', '#f52a96'],
  'wardrobe.backdrop': ['#36d4f2', '#6450d9', '#4a35ad'],
}

function frameAsset(base: UiAsset, id: string, width: number, height: number, scale: number): UiAsset {
  const [top, bottom, rim] = THEMES[id]
  const frame = { min: [0, 0] as [number, number], max: [width, height] as [number, number] }
  const template = base.states.normal.items[0]
  function loop(inset: number, offset: number): Float64Array {
    if (id === 'wallet.ticket') {
      const points = [.02,.04,.18,.04,.18,.08,.16,.1,.18,.12,.18,.16,.02,.16,.02,.12,.04,.1,.02,.08]
      return new Float64Array(points.map((v, i) => i % 2 === 0 ? (v / .2 - .5) * (width - 2 * inset) + width / 2 : (v / .2 - .5) * (height - 2 * inset) + height / 2 + offset))
    }
    const r = Math.max(0, Math.min(.024 * scale, width / 2 - inset, height / 2 - inset))
    const points: number[] = []
    for (const [cx, cy, from] of [[width-inset-r, height-inset-r, 0], [inset+r, height-inset-r, 90], [inset+r, inset+r, 180], [width-inset-r, inset+r, 270]]) {
      for (let i = 0; i <= 8; i++) {
        const angle = (from + i * 90 / 8) * Math.PI / 180
        points.push(cx + Math.cos(angle) * r, cy + Math.sin(angle) * r + offset)
      }
    }
    return new Float64Array(points)
  }
  const layers = [[0, '#43218b', -.006 * scale], [0, rim, 0], [.004 * scale, top, 0]] as const
  const items: RenderList['items'] = layers.map(([inset, color, offset], i) => ({
    ...template, element: `${id}-${i}`, opacity: 1, effects: id === 'wardrobe.backdrop' ? [] : i === 1
      ? [{ kind: 'bevel', width: .004 * scale, angleDeg: 90, highlight: { color: '#ffffff', opacity: .7 }, shadow: { color: '#43218b', opacity: .65 } }]
      : i === 2 ? [{ kind: 'gloss', inset: .006 * scale, extent: .45, color: '#ffffff', opacity: .2 }] : [],
    bounds: { min: [0, offset], max: [width, height + offset] },
    parts: [{ ...template.parts[0], loops: [loop(inset, offset)], paint: i === 2
      ? { kind: 'linear', xf: [1, 0, 0, 1, 0, 0], from: [0, height], to: [0, 0], stops: [{ at: 0, color: top, opacity: 1 }, { at: .45, color: top, opacity: 1 }, { at: 1, color: bottom, opacity: 1 }] }
      : { kind: 'solid', color, opacity: 1 } }],
  }))
  if (id === 'wardrobe.backdrop') {
    // Soft toy bubbles and small glints give the menu depth without competing with its cards.
    for (const [side, y, radius] of [[0, .22, .038], [1, .4, .03], [0, .68, .028], [1, .87, .044]]) {
      const r = radius * scale, cx = side ? width - r - .008 * scale : r + .008 * scale, cy = height * y
      const circle = new Float64Array(Array.from({ length: 65 }, (_, i) => {
        const angle = i * Math.PI * 2 / 64
        return [cx + Math.cos(angle) * r, cy + Math.sin(angle) * r]
      }).flat())
      items.push({ ...template, element: `bubble-${side}-${y}`, opacity: .35, effects: [], bounds: { min: [cx-r, cy-r], max: [cx+r, cy+r] }, parts: [{ loops: [circle], rule: 'evenodd', paint: { kind: 'radial', xf: [1,0,0,1,0,0], center: [cx,cy], focal: [cx-r*.35,cy+r*.35], radius: r, stops: [{at:0,color:'#ffffff',opacity:.7},{at:.7,color:'#c6d5ff',opacity:.05},{at:1,color:'#ffffff',opacity:.5}] } }] })
    }
    for (const side of [0,1]) for (const y of [.18,.5,.8]) {
      const cx = side ? width - .018 * scale : .018 * scale, cy = height * y, r = .006 * scale
      const points = new Float64Array([cx,cy+r,cx+r*.25,cy+r*.25,cx+r,cy,cx+r*.25,cy-r*.25,cx,cy-r,cx-r*.25,cy-r*.25,cx-r,cy,cx-r*.25,cy+r*.25])
      items.push({ ...template, element: `glint-${side}-${y}`, opacity: .75, effects: [], bounds: { min: [cx-r,cy-r], max: [cx+r,cy+r] }, parts: [{loops:[points],rule:'evenodd',paint:{kind:'solid',color:'#ffffff',opacity:1}}] })
    }
  }
  const normal: RenderList = { ...base.states.normal, items, bounds: frame }
  return { ...base, id, hash: `${base.hash}:${id}:${width}:${height}:${scale}:3`, frame, nineSlice: null,
    states: { normal, hover: normal, pressed: normal, disabled: normal, focus: normal } }
}

export function wardrobeAssets(base: UiAsset): UiAsset[] {
  return Object.keys(THEMES).map(id => frameAsset(base, id, .2, .2, 1))
}

const frames = new Map<string, UiAsset>()
// Build each rounded silhouette at its final aspect ratio. Nine-slice inverse mapping
// leaves visible bands across narrow cards; uniform mapping keeps the gradients continuous.
export function mapWardrobe(command: AssetCommand, scale: number): AssetCommand {
  if (!THEMES[command.asset.id]) return command
  const width = Math.round(command.rect.w / scale * 10) / 10000
  const height = Math.round(command.rect.h / scale * 10) / 10000
  const key = `${command.asset.hash}:${command.asset.id}:${width}:${height}`
  let asset = frames.get(key)
  if (!asset) { asset = frameAsset(command.asset, command.asset.id, width, height, 1); if (frames.size >= 128) frames.clear(); frames.set(key, asset) }
  return { ...command, asset, list: asset.states[command.state], mapping: assetMapping(asset.frame, null, command.rect, scale) }
}
