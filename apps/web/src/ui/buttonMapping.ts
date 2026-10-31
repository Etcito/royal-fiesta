import {
  assetMapping, layoutLine, placeInBox, slotBoxPx,
  type AssetCommand, type AssetMapping, type Rect, type UiAsset, type UiRenderer,
} from '@etcito/uaa'

// A horizontal capsule stretches only between its cap tangencies. Its cap scale
// comes from the available height, never from the UI's fixed pixels-per-metre.
export function capsuleMapping(asset: UiAsset, rect: Rect): AssetMapping {
  const ns = asset.nineSlice!
  const height = asset.frame.max[1] - asset.frame.min[1]
  const scale = Math.min(rect.h / height, rect.w / (ns.l + ns.r))
  const h = height * scale
  return assetMapping(asset.frame, ns, { ...rect, y: rect.y + (rect.h - h) / 2, h }, scale / 1000)
}

export function mapCapsule(command: AssetCommand, screen = '', landscape = false): AssetCommand {
  const ns = command.asset.nineSlice
  if (command.asset.role !== 'button' || ns === null || ns.t !== 0 || ns.b !== 0) return command
  // Reserve room for Back's focus outline and bounce inside the Settings cushion.
  // Only the artwork is inset; the document rectangle and pointer target stay intact.
  const inset = landscape && screen === 'settings' && command.widget === 'back' ? command.rect.h * 0.06 : 0
  const rect = { ...command.rect, y: command.rect.y + inset, h: command.rect.h - 2 * inset }
  const mapping = capsuleMapping(command.asset, rect)
  const slots = command.slots.map(s => {
    const { min, max } = s.slot.box
    const scale = mapping.scaleAt([(min[0] + max[0]) / 2, (min[1] + max[1]) / 2])
    const run = layoutLine(s.placed.run.font, s.text, s.slot.size * scale)
    return { ...s, placed: placeInBox(run, slotBoxPx(mapping, s.slot.box), s.slot.align) }
  })
  return { ...command, mapping, slots }
}

export function withCapsuleButtons(renderer: UiRenderer, screen: () => string = () => ''): UiRenderer {
  return {
    kind: renderer.kind,
    resize: viewport => renderer.resize(viewport),
    render: list => renderer.render({ ...list, commands: list.commands.map(c => c.kind === 'asset'
      ? mapCapsule(c, screen(), list.viewport.width > list.viewport.height) : c) }),
    destroy: () => renderer.destroy(),
  }
}
