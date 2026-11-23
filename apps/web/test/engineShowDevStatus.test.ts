import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ScriptReloadStatus } from '../src/engineShowDev/reload.ts'
import { createScriptStatus, drawScriptStatus, scriptStatusLines, SCRIPT_APPLIED_SIGNAL } from '../src/engineShowDev/status.ts'

function status(overrides: Partial<ScriptReloadStatus> = {}): ScriptReloadStatus {
  return {
    state: 'idle',
    revision: 0,
    appliedRevision: 0,
    generation: 1,
    moduleKey: '',
    error: null,
    diagnostics: [],
    applies: 0,
    ...overrides,
  }
}

test('scriptStatusLines reports idle, applied and rejected statuses in contract order', () => {
  assert.deepEqual(scriptStatusLines(status(), 0), ['script: idle', 'generation 1 revision 0', 'module ', 'faults 0'])
  const applied = status({ state: 'applied', generation: 2, appliedRevision: 5, moduleKey: 'abcdef123456', applies: 1 })
  assert.deepEqual(scriptStatusLines(applied, 0), ['script: applied', 'generation 2 revision 5', 'module abcdef12', 'faults 0'])
  const long = 'x'.repeat(200)
  const diagnostics = Array.from({ length: 7 }, (_, index) => `scripts/ege/a${index}.as.ts:1:1 TS${index} ${long}`)
  const rejected = status({ state: 'rejected', error: 'compile failed', diagnostics })
  const lines = scriptStatusLines(rejected, 3)
  assert.deepEqual(lines.slice(0, 5), [
    'script: rejected',
    'generation 1 revision 0',
    'module ',
    'faults 3',
    'error: compile failed',
  ])
  assert.equal(lines.length, 5 + 5)
  for (const line of lines.slice(5)) assert.equal(line.length, 120)
  assert.ok(lines.slice(5).every((line, index) => line === diagnostics[index].slice(0, 120)))
})

interface Call {
  op: string
  args: unknown[]
}

function recordingContext(): { context: { font: string; fillStyle: string; fillRect(...args: number[]): void; fillText(text: string, x: number, y: number): void }; calls: Call[] } {
  const calls: Call[] = []
  const context = {
    font: '',
    fillStyle: '',
    fillRect: (...args: number[]) => {
      calls.push({ op: 'fillRect', args })
    },
    fillText: (text: string, x: number, y: number) => {
      calls.push({ op: 'fillText', args: [text, x, y] })
    },
  }
  return { context, calls }
}

test('drawScriptStatus paints the panel rectangle then one text line per entry', () => {
  const { context, calls } = recordingContext()
  drawScriptStatus(context, ['first', 'second'], 1920)
  assert.equal(context.font, '28px monospace')
  assert.equal(context.fillStyle, '#ffffff')
  assert.deepEqual(calls, [
    { op: 'fillRect', args: [1920 - 584, 24, 560, 44 + 2 * 34] },
    { op: 'fillText', args: ['first', 1920 - 564, 58] },
    { op: 'fillText', args: ['second', 1920 - 564, 58 + 34] },
  ])
})

interface FakeElement {
  id: string
  dataset: Record<string, string>
  textContent: string
  remove(): void
}

function fakeRoot(): { root: HTMLElement; children: FakeElement[] } {
  const children: FakeElement[] = []
  const document = {
    createElement: (): FakeElement => ({
      id: '',
      dataset: {},
      textContent: '',
      remove() {
        const index = children.indexOf(this)
        if (index >= 0) children.splice(index, 1)
      },
    }),
  }
  const root = {
    ownerDocument: document,
    appendChild: (element: FakeElement) => {
      children.push(element)
      return element
    },
  }
  return { root: root as unknown as HTMLElement, children }
}

test('createScriptStatus records applied signals, keeps the last lines and disposes its element', () => {
  const { root, children } = fakeRoot()
  const panel = createScriptStatus(root)
  assert.equal(children.length, 1)
  assert.equal(children[0].id, 'script-status')
  panel.update(status({ state: 'applied', applies: 1, generation: 2, appliedRevision: 2, moduleKey: 'abcdef123456' }), 0)
  assert.deepEqual(panel.signals(), [SCRIPT_APPLIED_SIGNAL])
  assert.equal(children[0].dataset.state, 'applied')
  panel.update(status({ state: 'rejected', applies: 1, generation: 2, appliedRevision: 2, moduleKey: 'abcdef123456', error: 'bad', diagnostics: ['scripts/ege/x.as.ts:1:1 TS1 y'] }), 1)
  assert.deepEqual(panel.signals(), [SCRIPT_APPLIED_SIGNAL])
  assert.equal(children[0].dataset.state, 'rejected')
  assert.deepEqual(panel.lines(), ['script: rejected', 'generation 2 revision 2', 'module abcdef12', 'faults 1', 'error: bad', 'scripts/ege/x.as.ts:1:1 TS1 y'])
  assert.equal(children[0].textContent, panel.lines().join('\n'))
  panel.update(status({ state: 'applied', applies: 2, generation: 3, appliedRevision: 3, moduleKey: 'fedcba654321' }), 1)
  assert.deepEqual(panel.signals(), [SCRIPT_APPLIED_SIGNAL, SCRIPT_APPLIED_SIGNAL])
  panel.dispose()
  assert.equal(children.length, 0)
})
