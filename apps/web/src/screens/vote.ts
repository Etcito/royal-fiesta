// The vote screen's uaa view: three candidate cards, the focus/vote marks and the timer, from the
// pure VoteModel. It presents through the UaaHost and plays the step's cues through SoundDriver.cue.
import { VOTE_MS, type VoteModel } from '@royal-fiesta/game/flow/vote'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import { menuModel, type MenuCtx } from '@royal-fiesta/game/screens/menuModel'
import { DEFAULT_SETTINGS } from '@royal-fiesta/game/screens/settings'
import type { RoundKind } from '@royal-fiesta/sim/season/kinds'
import type { WidgetProps } from '../ui/screenMap.ts'
import type { UaaHost } from '../ui/uaaHost.ts'

// The flow-web renderers' shared deps (ARCHITECTURE.md, M7). Vote only needs cue.
export interface FlowDeps {
  // SoundDriver.cue: one non-spatial one-shot; a no-op before the engine opens.
  cue(id: string): void
  stage?: RenderPort
  character?: PrimsAsset
  names?: (seat: number) => string
  localSeat?: number
}

export interface VoteView {
  // model is the step's result; sound is the step's cue (omitted = derive it from the model change).
  update(model: VoteModel, sound?: string | null): void
  unmount(): void
}

const KIND_LABEL: Readonly<Record<RoundKind, string>> = Object.freeze({
  race: 'Race',
  survival: 'Survival',
  team: 'Team',
  collection: 'Collection',
  hunt: 'Hunt',
  logic: 'Logic',
  final: 'Final',
})

const HINT = '\u2190/\u2192 choose \u00b7 Enter vote'

export function kindLabel(kind: RoundKind): string {
  return KIND_LABEL[kind] ?? kind
}

// A single candidate sits in the middle card (slot 1); otherwise candidate i uses slot i.
export function voteSlot(index: number, count: number): number {
  return count === 1 ? 1 : index
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.min(1, Math.max(0, value))
}

// Whole-second boundaries crossed while the timer stays positive, as vote.ts counts them.
function ticksCrossed(fromMs: number, toMs: number): number {
  const from = Math.ceil(Math.max(0, fromMs) / 1000)
  const to = Math.max(1, Math.ceil(Math.max(0, toMs) / 1000))
  return Math.max(0, from - to)
}

// The whole vote screen's props for the doc's widget ids.
export function voteProps(model: VoteModel): Record<string, WidgetProps> {
  const props: Record<string, WidgetProps> = {}
  const count = Math.min(3, model.candidates.length)
  const bySlot = new Map<number, number>()
  for (let i = 0; i < count; i++) bySlot.set(voteSlot(i, count), i)
  for (let slot = 0; slot < 3; slot++) {
    const card = `vote-card-${slot}`
    const name = `vote-name-${slot}`
    const kind = `vote-kind-${slot}`
    const mark = `vote-mark-${slot}`
    const index = bySlot.get(slot)
    if (index === undefined) {
      props[card] = { visible: false }
      props[name] = { visible: false }
      props[kind] = { visible: false }
      props[mark] = { visible: false }
      continue
    }
    const candidate = model.candidates[index]
    props[card] = { visible: true }
    props[name] = { text: candidate.name, visible: true }
    props[kind] = { text: kindLabel(candidate.kind), visible: true }
    if (model.chosen === index) props[mark] = { text: '\u2714 Your vote', visible: true }
    else if (model.focus === index) props[mark] = { text: '\u25bc', visible: true }
    else props[mark] = { visible: false }
  }
  props['vote-time-bar'] = { value: clamp01(model.msLeft / VOTE_MS) }
  props['vote-time'] = { text: `${Math.ceil(Math.max(0, model.msLeft) / 1000)} s` }
  props.hint = { text: HINT }
  return props
}

// The fields that decide a step's cue; kept as values so a caller that mutates its model still cues.
interface VoteMark { focus: number; chosen: number | null; msLeft: number }

function markOf(model: VoteModel): VoteMark {
  return { focus: model.focus, chosen: model.chosen, msLeft: model.msLeft }
}

let current: VoteView | null = null

export function mountVote(host: UaaHost, model: VoteModel, deps: FlowDeps): VoteView {
  const ctx: MenuCtx = { settings: DEFAULT_SETTINGS, rebinding: null, error: null, info: [] }
  host.present(menuModel('vote', [], ctx))
  let previous = markOf(model)
  const view: VoteView = {
    update(next, sound) {
      let cue = sound
      if (cue === undefined) {
        // The same precedence as voteStep: confirm wins over a tick, a tick over the hover.
        if (next.chosen !== null && previous.chosen === null) cue = 'flow.vote-confirm'
        else if (ticksCrossed(previous.msLeft, next.msLeft) > 0) cue = 'flow.vote-tick'
        else if (next.focus !== previous.focus) cue = 'ui.hover'
        else cue = null
      }
      if (cue !== null) deps.cue(cue)
      previous = markOf(next)
      host.setHud(voteProps(next))
    },
    unmount() {
      if (current === view) current = null
    },
  }
  current = view
  host.setHud(voteProps(model))
  return view
}

export function update(model: VoteModel, sound?: string | null): void {
  current?.update(model, sound)
}

export function unmount(): void {
  current?.unmount()
}
