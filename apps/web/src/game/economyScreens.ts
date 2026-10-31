// The economy screens' controller: it owns the three flow models and their renderers, talks to the
// EconomyPort, and leaves main.ts to route nav actions and draw the active screen.
import {
  EconomyError, type EconomyPort, type Me,
} from '@royal-fiesta/game/economy/contract'
import {
  commissionModel, commissionStep, withQueue, type CommissionModel,
} from '@royal-fiesta/game/flow/commission'
import { inboxModel, inboxStep, type InboxModel } from '@royal-fiesta/game/flow/inbox'
import {
  shopModel, shopStep, type ShopButton, type ShopModel,
} from '@royal-fiesta/game/flow/shop'
import type { Action, EconomyScreen } from '@royal-fiesta/game/screens/nav'
import { mountCommission, type CommissionView, type TextFieldElement, type TextFieldParent } from '../screens/commission.ts'
import { mountInbox, type InboxView } from '../screens/inbox.ts'
import { mountShop, type ShopView } from '../screens/shop.ts'
import type { UaaHost } from '../ui/uaaHost.ts'

export interface EconomyScreensOptions {
  port: EconomyPort
  host: UaaHost
  cue(id: string): void
  // The commission form is typed into a textarea appended to this element.
  parent: TextFieldParent
  // The contract's banned words (config.settings.filter.banned_words).
  banned?: readonly string[]
  // Tests inject a plain field instead of document.createElement('textarea').
  createField?(): TextFieldElement
}

const LOADING = 'Loading…'
const EMPTY_ME: Me = Object.freeze({
  playerId: '', coins: 0, tickets: 0, owned: [], inboxUnread: 0,
})

type EconomyModel = ShopModel | InboxModel | CommissionModel

function errorMessage(error: unknown): string {
  if (error instanceof EconomyError) return error.message
  return error instanceof Error ? error.message : String(error)
}

export class EconomyScreens {
  private readonly port: EconomyPort
  private readonly host: UaaHost
  private readonly cue: (id: string) => void
  private readonly banned: readonly string[]
  private readonly parent: TextFieldParent
  private readonly createField: (() => TextFieldElement) | undefined
  private screen: EconomyScreen | null = null
  private view: ShopView | InboxView | CommissionView | null = null
  private shopState: ShopModel | null = null
  private inboxState: InboxModel | null = null
  private commissionState: CommissionModel | null = null
  private loadToken = 0
  private loading = false

  constructor(options: EconomyScreensOptions) {
    this.port = options.port
    this.host = options.host
    this.cue = options.cue
    this.banned = options.banned ?? []
    this.parent = options.parent
    this.createField = options.createField
  }

  get shop(): ShopModel | null { return this.shopState }
  get inbox(): InboxModel | null { return this.inboxState }
  get commission(): CommissionModel | null { return this.commissionState }

  /** Mounts the screen with its placeholder model, then replaces it when the port answers. */
  async open(screen: EconomyScreen): Promise<void> {
    const token = ++this.loadToken
    this.screen = screen
    this.loading = true
    this.unmount()
    this.store(screen, this.loadingModel(screen))
    this.mount(screen)
    try {
      const model = await this.load(screen)
      if (token !== this.loadToken) return
      this.store(screen, model)
      this.loading = false
      // The inbox view mounted on the empty placeholder, so its unread cue is played here.
      if (screen === 'inbox' && (model as InboxModel).rows.some(row => !row.claimed)) this.cue('ui.inbox')
      this.render(null)
    } catch (error) {
      if (token !== this.loadToken) return
      this.loading = false
      this.fail(screen, error)
    }
  }

  /**
   * Runs one screen action through its flow model and the port. A successful shop buy refreshes the
   * catalogue and wallet but keeps the focus; the other requests refresh their screen's data.
   * Returns shopStep's `open` so main.ts can dispatch the nav action.
   */
  async action(screen: EconomyScreen, action: Action): Promise<ShopButton | null> {
    if (this.screen !== screen || this.loading) return null
    if (screen === 'shop') return this.shopAction(action)
    if (screen === 'inbox') {
      await this.inboxAction(action)
      return null
    }
    await this.commissionAction(action)
    return null
  }

  /** Forwards the commission description into its flow model. */
  text(value: string): void {
    const model = this.commissionState
    if (model === null || this.loading) return
    const step = commissionStep(model, { text: value })
    this.commissionState = step.model
    this.render({
      action: { text: value }, model: step.model, submit: null,
    })
  }

  /** Redraws the mounted view, e.g. after the page resized or the commission field changed. */
  draw(screen: EconomyScreen): void {
    if (this.screen !== screen) return
    this.render(null)
  }

  /** Unmounts the active view; a pending load no longer touches it. */
  close(): void {
    this.loadToken++
    this.loading = false
    this.unmount()
    this.screen = null
    this.shopState = null
    this.inboxState = null
    this.commissionState = null
  }

  /** The unread inbox count for the start screen's badge (0 when the port is unavailable). */
  async refreshCount(): Promise<number> {
    try {
      return (await this.port.me()).inboxUnread
    } catch (error) {
      console.warn('[economy] unread count unavailable:', errorMessage(error))
      return 0
    }
  }

  private loadingModel(screen: EconomyScreen): EconomyModel {
    if (screen === 'shop') return { ...shopModel([], EMPTY_ME), error: LOADING }
    if (screen === 'inbox') return { ...inboxModel([], []), error: LOADING }
    return { ...commissionModel(0, this.banned), error: LOADING }
  }

  private async load(screen: EconomyScreen): Promise<EconomyModel> {
    if (screen === 'shop') {
      const [catalog, me] = await Promise.all([this.port.catalog(), this.port.me()])
      return shopModel(catalog.items, me)
    }
    if (screen === 'inbox') {
      const [entries, me] = await Promise.all([this.port.inbox(), this.port.me()])
      return inboxModel(entries, me.owned)
    }
    const [me, queue] = await Promise.all([this.port.me(), this.port.queue()])
    return withQueue(commissionModel(me.tickets, this.banned), queue)
  }

  private store(screen: EconomyScreen, model: EconomyModel): void {
    if (screen === 'shop') this.shopState = model as ShopModel
    else if (screen === 'inbox') this.inboxState = model as InboxModel
    else this.commissionState = model as CommissionModel
  }

  private modelOf(screen: EconomyScreen): EconomyModel | null {
    if (screen === 'shop') return this.shopState
    if (screen === 'inbox') return this.inboxState
    return this.commissionState
  }

  private mount(screen: EconomyScreen): void {
    const model = this.modelOf(screen)
    if (model === null) return
    if (screen === 'shop') {
      this.view = mountShop(this.host, model as ShopModel, { cue: id => this.cue(id) })
    } else if (screen === 'inbox') {
      this.view = mountInbox(this.host, model as InboxModel, { cue: id => this.cue(id) })
    } else {
      this.view = mountCommission(this.host, model as CommissionModel, {
        cue: id => this.cue(id),
        parent: this.parent,
        onText: value => this.text(value),
        onKey: action => { void this.action('commission', action) },
        createField: this.createField,
      })
    }
  }

  private unmount(): void {
    this.view?.unmount()
    this.view = null
  }

  private render(step: Parameters<ShopView['update']>[1] | Parameters<InboxView['update']>[1] | Parameters<CommissionView['update']>[1]): void {
    const view = this.view
    const screen = this.screen
    if (view === null || screen === null) return
    if (screen === 'shop' && this.shopState !== null) {
      (view as ShopView).update(this.shopState, step as Parameters<ShopView['update']>[1])
    } else if (screen === 'inbox' && this.inboxState !== null) {
      (view as InboxView).update(this.inboxState, step as Parameters<InboxView['update']>[1])
    } else if (screen === 'commission' && this.commissionState !== null) {
      (view as CommissionView).update(this.commissionState, step as Parameters<CommissionView['update']>[1])
    }
  }

  private fail(screen: EconomyScreen, error: unknown): void {
    const model = this.modelOf(screen)
    if (model === null) return
    const next = { ...model, error: errorMessage(error), pending: false }
    this.store(screen, next)
    this.render(null)
    this.cue('ui.error')
  }

  private active(token: number, screen: EconomyScreen): boolean {
    return token === this.loadToken && this.screen === screen
  }

  private async shopAction(action: Action): Promise<ShopButton | null> {
    const model = this.shopState
    if (model === null) return null
    const token = this.loadToken
    const step = shopStep(model, action)
    this.shopState = step.model
    this.render({ ...step, action })
    if (step.open !== null) return step.open
    if (step.buy === null) return null
    try {
      await this.port.buy(step.buy.itemId, step.buy.currency)
      const [catalog, me] = await Promise.all([this.port.catalog(), this.port.me()])
      if (!this.active(token, 'shop')) return null
      const focus = this.shopState?.focus ?? step.model.focus
      this.shopState = { ...shopModel(catalog.items, me), focus, pending: false, error: null }
      this.render(null)
    } catch (error) {
      if (!this.active(token, 'shop')) return null
      this.fail('shop', error)
    }
    return null
  }

  private async inboxAction(action: Action): Promise<void> {
    const model = this.inboxState
    if (model === null) return
    const token = this.loadToken
    const step = inboxStep(model, action)
    this.inboxState = step.model
    this.render({ ...step, action })
    const request = step.claim !== null
      ? this.port.claim(step.claim)
      : step.gift !== null
        ? this.port.gift(step.gift.to, step.gift.itemId, step.gift.message)
        : step.block !== null ? this.port.block(step.block) : null
    if (request === null) return
    try {
      await request
      const [entries, me] = await Promise.all([this.port.inbox(), this.port.me()])
      if (!this.active(token, 'inbox')) return
      this.inboxState = inboxModel(entries, me.owned)
      this.render(null)
    } catch (error) {
      if (!this.active(token, 'inbox')) return
      this.fail('inbox', error)
    }
  }

  private async commissionAction(action: Action): Promise<void> {
    const model = this.commissionState
    if (model === null) return
    const token = this.loadToken
    const step = commissionStep(model, action)
    this.commissionState = step.model
    this.render({ ...step, action })
    if (step.submit === null) return
    try {
      await this.port.commission(step.submit.slot, step.submit.rarity, step.submit.description)
      const [me, queue] = await Promise.all([this.port.me(), this.port.queue()])
      if (!this.active(token, 'commission')) return
      const current = this.commissionState ?? step.model
      this.commissionState = withQueue({ ...current, tickets: me.tickets }, queue)
      this.render(null)
    } catch (error) {
      if (!this.active(token, 'commission')) return
      this.fail('commission', error)
    }
  }
}
