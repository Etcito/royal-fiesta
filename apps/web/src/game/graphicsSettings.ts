/// <reference path="../types-mama.d.ts" />
// Graphics items for the settings tabs; rows, labels, ranges and validation come from MAMA's render-options contract.
import type { SettingsStore } from '@royal-fiesta/game/screens/settings'
import { SETTINGS_ROW_SLOTS, type SettingsItem } from '@royal-fiesta/game/screens/settingsPages'

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
  min?: number
  max?: number
  step?: number
  unit?: string
  values?: readonly number[]
  valueLabels?: readonly string[]
}
export interface GraphicsContract {
  specs: readonly GraphicsSpec[]
  sections: readonly { id: string; label: string }[]
  validate(input: unknown): { options: object; issues: readonly { key: string; message: string }[] }
  step(spec: GraphicsSpec, value: unknown, dir: 1 | -1): unknown
  label(spec: GraphicsSpec, value: unknown): string
  shown(spec: GraphicsSpec, options: object): boolean
}

// Royal Fiesta starts on MEDIUM (owner 2026-11-05): SDF shading, medium AO, full render scale, post on. A saved
// choice (localStorage, GRAPHICS_KEY) still wins; MAMA's defaults fill the other keys.
export const DEFAULT_GRAPHICS: Readonly<Record<string, unknown>> = Object.freeze({
  shading: 'field', aoQuality: 2, renderScale: 1, postBloom: true, postGrading: true, jiggle: 'all',
})
// Options applied by the upload: a change shows when the next scene loads.
const ON_NEXT_LOAD = new Set(['bakeTexelDensity', 'bakeMaxSize'])

function numberValues(spec: GraphicsSpec): readonly number[] {
  if (spec.values !== undefined) return spec.values
  if (spec.min === undefined || spec.max === undefined || spec.step === undefined) return []
  return Array.from({ length: Math.round((spec.max - spec.min) / spec.step) + 1 },
    (_, i) => +(spec.min! + i * spec.step!).toFixed(6))
}

function help(spec: GraphicsSpec): string {
  return spec.help + (spec.choices ?? []).filter(choice => choice.unavailable !== undefined)
    .map(choice => ` Unavailable: ${choice.label} - ${choice.unavailable}.`).join('')
}

export class GraphicsSettings {
  private contract: GraphicsContract | null = null
  private values: Record<string, unknown> = {}
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
    const base = saved !== null && typeof saved === 'object' && !Array.isArray(saved) ? saved : {}
    const { options, issues } = contract.validate({ ...DEFAULT_GRAPHICS, ...base })
    for (const issue of issues) console.warn(`[graphics] ${issue.key}: ${issue.message}`)
    this.values = { ...options }
    this.onChange(this.values)
  }

  get options(): Readonly<Record<string, unknown>> {
    return this.values
  }

  private specs(): GraphicsSpec[] {
    const contract = this.contract
    if (contract === null) return []
    return contract.sections.flatMap(section => contract.specs.filter(spec =>
      spec.section === section.id && contract.shown(spec, this.values))).slice(0, SETTINGS_ROW_SLOTS - 1)
  }

  items(): SettingsItem[] {
    const contract = this.contract
    if (contract === null) return []
    const items = this.specs().map((spec): SettingsItem => {
      const value = this.values[spec.key]
      const item: SettingsItem = {
        label: spec.label, value: contract.label(spec, value), help: help(spec),
        control: spec.kind === 'number' ? 'slider' : spec.kind,
      }
      if (ON_NEXT_LOAD.has(spec.key)) item.nextLoad = true
      if (spec.kind === 'choice') {
        const choices = (spec.choices ?? []).filter(choice => choice.unavailable === undefined)
        item.index = choices.findIndex(choice => choice.value === value)
        item.count = choices.length
      } else if (spec.kind === 'toggle') {
        item.value = value === true ? 'On' : 'Off'
        item.fraction = value === true ? 1 : 0
      } else {
        const values = numberValues(spec)
        const at = values.findIndex(v => Math.abs(v - (value as number)) < 1e-9)
        item.fraction = values.length > 1 ? Math.max(0, at) / (values.length - 1) : 0
      }
      if (spec.unavailable !== undefined) {
        item.value = 'Unavailable'
        item.fraction = 0
        item.disabled = spec.unavailable
      }
      return item
    })
    items.push({ label: 'Reset graphics to defaults', value: '', control: 'action',
      help: 'Puts every graphics option back to its default.' })
    return items
  }

  notes(): string {
    if (this.contract === null) return 'Graphics options come from MAMA, which this build does not include.'
    if (this.note !== null) return this.note
    const reasons = this.contract.specs.flatMap(spec => [
      ...(spec.unavailable === undefined ? [] : [`${spec.label}: ${spec.unavailable}`]),
      ...(spec.choices ?? []).filter(c => c.unavailable !== undefined).map(c => `${c.label}: ${c.unavailable}`),
    ])
    return reasons.length === 0 ? '' : `Unavailable - ${reasons.join('; ')}`
  }

  adjust(index: number, dir: 1 | -1): boolean {
    return this.change(index, dir, false)
  }

  activate(index: number): boolean {
    const item = this.items()[index]
    if (item?.control === 'action') { this.reset(); return true }
    return this.change(index, 1, true)
  }

  private change(index: number, dir: 1 | -1, wrap: boolean): boolean {
    const contract = this.contract
    const spec = this.specs()[index]
    if (contract === null || spec === undefined || spec.unavailable !== undefined) return false
    let value: unknown
    if (spec.kind === 'number') {
      const values = numberValues(spec)
      if (values.length === 0) return false
      const at = values.findIndex(v => Math.abs(v - (this.values[spec.key] as number)) < 1e-9)
      const next = at + dir
      value = values[wrap ? (next + values.length) % values.length : Math.max(0, Math.min(values.length - 1, next))]
    } else {
      value = spec.kind === 'toggle' ? !this.values[spec.key] : contract.step(spec, this.values[spec.key], dir)
    }
    this.values = { ...contract.validate({ ...this.values, [spec.key]: value }).options }
    this.note = help(spec) + (ON_NEXT_LOAD.has(spec.key) ? ' Applies when the next scene loads.' : '')
    this.save()
    return true
  }

  reset(): void {
    if (this.contract === null) return
    this.values = { ...this.contract.validate(DEFAULT_GRAPHICS).options }
    this.note = 'Puts every graphics option back to its default.'
    this.save()
  }

  private save(): void {
    try {
      this.store.setItem(GRAPHICS_KEY, JSON.stringify(this.values))
    } catch (e) {
      this.note = `Not saved (${e instanceof Error ? e.message : String(e)}); allow site storage to keep settings.`
    }
    this.onChange(this.values)
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
