import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { assetMapping, parseUiAssetText, type AssetCommand } from '@etcito/uaa'
import { mapWardrobe, wardrobeAssets } from '../src/ui/wardrobeAssets.ts'

test('wardrobe frames keep continuous mapping and reuse geometry across viewport scales', () => {
  const base = parseUiAssetText(readFileSync(new URL('../../../ui/panel.card.ui.json', import.meta.url), 'utf8'))
  const asset = wardrobeAssets(base).find(a => a.id === 'wardrobe.card')!
  function command(scale: number): AssetCommand {
    const rect = { x: 12, y: 24, w: 344 * scale, h: 126 * scale }
    return { kind: 'asset', widget: 'catalog-card-0-0', asset, state: 'normal', list: asset.states.normal,
      rect, mapping: assetMapping(asset.frame, asset.nineSlice, rect, scale), slots: [],
      opacity: 1, transform: [1, 0, 0, 1, 0, 0], clip: null }
  }
  const desktop = mapWardrobe(command(1), 1)
  const phone = mapWardrobe(command(13 / 24), 13 / 24)
  assert.equal(phone.asset, desktop.asset, 'resizing must not allocate another GPU field for the same design rectangle')
  assert.equal(phone.mapping.uniform, true, 'narrow cards must not have nine-slice seams')
  assert.deepEqual(phone.mapping.toPx(phone.asset.frame.min), [12, 24 + 126 * 13 / 24])
  assert.equal(phone.asset.nineSlice, null)
})
