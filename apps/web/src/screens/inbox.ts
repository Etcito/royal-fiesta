import {
  inboxButtonsLine,
  inboxLines,
  type InboxModel,
  type InboxStep,
} from '@royal-fiesta/game/flow/inbox'
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { Action } from '@royal-fiesta/game/screens/nav'
import type { WidgetProps } from '../ui/screenMap.ts'
import type { UaaHost } from '../ui/uaaHost.ts'
import type { FlowDeps } from './startScreen.ts'

// The caller supplies the inboxStep result together with the input that produced it.
export interface InboxScreenStep extends InboxStep {
  action: Action
}

export interface InboxView {
  update(model: InboxModel, step: InboxScreenStep | null): void
  unmount(): void
}

const HINT = 'Up/Down entry · Left/Right Claim/Gift/Block · Enter'

const MOVES: readonly Action[] = ['up', 'down', 'left', 'right']

function present(host: UaaHost, model: InboxModel): void {
  const menu: MenuModel = {
    screen: 'inbox', title: 'Inbox', lines: inboxLines(model), hint: HINT, overlay: false,
    buttons: [
      { label: 'Back', cmd: { k: 'back' } },
    ],
  }
  host.present(menu)
  const props: Record<string, WidgetProps> = {
    'inbox-buttons': { text: inboxButtonsLine(model), visible: true },
  }
  menu.lines.forEach((text, index) => { props[`line-${index}`] = { text, visible: true } })
  host.setHud(props)
}

export function mountInbox(host: UaaHost, model: InboxModel, deps: FlowDeps): InboxView {
  let mounted = true
  present(host, model)
  if (model.rows.some(row => !row.claimed)) deps.cue('ui.inbox')
  return {
    update(next, step) {
      if (!mounted) return
      if (step !== null) {
        if (MOVES.includes(step.action)) deps.cue('ui.hover')
        else if (step.claim !== null || step.gift !== null || step.block !== null || step.model.picking) {
          deps.cue('ui.click')
        } else if (step.model.error !== null) deps.cue('ui.error')
      }
      present(host, next)
    },
    unmount() {
      mounted = false
    },
  }
}
