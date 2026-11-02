// The vote screen's uaa view: three candidate cards, the focus/vote marks and the timer, from the
// pure VoteModel. It presents through the UaaHost and plays the step's cues through SoundDriver.cue.
import { VOTE_MS, type VoteModel } from '@royal-fiesta/game/flow/vote'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import { menuModel, type MenuCtx } from '@royal-fiesta/game/screens/menuModel'
import { DEFAULT_SETTINGS } from '@royal-fiesta/game/screens/settings'
import type { RoundKind } from '@royal-fiesta/sim/season/kinds'
import { browserContentIndex, browserContentRoot } from '../content/v1Data.ts'
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
  // The DOM container the thumbnails sit in (main.ts's #screens); #screens when omitted.
  parent?: HTMLElement
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

const HINT = 'Left/Right choose \u00b7 Enter vote'

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
    if (model.chosen === index) props[mark] = { text: 'Your vote', visible: true }
    else if (model.focus === index) props[mark] = { text: 'v', visible: true }
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

// The thumbnail path index.json lists for the map, under the same content root the meshes load from.
function thumbUrl(path: string): string {
  const root = browserContentRoot().replace(/\/?$/, '/')
  return new URL(path, new URL(root, document.baseURI)).href
}

let current: VoteView | null = null

export function mountVote(host: UaaHost, model: VoteModel, deps: FlowDeps): VoteView {
  const ctx: MenuCtx = { settings: DEFAULT_SETTINGS, rebinding: null, error: null, info: [] }
  host.present(menuModel('vote', [], ctx))
  let previous = markOf(model)
  const parent = typeof document === 'undefined' ? null : deps.parent ?? document.getElementById('screens') ?? document.body
  const images = new Map<number, HTMLImageElement>()
  const wanted = new Map<number, { map: string; name: string }>()
  // Map -> thumbnail path from index.json; a map the index lists no thumbnail for gets no image request.
  let listed: ReadonlyMap<string, string> | null = null
  let latest = model

  function removeImage(slot: number): void {
    const img = images.get(slot)
    if (img === undefined) return
    img.remove()
    images.delete(slot)
  }

  function syncImages(next: VoteModel): void {
    const count = Math.min(3, next.candidates.length)
    wanted.clear()
    for (let i = 0; i < count; i++) {
      const candidate = next.candidates[i]
      wanted.set(voteSlot(i, count), { map: candidate.map, name: candidate.name })
    }
    for (const slot of [...images.keys()]) if (!wanted.has(slot)) removeImage(slot)
    if (parent === null) return
    for (const [slot, candidate] of wanted) {
      const path = listed?.get(candidate.map)
      if (path === undefined) {
        removeImage(slot)
        continue
      }
      let img = images.get(slot)
      if (img === undefined) {
        img = document.createElement('img')
        img.alt = ''
        img.style.position = 'absolute'
        img.style.objectFit = 'cover'
        img.style.pointerEvents = 'none'
        img.addEventListener('error', () => {
          console.warn(`[vote] thumbnail for map ${img!.dataset.map ?? '?'} failed to load`)
        })
        parent.appendChild(img)
        images.set(slot, img)
      }
      if (img.dataset.map !== candidate.map) {
        img.dataset.map = candidate.map
        img.src = thumbUrl(path)
      }
      img.alt = candidate.name
    }
  }

  function place(): void {
    for (const [slot, img] of images) {
      const rect = host.widgetRect(`vote-thumb-${slot}`)
      if (rect === null) {
        img.style.display = 'none'
        continue
      }
      img.style.display = 'block'
      img.style.left = `${rect.x}px`
      img.style.top = `${rect.y}px`
      img.style.width = `${rect.w}px`
      img.style.height = `${rect.h}px`
    }
  }

  const onResize = (): void => place()
  if (typeof window !== 'undefined') window.addEventListener('resize', onResize)
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
      latest = next
      syncImages(next)
      place()
    },
    unmount() {
      if (current === view) current = null
      if (typeof window !== 'undefined') window.removeEventListener('resize', onResize)
      for (const slot of [...images.keys()]) removeImage(slot)
    },
  }
  current = view
  host.setHud(voteProps(model))
  syncImages(model)
  place()
  if (parent !== null) {
    browserContentIndex().then(index => {
      listed = new Map((index.thumbs ?? []).map(thumb => [thumb.map, thumb.path]))
      if (current !== view) return
      syncImages(latest)
      place()
    }, e => console.warn('[vote] content index unavailable, no thumbnails:', e))
  }
  return view
}

export function update(model: VoteModel, sound?: string | null): void {
  current?.update(model, sound)
}

export function unmount(): void {
  current?.unmount()
}
