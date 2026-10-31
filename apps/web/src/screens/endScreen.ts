// The champion and crowns share the transparent uaa overlay with a small 3D stage.
import type { EndScreenModel } from '@royal-fiesta/game/flow/endScreen'
import { parsePrims, type PrimsAsset } from '@royal-fiesta/game/prims'
import { seatTint } from '@royal-fiesta/game/render/palette'
import type { RenderPort } from '@royal-fiesta/game/render/port'
import type { UaaHost } from '../ui/uaaHost.ts'
import type { WidgetProps } from '../ui/screenMap.ts'
import bean from '../../../../fixtures/assets/bean.prims.json' with { type: 'json' }

export interface FlowDeps {
  cue(id: string): void
  stage?: RenderPort
  character?: PrimsAsset
  names?: (seat: number) => string
  localSeat?: number
}

export interface EndScreenView {
  /** ms is elapsed time since mount, rather than a frame delta. */
  update(model: EndScreenModel, ms?: number): { done: boolean }
  unmount(): void
}

const CROWN_CUES = ['flow.crown-gold', 'flow.crown-silver', 'flow.crown-bronze'] as const

export function mountEndScreen(host: UaaHost, model: EndScreenModel, deps: FlowDeps): EndScreenView {
  const port = deps.stage
  const asset = port?.registerAsset('end-screen-character', deps.character ?? parsePrims(bean, 'fixtures/assets/bean.prims.json'))
  const instances: { seat: number; handle: number }[] = []
  const name = deps.names ?? ((seat: number) => `Bean ${seat + 1}`)
  let nextCue = 0
  let mounted = true

  function draw(m: EndScreenModel): void {
    host.present({
      screen: 'endScreen', title: 'Champion', lines: [], overlay: true,
      buttons: [{ label: 'Continue', cmd: { k: 'action', action: 'confirm' } }],
      hint: 'Enter continue - Esc back to start',
    })
    const props: Record<string, WidgetProps> = {
      'end-winner': { text: m.winner >= 0 ? `${name(m.winner)} wins!` : '', visible: m.winner >= 0 },
      'end-ticket': { text: 'Golden ticket!', visible: m.winner >= 0 && m.goldenTicketTo === m.winner },
    }
    for (let i = 0; i < 3; i++) {
      const entry = m.podium[i]
      props[`crown-${i}`] = { visible: entry !== undefined }
      props[`crown-name-${i}`] = { text: entry === undefined ? '' : name(entry.seat), visible: entry !== undefined }
    }
    host.setHud(props)

    if (port === undefined || asset === undefined) return
    // PodiumStage fixes all three beans to the same scale and limits seats to 0..7.
    // Direct instances allow a larger champion and the full show's seat tint range.
    const seats = m.winner < 0 ? [] : [m.winner, ...m.podium.filter((p) => p.seat !== m.winner).slice(0, 2).map((p) => p.seat)]
    for (let i = instances.length - 1; i >= seats.length; i--) {
      port.destroyInstance(instances[i].handle)
      instances.pop()
    }
    seats.forEach((seat, i) => {
      if (instances[i]?.seat !== seat) {
        if (instances[i] !== undefined) port.destroyInstance(instances[i].handle)
        instances[i] = { seat, handle: port.createInstance(asset, seatTint(seat)) }
      }
      const scale = i === 0 ? 1.6 : 0.95
      port.setTransform(instances[i].handle, [i === 0 ? 0 : i === 1 ? -2.2 : 2.2, 0.85 * scale, -1000],
        [0, 0, 0, 1], [scale, scale, scale])
      port.setVisible(instances[i].handle, true)
    })
    port.setCamera(0, { eye: [0, 2.8, -992], target: [0, 2.8, -1000], fovYDeg: 60, near: 0.1, far: 500 })
  }

  draw(model)
  deps.cue('flow.win')
  return {
    update(m, ms = 0) {
      if (mounted) {
        draw(m)
        // Catch up crossed boundaries on a slow frame, without repeating a cue.
        while (nextCue < CROWN_CUES.length && ms >= (nextCue + 1) * 600) {
          deps.cue(CROWN_CUES[nextCue++])
        }
      }
      return { done: ms >= m.showWinnerMs }
    },
    unmount() {
      if (!mounted) return
      mounted = false
      for (const { handle } of instances) port?.destroyInstance(handle)
      instances.length = 0
    },
  }
}
