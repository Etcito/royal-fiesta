/// <reference path="../types-mama.d.ts" />
// The Graphics page of the settings screen (owner 2026-11-04: "these options must be exposed by MAMA"): every row,
// label, range, default and the validation come from MAMA's game render-options contract
// (src/core/game/render-options.ts), reached through the private virtual:rf-mama module like the rest of MAMA; this
// file holds no copy of an option. The choices are saved with the settings store (GRAPHICS_KEY) and pushed to the
// render ports (render/renderOptions.ts) and the page loop (frame rate, FPS counter) on every change.
// A full multi-page settings redesign is milestone M5; this page only makes the options reachable and usable.
import type { MenuModel } from '@royal-fiesta/game/screens/menuModel'
import type { SettingsStore } from '@royal-fiesta/game/screens/settings'
import type { WidgetProps } from '../ui/screenMap.ts'

export const GRAPHICS_KEY = 'royal-fiesta.graphics'

// The shape of the contract this page reads (structural: MAMA's own types stay behind the virtual module).
export interface GraphicsChoice { value: unknown; label: string; unavailable?: string }
export interface GraphicsSpec {
  key: string
  section: string
  kind: 'choice' | 'number' | 'toggle'
  label: string
  help: string
  default: unknown
  unavailable?: string
  choices?: readonly GraphicsChoice[]
}
export interface GraphicsContract {
  specs: readonly GraphicsSpec[]
  sections: readonly { id: string; label: string }[]
  validate(input: unknown): { options: object; issues: readonly { key: string; message: string }[] }
  step(spec: GraphicsSpec, value: unknown, dir: 1 | -1): unknown
  label(spec: GraphicsSpec, value: unknown): string
  shown(spec: GraphicsSpec, options: object): boolean
}

// The settings screen has 18 row slots (ui/screens.ui-doc.json row-0..row-17).
const ROW_SLOTS = 18
// Options applied by the upload: a change shows when the next scene loads.
const ON_NEXT_LOAD = new Set(['shading', 'bakeTexelDensity', 'bakeMaxSize'])

interface Row { label: string; spec: GraphicsSpec | null; disabled: boolean }

export class GraphicsSettings {
  private contract: GraphicsContract | null = null
  private values: Record<string, unknown> = {}
  private open = false
  private note: string | null = null

  // onChange gets the validated options after the contract loads and after every change.
  private readonly store: SettingsStore
  private readonly onChange: (options: Readonly<Record<string, unknown>>) => void

  constructor(store: SettingsStore, onChange: (options: Readonly<Record<string, unknown>>) => void) {
    this.store = store
    this.onChange = onChange
  }

  // Reads the saved choices through the contract (an invalid or unavailable value falls back to its default and is
  // reported once in the console). Without MAMA (a public clone) the page says so and the defaults apply.
  attach(contract: GraphicsContract | null): void {
    this.contract = contract
    if (contract === null) return
    let saved: unknown = undefined
    try {
      const text = this.store.getItem(GRAPHICS_KEY)
      saved = text === null ? undefined : JSON.parse(text)
    } catch (e) {
      console.warn(`[graphics] saved options unreadable (${e instanceof Error ? e.message : String(e)}); using the defaults`)
    }
    // These two names were used by an earlier saved shading preference.
    if (typeof saved === 'object' && saved !== null && !Array.isArray(saved)) {
      const record = saved as Record<string, unknown>
      if (record.shading === 'sdf' || record.shading === 'texture') {
        saved = { ...record, shading: record.shading === 'sdf' ? 'field' : 'baked' }
      }
    }
    const { options, issues } = contract.validate(saved)
    for (const issue of issues) console.warn(`[graphics] ${issue.key}: ${issue.message}`)
    this.values = { ...options }
    this.onChange(this.values)
  }

  get options(): Readonly<Record<string, unknown>> {
    return this.values
  }

  get isOpen(): boolean {
    return this.open
  }

  openPage(): void {
    this.open = true
    this.note = null
  }

  closePage(): void {
    this.open = false
    this.note = null
  }

  // The page's rows: the shown options in the contract's section order, then one disabled row per choice the stack
  // cannot take yet, right after its option.
  private rows(): Row[] {
    const contract = this.contract
    if (contract === null) return []
    const rows: Row[] = []
    for (const section of contract.sections) {
      for (const spec of contract.specs) {
        if (spec.section !== section.id || !contract.shown(spec, this.values)) continue
        const value = spec.unavailable === undefined ? contract.label(spec, this.values[spec.key]) : 'unavailable'
        rows.push({ label: `${spec.label}: ${value}`, spec, disabled: spec.unavailable !== undefined })
        for (const choice of spec.choices ?? []) {
          if (choice.unavailable !== undefined) rows.push({ label: `${choice.label}: unavailable`, spec: null, disabled: true })
        }
      }
    }
    return rows.slice(0, ROW_SLOTS)
  }

  // The settings screen as the Graphics page: its rows, a line (the last change's help, else why some choices are
  // unavailable) and Back (to the settings rows).
  model(hint: string): MenuModel {
    const rows = this.rows()
    const buttons: MenuModel['buttons'] = rows.map((row, i) => ({ label: row.label, cmd: { k: 'row', row: i } }))
    buttons.push({ label: 'Back', cmd: { k: 'back' } })
    return { screen: 'settings', title: 'Graphics', lines: [this.line()], buttons, hint, overlay: false }
  }

  // The disabled state of the unavailable rows (MenuModel buttons carry no state; the uaa widgets do).
  props(): Record<string, WidgetProps> {
    const props: Record<string, WidgetProps> = {}
    this.rows().forEach((row, i) => { props[`row-${i}`] = { text: row.label, visible: true, disabled: row.disabled } })
    return props
  }

  private line(): string {
    if (this.contract === null) return 'Graphics options come from MAMA, which this build does not include.'
    if (this.note !== null) return this.note
    const reasons = this.contract.specs.flatMap(spec => [
      ...(spec.unavailable === undefined ? [] : [`${spec.label}: ${spec.unavailable}`]),
      ...(spec.choices ?? []).filter(c => c.unavailable !== undefined).map(c => `${c.label}: ${c.unavailable}`),
    ])
    return reasons.length === 0 ? '' : `Unavailable - ${reasons.join('; ')}`
  }

  // A row press: the option steps to its next value (wrapping), is saved and applied. False when the row does nothing
  // (a disabled row, or no row there).
  activate(index: number, dir: 1 | -1 = 1): boolean {
    const contract = this.contract
    const row = this.rows()[index]
    if (contract === null || row === undefined || row.spec === null || row.disabled) return false
    const spec = row.spec
    const { options } = contract.validate({ ...this.values, [spec.key]: contract.step(spec, this.values[spec.key], dir) })
    this.values = { ...options }
    this.note = ON_NEXT_LOAD.has(spec.key) ? `${spec.help} Applies when the next scene loads.` : spec.help
    try {
      this.store.setItem(GRAPHICS_KEY, JSON.stringify(this.values))
    } catch (e) {
      this.note = `Not saved (${e instanceof Error ? e.message : String(e)}); allow site storage to keep settings.`
    }
    this.onChange(this.values)
    return true
  }
}

// The contract from MAMA's virtual module, or null without MAMA (a public clone) or in Node (no virtual module).
export async function loadGraphicsContract(): Promise<GraphicsContract | null> {
  try {
    const mod = await import('virtual:rf-mama') as { loadRenderOptions?: () => Promise<unknown> }
    const contract = await mod.loadRenderOptions?.()
    if (contract === null || contract === undefined) return null
    const c = contract as Partial<GraphicsContract>
    if (!Array.isArray(c.specs) || !Array.isArray(c.sections) || typeof c.validate !== 'function' || typeof c.step !== 'function'
      || typeof c.label !== 'function' || typeof c.shown !== 'function') {
      console.warn('[graphics] the MAMA render-options contract has an unexpected shape; using the defaults')
      return null
    }
    return contract as GraphicsContract
  } catch {
    return null
  }
}
