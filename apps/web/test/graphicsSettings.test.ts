import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import test from 'node:test'
import { mamaSource } from '../../../tools/bricks.ts'
import { GRAPHICS_KEY, GraphicsSettings, type GraphicsContract, type GraphicsSpec } from '../src/game/graphicsSettings.ts'

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
]

function contract(): GraphicsContract {
  const defaults = Object.fromEntries(SPECS.map(spec => [spec.key, spec.default]))
  return {
    specs: SPECS,
    sections: [{ id: 'frame', label: 'Frame' }, { id: 'shading', label: 'Shading' }, { id: 'detail', label: 'Detail' }],
    validate(input) {
      const issues: { key: string; message: string }[] = []
      const options: Record<string, unknown> = { ...defaults }
      if (input === undefined || input === null) return { options, issues }
      if (typeof input !== 'object' || Array.isArray(input)) return { options, issues: [{ key: '', message: 'expected an object' }] }
      const given = input as Record<string, unknown>
      for (const key of Object.keys(given)) {
        if (!SPECS.some(spec => spec.key === key)) issues.push({ key, message: 'unknown option' })
      }
      for (const spec of SPECS) {
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
    shown: () => true,
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
  assert.equal(page.options.shading, 'vertex')
  assert.ok(page.model('').buttons.some(button => button.label === 'Surface shading: Vertex'))
})

test('the copied test contract matches the pinned MAMA shading spec when available', () => {
  if (MAMA_SHADING === null) return
  const shading = SPECS.find(spec => spec.key === 'shading')!
  assert.equal(shading.default, MAMA_SHADING.default)
  assert.equal(shading.label, MAMA_SHADING.label)
  assert.deepEqual(shading.help, MAMA_SHADING.help)
  assert.deepEqual(shading.choices?.map(choice => ({ value: choice.value, label: choice.label })), MAMA_SHADING.choices)
})

test('rows disable unavailable choices and stepping skips them', () => {
  const page = new GraphicsSettings(memoryStore(), () => {})
  page.attach(contract())
  const model = page.model('hint')
  assert.deepEqual(model.buttons.map(button => button.label), [
    'Frame rate: 60 fps', 'Vmax: unavailable', 'Show FPS: Off', 'Surface shading: Vertex', 'LOD offset: unavailable', 'Back',
  ])
  assert.deepEqual([1, 4].map(index => page.props()[`row-${index}`].disabled), [true, true])
  assert.equal(page.activate(1), false)
  assert.equal(page.activate(0), true)
  assert.equal(page.options.frameRate, 'cap60')
  assert.match(model.lines[0]!, /Unavailable - Vmax: not supported in this test; LOD offset: one level/)
})

test('shading choices step in MAMA order and show the spec help after a change', () => {
  const store = memoryStore(JSON.stringify({ shading: 'field' }))
  const applied: Record<string, unknown>[] = []
  const page = new GraphicsSettings(store, options => applied.push({ ...options }))
  page.attach(contract())
  assert.equal(page.activate(3), true)
  assert.equal(page.options.shading, 'baked')
  assert.equal(page.model('').lines[0], `${SHADING.help} Applies when the next scene loads.`)
  page.activate(3)
  assert.equal(page.options.shading, 'vertex')
  page.activate(3)
  assert.equal(page.options.shading, 'field')
  page.activate(3, -1)
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


test('LOW defaults apply to absent settings and saved settings take precedence', () => {
  const received: Record<string, unknown>[] = []
  const c = contract()
  const validate = c.validate
  c.validate = input => { received.push(input as Record<string, unknown>); return validate(input) }
  const page = new GraphicsSettings(memoryStore(JSON.stringify({ shading: 'baked', showFps: true })), () => {})
  page.attach(c)
  assert.deepEqual(received[0], { shading: 'baked', aoQuality: 0, renderScale: 0.75, postBloom: false, postGrading: false, jiggle: 'local', showFps: true })
  assert.equal(page.options.shading, 'baked')
  assert.equal(page.options.showFps, true)
})

test('without MAMA the page says so and has no rows', () => {
  const page = new GraphicsSettings(memoryStore(), () => {})
  page.attach(null)
  assert.deepEqual(page.model('').buttons.map(button => button.label), ['Back'])
  assert.match(page.model('').lines[0]!, /MAMA/)
})
