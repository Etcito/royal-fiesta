// Plain boot: no test query, no starterInventory flag and no full-catalog test grant.
import type { TourDeps, TourGame } from '../uiTour.ts'
import type { WidgetProps } from '../../ui/screenMap.ts'
import { nextTask, yieldTask } from './boot.ts'
import { capture, pipelinesReady } from './wardrobe.ts'

export const name = 'startPlain'
export async function run(_input: unknown, deps: TourDeps) {
  const files: { name: string; blob: Blob }[] = []
  const profiles: unknown[] = []
  const failures: string[] = []
  for (const stale of [false, true]) {
    let game: TourGame | undefined
    try {
      const saved: Record<string, string> = stale ? {
        'rf.economy.guest': 'guest-from-an-older-build',
        'rf.wardrobe': JSON.stringify({ colour: 2, worn: { head: 'costume.removed' } }),
        'rf.economy': JSON.stringify({ coins: 0, tickets: 0, owned: [] }),
      } : {}
      game = await deps.boot(() => {}, { plain: true, saved })
      const live = game
      let props: Record<string, WidgetProps> = {}
      const original = live.host.setHud
      live.host.setHud = values => { props = values; original.call(live.host, values) }
      const step = async () => { live.step(1 / 60); await yieldTask(live.host.currentScreen()) }
      const until = async (predicate: () => boolean, what: string) => {
        const end = Date.now() + 150000
        while (!predicate()) {
          if (live.host.currentScreen() === 'error' || Date.now() > end) throw new Error(`${what}: ${live.host.currentScreen()}`)
          await step()
        }
      }
      const press = async (key: string) => {
        for (const type of ['keydown', 'keyup']) window.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true }))
        await step(); await step()
      }
      const screenshot = async (suffix: string) => {
        live.step(3)
        await pipelinesReady(live, suffix)
        live.step(1 / 60)
        files.push({ name: `${stale ? 'stale' : 'fresh'}-${suffix}.png`, blob: (await capture(live)).composite })
      }
      await until(() => live.host.currentScreen() === 'start', 'plain boot')
      const before = await live.inspect!()
      if (!before.offline || before.me.coins !== 500 || before.me.tickets !== 20 || before.me.owned.length !== 12 || before.catalog.items.length !== 36) throw new Error('wrong plain economy')
      if (!before.bins?.every(bin => bin.items.length === 3 && bin.selected >= 0)) throw new Error('starter cosmetics not visible')
      await screenshot('start')
      for (let i = 0; i < 6; i++) await press('ArrowDown')
      await press('Enter')
      await until(() => live.host.currentScreen() === 'shop' && String(props['line-0']?.text).includes('Coins 500'), 'shop load')
      const shop = await live.inspect!()
      const visibleItems = Object.entries(props).filter(([id, value]) => id.startsWith('catalog-item-') && value.visible === true && value.text)
      if (visibleItems.length !== 36 || shop.shop?.slots.reduce((n, slot) => n + slot.items.length, 0) !== 36) throw new Error('catalog grid incomplete')
      await screenshot('shop')
      // The first unowned item is a 30-coin colour variant. Confirm through real key input.
      await press('ArrowRight'); await press('Enter')
      await until(() => String(props['line-0']?.text).includes('Coins 470'), 'purchase debit')
      const bought = await live.inspect!()
      if (bought.me.owned.length !== 13 || bought.me.tickets !== 20) throw new Error('purchase inventory mismatch')
      await press('Escape')
      await until(() => live.host.currentScreen() === 'start', 'return to wardrobe')
      // Refresh is asynchronous even though the offline economy resolves immediately.
      await nextTask(); await step()
      const after = await live.inspect!()
      if (after.bins?.[0].items.length !== 4) throw new Error('purchase missing from wardrobe')
      await screenshot('purchased')
      // Versioned saves retain an explicit None choice across a shop refresh.
      await press('ArrowLeft')
      for (let i = 0; i < 6; i++) await press('ArrowDown')
      await press('Enter')
      await until(() => live.host.currentScreen() === 'shop' && String(props['line-0']?.text).includes('Coins 470'), 'shop revisit')
      await press('Escape')
      await until(() => live.host.currentScreen() === 'start', 'saved wardrobe refresh')
      await nextTask(); await step()
      if ((await live.inspect!()).bins?.[0].selected !== -1) throw new Error('explicit None was overwritten by starter migration')
      profiles.push({ stale, before, visibleItems: visibleItems.map(([id, value]) => ({ id, text: value.text })), shop: shop.shop, after: bought.me })
    } catch (error) { failures.push(`${stale ? 'stale' : 'fresh'}: ${String(error)}`) }
    finally { game?.dispose() }
  }
  return { json: { ok: failures.length === 0, plain: true, profiles, failures, adapter: await deps.adapter() }, files }
}
