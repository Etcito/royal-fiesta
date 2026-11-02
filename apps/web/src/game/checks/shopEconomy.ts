// Real offline starter wallet -> shop confirmation -> purchased variant in its wardrobe bin.
import type { TourDeps, TourGame } from '../uiTour.ts'
import type { WidgetProps } from '../../ui/screenMap.ts'
import { checkBoot, nextTask } from './boot.ts'
import { cosmeticName } from '@royal-fiesta/game/flow/startScreen'

export const name = 'shopEconomy'
const SLOTS = ['head', 'body', 'bottom', 'special'] as const
const BASES = ['propeller-hat', 'pineapple-suit', 'fish-scarf', 'sparkler-wand']

export async function run(_input: unknown, deps: TourDeps) {
  let game: TourGame | null = null
  const failures: string[] = []
  const purchases: string[] = []
  let props: Record<string, WidgetProps> = {}
  try {
    const boot = await checkBoot({ ...deps, boot: (onScreen, options) => deps.boot(onScreen, { ...options, starterInventory: true }) })
    game = boot.game
    if (!boot.json.ok) throw new Error(`boot failed: ${JSON.stringify(boot.json)}`)
    const live = game
    const original = live.host.setHud
    live.host.setHud = values => { props = values; original.call(live.host, values) }
    const step = async () => { live.step(1 / 60); await nextTask() }
    const until = async (predicate: () => boolean, message: string) => {
      const end = Date.now() + 10000
      while (!predicate()) {
        if (Date.now() > end) throw new Error(message)
        await step()
      }
    }
    const press = async (key: string) => {
      const event = { code: key, key, bubbles: true, cancelable: true }
      window.dispatchEvent(new KeyboardEvent('keydown', event))
      window.dispatchEvent(new KeyboardEvent('keyup', event))
      await step(); await step()
    }
    const text = (id: string) => String(props[id]?.text ?? '')
    await step()
    for (let slot = 0; slot < 4; slot++) {
      // Each return refreshes the start model with focus on its first bin.
      for (let i = 0; i < 6; i++) await press('ArrowDown')
      await press('Enter')
      await until(() => live.host.currentScreen() === 'shop' && text('line-0').includes('Coins'), 'shop did not load')
      if (!text('line-0').includes(`Coins ${500 - slot * 30} · Tickets 20`)) throw new Error(`wallet mismatch: ${text('line-0')}`)
      for (let i = 0; i < slot; i++) await press('ArrowDown')
      await press('ArrowRight')
      const id = `costume.${BASES[slot]}.rose`
      if (!text(`line-${slot + 1}`).includes('Rose') || text(`line-${slot + 1}`).includes('OWNED')) throw new Error(`variant not for sale: ${text(`line-${slot + 1}`)}`)
      await press('Enter')
      await until(() => text(`line-${slot + 1}`).includes('OWNED'), `purchase failed: ${id}`)
      if (!text('line-0').includes(`Coins ${470 - slot * 30} · Tickets 20`)) throw new Error('purchase debit mismatch')
      await press('Escape')
      await until(() => live.host.currentScreen() === 'start' && text('bin-head').includes('None'), 'wardrobe did not refresh')
      for (let i = 0; i < slot; i++) await press('ArrowDown')
      let found = false
      for (let i = 0; i < 5; i++) {
        await press('ArrowRight')
        if (text(`bin-${SLOTS[slot]}`).includes(cosmeticName(id))) { found = true; break }
      }
      if (!found) throw new Error(`${id} missing from owned bin`)
      purchases.push(id)
      // Leave every bin at None before refreshing the start screen on the next shop visit.
      for (let i = 0; i < 5 && !text(`bin-${SLOTS[slot]}`).includes('None'); i++) await press('ArrowRight')
      for (let i = 0; i < slot; i++) await press('ArrowUp')
    }
  } catch (error) { failures.push(error instanceof Error ? error.message : String(error)) }
  finally { game?.dispose() }
  return { json: { ok: failures.length === 0, purchases, failures }, files: [] }
}
