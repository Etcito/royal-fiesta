import assert from 'node:assert/strict'
import test from 'node:test'
import { GRAPHICS_KEY, GraphicsSettings, type GraphicsContract, type GraphicsSpec } from '../src/game/graphicsSettings.ts'

// A small contract with the shape of MAMA's render-options (the real one stays private behind virtual:rf-mama).
const SPECS: GraphicsSpec[] = [
  { key: 'frameRate', section: 'frame', kind: 'choice', label: 'Frame rate', help: 'Frame cap.', default: 'cap60',
    choices: [{ value: 'cap60', label: '60 fps' }, { value: 'vmax', label: 'Vmax' }] },
  { key: 'showFps', section: 'frame', kind: 'toggle', label: 'Show FPS', help: 'FPS counter.', default: false },
  { key: 'shading', section: 'shading', kind: 'choice', label: 'Surface shading', help: 'Normals.', default: 'field',
    choices: [{ value: 'field', label: 'Field' }, { value: 'vertex', label: 'Vertex' },
      { value: 'baked', label: 'Baked', unavailable: 'needs the UV bake' }] },
  { key: 'lodOffset', section: 'detail', kind: 'number', label: 'LOD offset', help: 'LOD.', default: 0, unavailable: 'one level' },
]

function contract(): GraphicsContract {
  const defaults = Object.fromEntries(SPECS.map(s => [s.key, s.default]))
  return {
    specs: SPECS,
    sections: [{ id: 'frame', label: 'Frame' }, { id: 'shading', label: 'Shading' }, { id: 'detail', label: 'Detail' }],
    validate(input) {
      const issues: { key: string; message: string }[] = []
      const options: Record<string, unknown> = { ...defaults }
      const given = (input ?? {}) as Record<string, unknown>
      for (const spec of SPECS) {
        if (!Object.hasOwn(given, spec.key)) continue
        const value = given[spec.key]
        const ok = spec.unavailable === undefined && (spec.kind === 'toggle' ? typeof value === 'boolean'
          : spec.choices?.some(c => c.value === value && c.unavailable === undefined) ?? typeof value === 'number')
        if (ok) options[spec.key] = value
        else issues.push({ key: spec.key, message: 'refused' })
      }
      return { options, issues }
    },
    step(spec, value, dir) {
      if (spec.kind === 'toggle') return !value
      const values = (spec.choices ?? []).filter(c => c.unavailable === undefined).map(c => c.value)
      return values[(values.indexOf(value) + dir + values.length) % values.length]
    },
    label(spec, value) {
      if (spec.kind === 'toggle') return value === true ? 'On' : 'Off'
      return spec.choices?.find(c => c.value === value)?.label ?? String(value)
    },
    shown: () => true,
  }
}

function memoryStore(initial: string | null = null) {
  const data = new Map<string, string>()
  if (initial !== null) data.set(GRAPHICS_KEY, initial)
  return { data, getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => { data.set(k, v) } }
}

test('the Graphics page lists the contract rows (Royal Fiesta LOW defaults), the unavailable ones disabled with their reason', () => {
  const page = new GraphicsSettings(memoryStore(), () => {})
  page.attach(contract())
  page.openPage()
  const model = page.model('hint')
  assert.equal(model.title, 'Graphics')
  assert.deepEqual(model.buttons.map(b => b.label),
    ['Frame rate: 60 fps', 'Show FPS: Off', 'Surface shading: Vertex', 'Baked: unavailable', 'LOD offset: unavailable', 'Back'])
  const props = page.props()
  assert.deepEqual([0, 1, 2, 3, 4].map(i => props[`row-${i}`].disabled), [false, false, false, true, true])
  assert.match(model.lines[0], /^Unavailable - Baked: needs the UV bake; LOD offset: one level$/)
})

test('a row press steps, saves and applies the option; a disabled row does nothing', () => {
  const store = memoryStore()
  const applied: Record<string, unknown>[] = []
  const page = new GraphicsSettings(store, o => applied.push({ ...o }))
  page.attach(contract())
  assert.equal(applied.length, 1)
  assert.equal(page.activate(0), true)
  assert.equal(page.options.frameRate, 'vmax')
  assert.equal(page.activate(1), true)
  assert.equal(page.options.showFps, true)
  assert.deepEqual(JSON.parse(store.data.get(GRAPHICS_KEY)!), { frameRate: 'vmax', showFps: true, shading: 'vertex', lodOffset: 0 })
  assert.equal(page.activate(3), false)
  assert.equal(page.activate(4), false)
  assert.equal(applied.length, 3)
  page.activate(2)
  assert.equal(page.options.shading, 'field', 'stepping skips the unavailable Baked choice')
  assert.match(page.model('').lines[0], /Applies when the next scene loads\.$/)
  page.activate(2)
  assert.equal(page.options.shading, 'vertex')
})

test('saved choices load through the contract; refused ones fall back to their default', () => {
  const page = new GraphicsSettings(memoryStore(JSON.stringify({ frameRate: 'vmax', shading: 'baked' })), () => {})
  const warn = console.warn
  console.warn = () => {}
  try {
    page.attach(contract())
  } finally {
    console.warn = warn
  }
  assert.equal(page.options.frameRate, 'vmax')
  assert.equal(page.options.shading, 'field')
})

test('without MAMA the page says so and has no rows', () => {
  const page = new GraphicsSettings(memoryStore(), () => {})
  page.attach(null)
  const model = page.model('')
  assert.deepEqual(model.buttons.map(b => b.label), ['Back'])
  assert.match(model.lines[0], /MAMA/)
})
