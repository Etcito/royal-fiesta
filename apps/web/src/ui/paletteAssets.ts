import type { UiAsset, RenderList } from '@etcito/uaa'
import { PALETTE } from '@royal-fiesta/game/render/palette'

// Reuse the badge's circle geometry, with the actual character tints rather
// than its coin artwork. Each colour needs a distinct renderer cache key.
export function paletteAssets(badge: UiAsset): UiAsset[] {
  return PALETTE.map((rgb, index) => {
    const color = `#${rgb.map(c => Math.round(c * 255).toString(16).padStart(2, '0')).join('')}`
    const normal: RenderList = {
      ...badge.states.normal,
      items: badge.states.normal.items.filter(item => item.element === 'rim' || item.element === 'body').map(item => ({
        ...item, effects: [],
        parts: item.parts.map(part => ({ ...part, paint: {
          kind: 'solid', color: item.element === 'rim' ? '#3a1757' : color, opacity: 1,
        } })),
      })),
    }
    return { ...badge, id: `palette.${index}`, hash: `${badge.hash}:${color}`,
      states: { normal, hover: normal, pressed: normal, disabled: normal, focus: normal } }
  })
}
