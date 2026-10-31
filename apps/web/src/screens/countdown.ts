// The countdown screen's uaa view: the existing 'countdown' screen driven by the pure show-flow
// countdown. It presents through the UaaHost and plays each label's cue once per label change.
import {
  countdownAt, type CountdownFrame, type CountdownLabel,
} from '@royal-fiesta/game/flow/countdown'
import type { PrimsAsset } from '@royal-fiesta/game/prims'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import { menuModel, type MenuCtx } from '@royal-fiesta/game/screens/menuModel'
import { DEFAULT_SETTINGS } from '@royal-fiesta/game/screens/settings'
import type { WidgetProps } from '../ui/screenMap.ts'
import type { UaaHost } from '../ui/uaaHost.ts'

// The flow-web renderers' shared deps (ARCHITECTURE.md, M7). Countdown only needs cue.
export interface FlowDeps {
  // SoundDriver.cue: one non-spatial one-shot; a no-op before the engine opens.
  cue(id: string): void
  stage?: RenderPort
  character?: PrimsAsset
  names?: (seat: number) => string
  localSeat?: number
}

// The show-flow frame plus the map name the caller is loading; the map is optional for a test.
export interface CountdownModel extends CountdownFrame {
  map?: string
}

export interface CountdownView {
  // ms overrides the frame (countdownAt(ms)); without it the model's label and sound are shown.
  update(model: CountdownModel, ms?: number): void
  unmount(): void
}

// While the world loads there is no label: the title says what is loading. Otherwise the title is
// the round's map name (docs/screens.md: the countdown shows 3-2-1-GO and the round name).
export function countdownTitle(label: CountdownLabel | null, map?: string): string {
  const name = (map ?? '').trim()
  if (label === null) return name.length > 0 ? `Loading ${name}\u2026` : 'Loading\u2026'
  return name.length > 0 ? name : 'Get ready'
}

export function countdownProps(model: CountdownModel, frame: CountdownFrame = model): Record<string, WidgetProps> {
  return {
    title: { text: countdownTitle(frame.label, model.map) },
    'countdown-number': frame.label === null
      ? { visible: false }
      : { text: { count: frame.label }, visible: true },
  }
}

let current: CountdownView | null = null

export function mountCountdown(host: UaaHost, model: CountdownModel, deps: FlowDeps): CountdownView {
  const ctx: MenuCtx = { settings: DEFAULT_SETTINGS, rebinding: null, error: null, info: [] }
  host.present(menuModel('countdown', [], ctx))
  let lastLabel: CountdownLabel | null = null
  const view: CountdownView = {
    update(next, ms) {
      const frame: CountdownFrame = ms === undefined
        ? { label: next.label, sound: next.sound }
        : countdownAt(ms)
      if (frame.label !== null && frame.label !== lastLabel && frame.sound !== null) deps.cue(frame.sound)
      lastLabel = frame.label
      host.setHud(countdownProps(next, frame))
    },
    unmount() {
      if (current === view) current = null
    },
  }
  current = view
  view.update(model)
  return view
}

export function update(model: CountdownModel, ms?: number): void {
  current?.update(model, ms)
}

export function unmount(): void {
  current?.unmount()
}
