// ?tune=1: a live panel for the belly stroke parameters of the LOCAL sim (offline and local split
// screen). The values are sim inputs (CharacterSystem reads them every tick), so the local game stays
// deterministic; an online rollback match never receives them and always steps SLIDE_STROKE, so no
// peer can diverge. Copy the JSON line into SLIDE_STROKE (packages/sim/src/character/constants.ts)
// to make tuned values the defaults.
import { SLIDE_STROKE } from '@royal-fiesta/sim/character/constants'
import type { SlideStroke } from '@royal-fiesta/sim/character/constants'

interface Slider { key: keyof SlideStroke; label: string; min: number; max: number; step: number }

export const STROKE_SLIDERS: readonly Slider[] = [
  { key: 'impulse', label: 'push (m/s per stroke)', min: 0, max: 20, step: 0.1 },
  { key: 'startFrac', label: 'push start (fraction of anim)', min: 0, max: 1, step: 0.05 },
  { key: 'impulseTicks', label: 'push duration (ticks)', min: 1, max: 120, step: 1 },
  { key: 'animTicks', label: 'animation (ticks)', min: 6, max: 120, step: 1 },
  { key: 'cooldownTicks', label: 'cooldown (ticks)', min: 0, max: 120, step: 1 },
  { key: 'standUpSpeed', label: 'stand-up speed (m/s)', min: 0, max: 8, step: 0.1 },
  { key: 'dryCapFactor', label: 'dry flat cap (x walking)', min: 0.2, max: 1.5, step: 0.05 },
]

let tuning: SlideStroke | null | undefined

/** The tuned parameters when the page has ?tune=1 (mounting the panel once), else null. */
export function strokeTuningFromUrl(search: string = typeof location === 'undefined' ? '' : location.search): SlideStroke | null {
  if (tuning !== undefined) return tuning
  tuning = new URLSearchParams(search).get('tune') === '1' ? { ...SLIDE_STROKE } : null
  if (tuning !== null && typeof document !== 'undefined') mountPanel(tuning)
  return tuning
}

function mountPanel(values: SlideStroke): void {
  const panel = document.createElement('div')
  panel.style.cssText = 'position:fixed;top:8px;right:8px;z-index:99999;background:rgba(10,14,24,0.88);color:#e8eef8;' +
    'font:12px/1.3 system-ui,sans-serif;padding:8px 10px;border-radius:8px;width:260px;max-width:calc(100vw - 32px)'
  const title = document.createElement('div')
  title.textContent = 'Belly stroke (local sim only)'
  title.style.cssText = 'font-weight:600;margin-bottom:6px'
  panel.append(title)
  const json = document.createElement('input')
  json.readOnly = true
  json.style.cssText = 'width:100%;margin-top:6px;font:11px monospace;background:#000;color:#9fe;border:0'
  const refresh = () => { json.value = JSON.stringify(values) }
  for (const s of STROKE_SLIDERS) {
    const row = document.createElement('label')
    row.style.cssText = 'display:block;margin:4px 0'
    const text = document.createElement('div')
    const input = document.createElement('input')
    input.type = 'range'
    input.min = String(s.min); input.max = String(s.max); input.step = String(s.step)
    input.value = String(values[s.key])
    input.style.cssText = 'width:100%'
    const show = () => { text.textContent = `${s.label}: ${values[s.key]}` }
    input.addEventListener('input', () => { values[s.key] = Number(input.value); show(); refresh() })
    // Give the keys back to the game (arrows, space, shift) once a slider is released.
    input.addEventListener('change', () => input.blur())
    show()
    row.append(text, input)
    panel.append(row)
  }
  const reset = document.createElement('button')
  reset.textContent = 'defaults'
  reset.addEventListener('click', () => {
    Object.assign(values, SLIDE_STROKE)
    panel.querySelectorAll<HTMLInputElement>('input[type=range]').forEach((el, i) => {
      el.value = String(values[STROKE_SLIDERS[i].key]); el.dispatchEvent(new Event('input'))
    })
    reset.blur()
  })
  refresh()
  panel.append(json, reset)
  document.body.append(panel)
}
