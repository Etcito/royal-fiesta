// DOM HUD overlay. hudLines is the shared text: ops.ts draws the same lines onto captures (the canvas capture has no DOM).
import { PALETTE, PALETTE_NAMES } from '@royal-fiesta/game/render/palette'
import { Phase } from '@royal-fiesta/sim/match/matchSim'
import type { MatchViewState } from '@royal-fiesta/sim/match/matchSim'

const PLACES = ['1st', '2nd', '3rd']

function clock(ticks: number): string {
  const s = Math.ceil(Math.max(0, ticks) / 60)
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

function kindLabel(state: MatchViewState): string {
  if (state.phase === Phase.podium || state.phase === Phase.done) return 'Podium'
  if (state.final) return 'Final'
  if (state.roundKind === 'race') return 'Race'
  if (state.roundKind === 'survival') return 'Survival'
  return 'Get ready'
}

function nameOf(names: string[], p: number): string {
  return names[p] ?? `Bean ${p + 1}`
}

function colourOf(p: number): string {
  const c = PALETTE[((p % PALETTE.length) + PALETTE.length) % PALETTE.length]
  return `rgb(${Math.round(c[0] * 255)}, ${Math.round(c[1] * 255)}, ${Math.round(c[2] * 255)})`
}

function onPodium(state: MatchViewState): boolean {
  return state.phase === Phase.podium || state.phase === Phase.done
}

// Lines, in order: round kind, timer, qualified, podium places (podium phases only), local player.
export function hudLines(state: MatchViewState, names: string[], local: number): string[] {
  const lines: string[] = []
  const round = state.roundIndex >= 0 ? ` - Round ${state.roundIndex + 1}` : ''
  lines.push(onPodium(state) ? kindLabel(state) : `${kindLabel(state)}${round}`)
  if (state.phase === Phase.intro) lines.push(`Starts in ${clock(state.phaseTicksLeft)}`)
  else if (state.phase === Phase.playing) lines.push(`Time ${clock(state.roundTicksLeft)}`)
  else if (!onPodium(state)) lines.push('Time 0:00')
  if (!onPodium(state)) lines.push(`Qualified ${state.qualifiedCount} / ${state.target}`)
  else {
    for (let i = 0; i < state.podium.length && i < PLACES.length; i++) lines.push(`${PLACES[i]} ${nameOf(names, state.podium[i])}`)
  }
  const colour = PALETTE_NAMES[((local % PALETTE_NAMES.length) + PALETTE_NAMES.length) % PALETTE_NAMES.length]
  lines.push(`You: ${nameOf(names, local)} (${colour})`)
  return lines
}

const TEXT = 'font-family: "Baloo 2", "Fredoka", "Arial Rounded MT Bold", system-ui, sans-serif; font-weight: 900; color: #fff;' +
  ' -webkit-text-stroke: 2px #2a1240; paint-order: stroke fill; text-shadow: 0 4px 0 #2a1240;'
const PILL = 'border-radius: 28px; border: 4px solid #2a1240; box-shadow: 0 6px 0 #2a1240; padding: 10px 26px;'

function el(tag: string, style: string, parent: HTMLElement): HTMLElement {
  const e = document.createElement(tag)
  e.style.cssText = style
  parent.appendChild(e)
  return e
}

export function mountHud(root: HTMLElement): { update(state: MatchViewState, names: string[], local: number): void; banner(text: string): void } {
  if (getComputedStyle(root).position === 'static') root.style.position = 'relative'
  const layer = el('div', 'position: absolute; inset: 0; pointer-events: none; z-index: 10; overflow: hidden;' + TEXT, root)
  const bannerEl = el('div', 'position: absolute; top: 16px; left: 50%; transform: translateX(-50%); display: none; font-size: 30px;' +
    ' background: #ff4f8b; max-width: 90%; text-align: center;' + PILL, layer)
  const top = el('div', 'position: absolute; top: 96px; left: 32px; display: flex; flex-direction: column; gap: 14px; align-items: flex-start;', layer)
  const kind = el('div', 'font-size: 48px; background: #8a4dff;' + PILL, top)
  const timer = el('div', 'font-size: 56px; background: #ffb72b;' + PILL, top)
  const qualified = el('div', 'font-size: 40px; background: #3fcf6a;' + PILL, top)
  const you = el('div', 'position: absolute; bottom: 32px; left: 32px; font-size: 34px; background: #2a1240;' + PILL, layer)
  const podium = el('div', 'position: absolute; left: 50%; bottom: 120px; transform: translateX(-50%); display: none;' +
    ' align-items: flex-end; gap: 18px;', layer)
  // Visual order 2nd, 1st, 3rd: the winner stands in the centre on the highest step.
  const steps: { box: HTMLElement; name: HTMLElement }[] = []
  const heights = [300, 220, 160]
  const colours = ['#ffd23f', '#c9d6e8', '#e89a5a']
  for (let i = 0; i < 3; i++) {
    const box = el('div', `order: ${i === 0 ? 1 : i === 1 ? 0 : 2}; width: 260px; display: flex; flex-direction: column; align-items: center; gap: 12px;`, podium)
    const name = el('div', 'font-size: 38px; max-width: 260px; text-align: center; overflow-wrap: anywhere;', box)
    el('div', `width: 100%; height: ${heights[i]}px; background: ${colours[i]}; border-radius: 22px 22px 0 0; border: 4px solid #2a1240;` +
      ` display: flex; justify-content: center; padding-top: 14px; box-sizing: border-box; font-size: ${i === 0 ? 72 : 56}px;`, box).textContent = PLACES[i]
    steps.push({ box, name })
  }
  return {
    update(state, names, local) {
      const lines = hudLines(state, names, local)
      const podiumOn = onPodium(state)
      kind.textContent = lines[0]
      timer.style.display = podiumOn ? 'none' : ''
      qualified.style.display = podiumOn ? 'none' : ''
      if (!podiumOn) {
        timer.textContent = lines[1]
        qualified.textContent = lines[2]
      }
      podium.style.display = podiumOn ? 'flex' : 'none'
      for (let i = 0; i < steps.length; i++) {
        const p = state.podium[i]
        steps[i].box.style.visibility = podiumOn && p !== undefined ? 'visible' : 'hidden'
        if (p !== undefined) {
          steps[i].name.textContent = nameOf(names, p)
          steps[i].name.style.color = colourOf(p)
        }
      }
      you.textContent = lines[lines.length - 1]
      you.style.color = colourOf(local)
      you.style.borderColor = colourOf(local)
    },
    banner(text) {
      bannerEl.textContent = text
      bannerEl.style.display = text.length > 0 ? '' : 'none'
    },
  }
}
