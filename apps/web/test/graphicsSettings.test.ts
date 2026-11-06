import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { mamaSource } from '../../../tools/bricks.ts'
import { SETTINGS_ROW_SLOTS } from '../../../packages/game/src/screens/settingsPages.ts'
import { DEFAULT_GRAPHICS, GRAPHICS_KEY, GraphicsSettings, type GraphicsContract, type GraphicsSpec } from '../src/game/graphicsSettings.ts'

interface ShadingContract {
  default: string
  label: string
  help: string
  choices: { value: string; label: string }[]
}

function pinnedShadingContract(): ShadingContract | null {
  const mama = mamaSource()
  if (mama.kind === 'absent') return null
  const source = readFileSync(join(mama.dir, 'src/core/game/render-options.ts'), 'utf8')
  const start = source.indexOf('export const GAME_RENDER_OPTION_SPECS')
  assert.notEqual(start, -1, 'MAMA declares GAME_RENDER_OPTION_SPECS')
  const shadingStart = source.indexOf("key: 'shading'", start)
  assert.notEqual(shadingStart, -1, 'MAMA declares the shading option')
  const end = source.indexOf('\n  },', shadingStart)
  assert.notEqual(end, -1, 'MAMA shading option has a closing object')
  const block = source.slice(shadingStart, end)
  const defaultValue = /default:\s*'([^']+)'/.exec(block)?.[1]
  const label = /label:\s*'([^']+)'/.exec(block)?.[1]
  const help = /help:\s*'([^']+)'/.exec(block)?.[1]
  const choicesBlock = /choices:\s*\[([\s\S]*?)\]/.exec(block)?.[1]
  assert.ok(defaultValue && label && help && choicesBlock, 'MAMA shading spec has default, label, help and choices')
  const choices = [...choicesBlock.matchAll(/\{\s*value:\s*'([^']+)',\s*label:\s*'([^']+)'[^}]*\}/g)]
    .map(match => ({ value: match[1]!, label: match[2]! }))
  assert.ok(choices.length > 0, 'MAMA shading spec declares choices')
  assert.doesNotMatch(choicesBlock, /\bhint\s*:/, 'MAMA choices use spec-level help, not per-choice hints')
  return { default: defaultValue, label, help, choices }
}

const MAMA_SHADING = pinnedShadingContract()
const FALLBACK_SHADING: ShadingContract = {
  default: 'field',
  label: 'Surface shading',
  help: 'Field: every pixel reads the SDF (best look). Baked: normals and materials baked into textures at load (faster, no download). Vertex: per-vertex normals and colours (fastest).',
  choices: [
    { value: 'field', label: 'SDF per pixel' },
    { value: 'baked', label: 'Baked texture (normal/material)' },
    { value: 'vertex', label: 'Vertex' },
  ],
}
const SHADING = MAMA_SHADING ?? FALLBACK_SHADING

const SPECS: GraphicsSpec[] = [
  { key: 'frameRate', section: 'frame', kind: 'choice', label: 'Frame rate', help: 'Frame cap.', default: 'cap60',
    choices: [{ value: 'cap60', label: '60 fps' }, { value: 'vmax', label: 'Vmax', unavailable: 'not supported in this test' }] },
  { key: 'showFps', section: 'frame', kind: 'toggle', label: 'Show FPS', help: 'FPS counter.', default: false },
  { key: 'shading', section: 'shading', kind: 'choice', ...SHADING, choices: SHADING.choices },
  { key: 'lodOffset', section: 'detail', kind: 'number', label: 'LOD offset', help: 'LOD.', default: 0, unavailable: 'one level' },
  { key: 'renderScale', section: 'screen', kind: 'number', label: 'Render scale', help: 'Render resolution.', default: 1,
    min: 0.5, max: 2, step: 0.25, unit: 'x', values: [0.5, 0.75, 1, 1.25, 1.5, 2] },
  { key: 'postBloom', section: 'screen', kind: 'toggle', label: 'Bloom', help: 'Glow.', default: true },
  { key: 'postGrading', section: 'screen', kind: 'toggle', label: 'Colour grading', help: 'Colour look.', default: true },
  { key: 'postStrength', section: 'screen', kind: 'number', label: 'Screen strength', help: 'Effects strength.', default: 1,
    min: 0, max: 1, step: 0.1 },
  { key: 'aoQuality', section: 'lighting', kind: 'number', label: 'Ambient occlusion', help: 'Contact shadows.', default: 3,
    min: 0, max: 4, step: 1, valueLabels: ['Off', 'Low', 'Medium', 'High', 'Ultra'] },
  { key: 'jiggle', section: 'animation', kind: 'choice', label: 'Jiggle bones', help: 'Cosmetic movement.', default: 'all',
    choices: [{ value: 'all', label: 'All' }, { value: 'off', label: 'Off' }] },
  { key: 'bakeTexelDensity', section: 'shading', kind: 'number', label: 'Bake texel density', help: 'Texels per metre.',
    default: 256, min: 32, max: 1024, step: 32 },
  { key: 'bakeMaxSize', section: 'shading', kind: 'number', label: 'Bake size cap', help: 'Largest baked texture.',
    default: 512, values: [128, 256, 512, 1024, 2048] },
]

function contract(specs = SPECS): GraphicsContract {
  const defaults = Object.fromEntries(specs.map(spec => [spec.key, spec.default]))
  return {
    specs,
    sections: ['frame', 'shading', 'detail', 'screen', 'lighting', 'animation'].map(id => ({ id, label: id })),
    validate(input) {
      const issues: { key: string; message: string }[] = []
      const options: Record<string, unknown> = { ...defaults }
      if (input === undefined || input === null) return { options, issues }
      if (typeof input !== 'object' || Array.isArray(input)) return { options, issues: [{ key: '', message: 'expected an object' }] }
      const given = input as Record<string, unknown>
      for (const key of Object.keys(given)) {
        if (!specs.some(spec => spec.key === key)) issues.push({ key, message: 'unknown option' })
      }
      for (const spec of specs) {
        if (!Object.hasOwn(given, spec.key)) continue
        const value = given[spec.key]
        const valid = spec.unavailable === undefined && (spec.kind === 'toggle' ? typeof value === 'boolean'
          : spec.choices?.some(choice => choice.value === value && choice.unavailable === undefined) ?? typeof value === 'number')
        if (valid) options[spec.key] = value
        else issues.push({ key: spec.key, message: 'invalid or unavailable value' })
      }
      return { options, issues }
    },
    step(spec, value, dir) {
      if (spec.kind === 'toggle') return !value
      if (spec.kind === 'number') return value
      const values = (spec.choices ?? []).filter(choice => choice.unavailable === undefined).map(choice => choice.value)
      const at = values.indexOf(value)
      return values[(at + dir + values.length) % values.length]
    },
    label(spec, value) {
      if (spec.kind === 'toggle') return value === true ? 'On' : 'Off'
      return spec.choices?.find(choice => choice.value === value)?.label ?? String(value)
    },
    shown: (spec, options) => !spec.key.startsWith('bake') || (options as Record<string, unknown>).shading === 'baked',
  }
}

function memoryStore(initial: string | null = null) {
  const data = new Map<string, string>()
  if (initial !== null) data.set(GRAPHICS_KEY, initial)
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}

test('the shading row uses the pinned MAMA choices or the matching fallback stub', () => {
  const shading = SPECS.find(spec => spec.key === 'shading')!
  assert.equal(shading.default, 'field')
  assert.equal(shading.label, 'Surface shading')
  assert.deepEqual(shading.choices?.map(choice => ({ value: choice.value, label: choice.label })), [
    { value: 'field', label: 'SDF per pixel' },
    { value: 'baked', label: 'Baked texture (normal/material)' },
    { value: 'vertex', label: 'Vertex' },
  ])
  const page = new GraphicsSettings(memoryStore(), () => {})
  page.attach(contract())
  assert.equal(page.options.shading, 'field', 'Royal Fiesta starts on MEDIUM: SDF per pixel')
  assert.ok(page.items().some(item => item.label === 'Surface shading' && item.value === 'SDF per pixel'))
})

test('the copied test contract matches the pinned MAMA shading spec when available', () => {
  if (MAMA_SHADING === null) return
  const shading = SPECS.find(spec => spec.key === 'shading')!
  assert.equal(shading.default, MAMA_SHADING.default)
  assert.equal(shading.label, MAMA_SHADING.label)
  assert.deepEqual(shading.help, MAMA_SHADING.help)
  assert.deepEqual(shading.choices?.map(choice => ({ value: choice.value, label: choice.label })), MAMA_SHADING.choices)
})

test('items expose controls, selectable choice counts and unavailable options', () => {
  const page = new GraphicsSettings(memoryStore(), () => {})
  page.attach(contract())
  const notes = page.notes()
  assert.deepEqual(page.items().map(item => item.value === '' ? item.label : `${item.label}: ${item.value}`), [
    'Frame rate: 60 fps', 'Show FPS: Off', 'Surface shading: SDF per pixel', 'LOD offset: Unavailable',
    'Render scale: 1', 'Bloom: On', 'Colour grading: On', 'Screen strength: 1', 'Ambient occlusion: 2',
    'Jiggle bones: All', 'Reset graphics to defaults',
  ])
  assert.deepEqual(page.items()[0], { label: 'Frame rate', value: '60 fps', control: 'choice', index: 0, count: 1,
    help: 'Frame cap. Unavailable: Vmax - not supported in this test.' })
  assert.equal(page.items()[1].control, 'toggle')
  assert.equal(page.items()[1].fraction, 0)
  assert.deepEqual(page.items()[3], { label: 'LOD offset', value: 'Unavailable', control: 'slider',
    help: 'LOD.', fraction: 0, disabled: 'one level' })
  assert.equal(page.items()[3].disabled, 'one level')
  assert.equal(page.activate(3), false)
  assert.equal(page.adjust(3, 1), false)
  assert.equal(page.activate(0), true)
  assert.equal(page.options.frameRate, 'cap60')
  assert.match(notes, /Unavailable - Vmax: not supported in this test; LOD offset: one level/)
})

test('shading choices step in MAMA order and show the spec help after a change', () => {
  const store = memoryStore(JSON.stringify({ shading: 'field' }))
  const applied: Record<string, unknown>[] = []
  const page = new GraphicsSettings(store, options => applied.push({ ...options }))
  page.attach(contract())
  assert.equal(page.activate(2), true)
  assert.equal(page.options.shading, 'baked')
  assert.equal(page.notes(), SHADING.help)
  page.activate(2)
  assert.equal(page.options.shading, 'vertex')
  page.activate(2)
  assert.equal(page.options.shading, 'field')
  page.adjust(2, -1)
  assert.equal(page.options.shading, 'vertex')
  assert.equal(applied.length, 5)
  assert.equal(Object.hasOwn(page.options, 'normalsDebug'), false)
  assert.equal(Object.hasOwn(JSON.parse(store.data.get(GRAPHICS_KEY)!), 'normalsDebug'), false)
})

test('legacy sdf and texture values migrate before validation', () => {
  for (const [saved, expected] of [['sdf', 'field'], ['texture', 'baked']]) {
    const page = new GraphicsSettings(memoryStore(JSON.stringify({ shading: saved })), () => {})
    page.attach(contract())
    assert.equal(page.options.shading, expected)
  }
})

test('invalid saved values use the default, report validation issues, and exclude normalsDebug from storage', () => {
  const store = memoryStore(JSON.stringify({ shading: 'invalid', normalsDebug: true }))
  const page = new GraphicsSettings(store, () => {})
  const messages: string[] = []
  const warn = console.warn
  console.warn = message => messages.push(String(message))
  try { page.attach(contract()) } finally { console.warn = warn }
  assert.equal(page.options.shading, 'field')
  assert.equal(Object.hasOwn(page.options, 'normalsDebug'), false)
  assert.ok(messages.some(message => message.includes('shading')))
  assert.ok(messages.some(message => message.includes('normalsDebug')))
  page.activate(2)
  const stored = JSON.parse(store.data.get(GRAPHICS_KEY)!) as Record<string, unknown>
  assert.equal(Object.hasOwn(stored, 'normalsDebug'), false)
})


test('MEDIUM defaults apply to absent settings and saved settings take precedence', () => {
  const received: Record<string, unknown>[] = []
  const c = contract()
  const validate = c.validate
  c.validate = input => { received.push(input as Record<string, unknown>); return validate(input) }
  const page = new GraphicsSettings(memoryStore(JSON.stringify({ shading: 'baked', showFps: true })), () => {})
  page.attach(c)
  assert.deepEqual(received[0], { shading: 'baked', aoQuality: 2, renderScale: 1, postBloom: true, postGrading: true, jiggle: 'all', showFps: true })
  assert.equal(page.options.shading, 'baked')
  assert.equal(page.options.showFps, true)
})

test('without MAMA the page says so and has no rows', () => {
  const page = new GraphicsSettings(memoryStore(), () => {})
  page.attach(null)
  assert.deepEqual(page.items(), [])
  assert.equal(page.notes(), 'Graphics options come from MAMA, which this build does not include.')
  assert.equal(page.adjust(0, 1), false)
  assert.equal(page.activate(0), false)
  page.reset()
  assert.deepEqual(page.items(), [])
  assert.match(page.notes(), /MAMA/)
})

test('number items use discrete positions; adjustment clamps and activation wraps', () => {
  const store = memoryStore()
  const applied: Record<string, unknown>[] = []
  const page = new GraphicsSettings(store, options => applied.push({ ...options }))
  page.attach(contract())
  const index = page.items().findIndex(item => item.label === 'Render scale')
  assert.equal(page.items()[index].control, 'slider')
  assert.equal(page.items()[index].fraction, 0.4)
  for (let i = 0; i < 4; i++) page.adjust(index, 1)
  assert.equal(page.options.renderScale, 2)
  assert.equal(page.items()[index].fraction, 1)
  assert.equal(JSON.parse(store.data.get(GRAPHICS_KEY)!).renderScale, 2)
  assert.equal(applied.at(-1)!.renderScale, 2)
  assert.equal(page.activate(index), true)
  assert.equal(page.options.renderScale, 0.5)
  page.adjust(index, -1)
  assert.equal(page.options.renderScale, 0.5)
  assert.equal(page.items()[index].fraction, 0)
})

test('range-based numbers use min, max and step and retain contract labels', () => {
  const c = contract()
  const label = c.label
  c.label = (spec, value) => spec.key === 'aoQuality' ? spec.valueLabels![value as number] : label(spec, value)
  const page = new GraphicsSettings(memoryStore(), () => {})
  page.attach(c)
  const index = page.items().findIndex(item => item.label === 'Ambient occlusion')
  assert.equal(page.items()[index].value, 'Medium')
  assert.equal(page.items()[index].fraction, 0.5)
  page.adjust(index, -1)
  assert.equal(page.options.aoQuality, 1)
  assert.equal(page.items()[index].value, 'Low')
  const strength = page.items().findIndex(item => item.label === 'Screen strength')
  page.activate(strength)
  for (let i = 0; i < 3; i++) page.adjust(strength, 1)
  assert.equal(page.options.postStrength, 0.3)
  assert.equal(page.items()[strength].fraction, 0.3)
})

test('reset restores validated DEFAULT_GRAPHICS, saves and applies them', () => {
  const store = memoryStore(JSON.stringify({ shading: 'vertex', renderScale: 2, showFps: true }))
  const applied: Record<string, unknown>[] = []
  const page = new GraphicsSettings(store, options => applied.push({ ...options }))
  const c = contract()
  page.attach(c)
  const reset = page.items().length - 1
  assert.deepEqual(page.items()[reset], { label: 'Reset graphics to defaults', value: '', control: 'action',
    help: 'Puts every graphics option back to its default.' })
  assert.equal(page.adjust(reset, 1), false)
  for (const index of [-1, reset + 1, 0.5]) {
    assert.equal(page.adjust(index, 1), false)
    assert.equal(page.activate(index), false)
  }
  const expected = c.validate(DEFAULT_GRAPHICS).options
  page.reset()
  assert.deepEqual(page.options, expected)
  assert.deepEqual(JSON.parse(store.data.get(GRAPHICS_KEY)!), expected)
  assert.deepEqual(applied.at(-1), expected)
  page.activate(1)
  assert.equal(page.options.showFps, true)
  assert.equal(page.activate(reset), true)
  assert.deepEqual(page.options, expected)
})

test('baking controls are shown by the contract and carry nextLoad', () => {
  const page = new GraphicsSettings(memoryStore(), () => {})
  page.attach(contract())
  assert.ok(!page.items().some(item => item.nextLoad))
  page.activate(2)
  for (const label of ['Bake texel density', 'Bake size cap']) {
    const index = page.items().findIndex(item => item.label === label)
    assert.equal(page.items()[index].nextLoad, true)
    page.adjust(index, 1)
    assert.equal(page.notes(), `${page.items()[index].help} Applies when the next scene loads.`)
  }
})

test('unavailable shading choices keep their contract reason and are skipped in both directions', () => {
  const specs = SPECS.map(spec => spec.key !== 'shading' ? spec : { ...spec,
    choices: spec.choices!.map(choice => choice.value !== 'baked' ? choice : { ...choice, unavailable: 'no bake support' }),
  })
  const page = new GraphicsSettings(memoryStore(), () => {})
  page.attach(contract(specs))
  const index = page.items().findIndex(item => item.label === SHADING.label)
  assert.match(page.notes(), /Baked texture \(normal\/material\): no bake support/)
  assert.equal(page.items()[index].count, 2)
  assert.equal(page.items()[index].help, `${SHADING.help} Unavailable: Baked texture (normal/material) - no bake support.`)
  page.activate(index)
  assert.equal(page.options.shading, 'vertex')
  assert.equal(page.items()[index].index, 1)
  assert.equal(page.notes(), page.items()[index].help)
  page.adjust(index, -1)
  assert.equal(page.options.shading, 'field')
})

test('row capacity reserves the final item for reset', () => {
  const extra: GraphicsSpec[] = Array.from({ length: 20 }, (_, i) => ({
    key: `extra${i}`, section: 'frame', kind: 'toggle', default: false, label: `Extra ${i}`, help: 'Extra option.',
  }))
  const page = new GraphicsSettings(memoryStore(), () => {})
  page.attach(contract([...SPECS, ...extra]))
  assert.equal(page.items().length, SETTINGS_ROW_SLOTS)
  assert.equal(page.items().at(-1)!.control, 'action')
  page.activate(1)
  assert.equal(page.items()[1].value, 'On')
  assert.equal(page.notes(), 'FPS counter.')
})
