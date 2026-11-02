import { cosmeticOf } from '@royal-fiesta/game/flow/startScreen'
import type { StartScreenModel } from '@royal-fiesta/game/flow/startScreen'
import type { WornLook } from '@royal-fiesta/game/render/wornLook'
import type { StartArt } from '../screens/startScreen.ts'

export function playerLook(model: StartScreenModel | null, art: Pick<StartArt, 'mounts' | 'costume'> | null): WornLook | null {
  if (model === null || art === null) return null
  const items: WornLook['items'][number][] = []
  for (const bin of model.bins) {
    const id = bin.items[bin.selected]
    if (id === undefined) continue
    const mount = art.mounts.get(id), asset = art.costume(id)
    if (mount !== undefined && asset !== null) items.push({ asset, mount, tint: cosmeticOf(id)?.tint ?? null })
  }
  return { colour: model.colour, items }
}
