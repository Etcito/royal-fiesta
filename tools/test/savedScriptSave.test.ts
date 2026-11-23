import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import type { RfCompileResult } from '../egeScripts.ts'
import {
  BROKEN_TO, DEMO_FROM, DEMO_SCRIPT, DEMO_TO, SWAP_EVENTS_FILE, SWAP_WASM_FILE,
  main, runSavedScriptSave, type SavedScriptModeler,
} from '../savedScriptSave.ts'

const ERROR = {
  file: 'character/constants.as.ts', line: 1, column: 1, endLine: 1, endColumn: 2,
  severity: 'error', code: 'TS1005', message: 'Expression expected',
} as const

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'rf-saved-script-'))
  const page = join(root, 'page')
  const folder = join(root, 'game')
  mkdirSync(join(page, 'ege'), { recursive: true })
  mkdirSync(join(folder, 'scripts', 'ege', 'character'), { recursive: true })
  const original = `${DEMO_FROM}\nexport const CHAR_MASS: f64 = 2\n`
  writeFileSync(join(folder, DEMO_SCRIPT), original)
  writeFileSync(join(folder, 'ege.schema.json'), '{"format":"ege.schema","version":1}\n')
  return { root, page, folder, sources: folder, original }
}

function writeBaseline(page: string, schemaKey = 42, moduleKey = 'baseline-module'): void {
  const publication = { revision: 3, moduleKey, schemaKey, wasmUrl: 'ege/rf-scripts.wasm?revision=3', diagnostics: [] }
  writeFileSync(join(page, 'ege', 'rf-publication.json'), `${JSON.stringify(publication, null, 2)}\n`)
}

function scriptsOf(folder: string): Array<{ path: string; size: number }> {
  const out: Array<{ path: string; size: number }> = []
  const visit = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name
      if (entry.isDirectory()) visit(join(dir, entry.name), relative)
      else if (entry.isFile() && entry.name.endsWith('.as.ts')) {
        out.push({ path: `scripts/ege/${relative}`, size: readFileSync(join(dir, entry.name)).length })
      }
    }
  }
  visit(join(folder, 'scripts', 'ege'), '')
  return out
}

function modeler(folder: string, games: Array<{ id: string; folder: string }>): SavedScriptModeler {
  return {
    async call(name, input) {
      const args = (input ?? {}) as { game?: string; path?: string; text?: string }
      if (name === 'game_list') return { data: { games, conflicts: [] } }
      if (name === 'script_list') {
        return { data: { game: args.game, schema: 'ege.schema.json', scriptsDir: 'scripts/ege', scripts: scriptsOf(folder), scenes: [] } }
      }
      if (name === 'script_read') {
        const path = args.path as string
        return { data: { path, text: readFileSync(join(folder, path), 'utf8'), readOnly: false } }
      }
      if (name === 'script_write') {
        const path = args.path as string
        const text = args.text as string
        writeFileSync(join(folder, path), text)
        return { data: { path, bytes: Buffer.byteLength(text), previous: null } }
      }
      throw new Error(`unexpected modeler tool ${name}`)
    },
    async close() {},
  }
}

function fakeCompile(mode: (text: string) => 'ok' | 'bad' = text => text.includes('15.0 +') ? 'bad' : 'ok') {
  const seen: string[] = []
  const compile = async ({ root }: { root?: string }): Promise<RfCompileResult> => {
    const text = readFileSync(join(root as string, DEMO_SCRIPT), 'utf8')
    seen.push(text)
    if (mode(text) === 'bad') {
      return { wasm: null, diagnostics: [ERROR], files: [], cacheKey: '', fromCache: false, schemaKey: null }
    }
    return {
      wasm: Uint8Array.from([1, 2, 3, 4]), diagnostics: [], files: ['character/constants.as.ts'],
      cacheKey: `cache-${seen.length}-${text.length}`, fromCache: false, schemaKey: 42,
    }
  }
  return { seen, compile }
}

test('success stages the accepted bytes and both events and restores the script', async () => {
  const f = fixture()
  writeBaseline(f.page)
  const fake = fakeCompile()
  const result = await runSavedScriptSave({
    page: f.page, sources: f.sources, modeler: modeler(f.folder, [{ id: 'royal-fiesta', folder: f.folder }]), compile: fake.compile,
  })
  const events = JSON.parse(readFileSync(join(f.page, SWAP_EVENTS_FILE), 'utf8'))
  assert.equal(events.format, 'royal-fiesta.saved-script-events')
  assert.equal(events.version, 1)
  assert.equal(events.game, 'royal-fiesta')
  assert.equal(events.script, DEMO_SCRIPT)
  assert.deepEqual(events.baseline, { moduleKey: 'baseline-module', schemaKey: 42 })
  assert.equal(events.events.length, 2)
  assert.equal(events.events[0].status, 'failure')
  assert.equal(events.events[0].publication, null)
  assert.equal(events.events[0].diagnostics.filter((d: { severity: string }) => d.severity === 'error').length, 1)
  assert.equal(events.events[1].status, 'success')
  assert.equal(events.events[1].publication.wasmUrl, SWAP_WASM_FILE)
  assert.ok(events.events[1].revision > events.events[0].revision)
  assert.deepEqual([...readFileSync(join(f.page, SWAP_WASM_FILE))], [1, 2, 3, 4])
  assert.equal(readFileSync(join(f.folder, DEMO_SCRIPT), 'utf8'), f.original)
  assert.deepEqual(fake.seen, [f.original.replace(DEMO_FROM, BROKEN_TO), f.original.replace(DEMO_FROM, DEMO_TO)])
  assert.equal(result.folder, f.folder)
  assert.equal(result.restored, true)
  assert.equal(result.accepted.publication?.wasmUrl, SWAP_WASM_FILE)
})

test('an accepted compile failure rejects naming the cause and restores the original', async () => {
  const f = fixture()
  writeBaseline(f.page)
  const fake = fakeCompile(text => text.includes('15.0') ? 'bad' : 'ok')
  await assert.rejects(runSavedScriptSave({
    page: f.page, sources: f.sources, modeler: modeler(f.folder, [{ id: 'royal-fiesta', folder: f.folder }]), compile: fake.compile,
  }), /saved-script: the accepted save did not compile: .*Expression expected/s)
  assert.equal(readFileSync(join(f.folder, DEMO_SCRIPT), 'utf8'), f.original)
  assert.equal(existsSync(join(f.page, 'ege', 'swap')), false)
})

test('a game_list without royal-fiesta is refused', async () => {
  const f = fixture()
  writeBaseline(f.page)
  await assert.rejects(runSavedScriptSave({
    page: f.page, sources: f.sources, modeler: modeler(f.folder, []), compile: fakeCompile().compile,
  }), /saved-script: the modeler has no registered game 'royal-fiesta'/)
})

test('a baseline schema key that differs from the compile is refused before staging', async () => {
  const f = fixture()
  writeBaseline(f.page, 41)
  await assert.rejects(runSavedScriptSave({
    page: f.page, sources: f.sources, modeler: modeler(f.folder, [{ id: 'royal-fiesta', folder: f.folder }]), compile: fakeCompile().compile,
  }), /saved-script: the registered checkout compiles schema key 42 but the built page uses 41/)
  assert.equal(readFileSync(join(f.folder, DEMO_SCRIPT), 'utf8'), f.original)
  assert.equal(existsSync(join(f.page, 'ege', 'swap')), false)
})

test('main refuses unknown arguments with exit code 2', async () => {
  assert.equal(await main(['--bogus']), 2)
})
