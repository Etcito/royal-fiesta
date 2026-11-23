// One-process modeler save -> filesystem compile -> save again -> compile -> verified restore, then stage
// the accepted bytes and both publications for the local swap. Contract G7-SWAP-STAGED-EVENTS.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { repoRoot } from './bricks.ts'
import type { Diagnostic } from '@etcito/game-engine-compile'
import {
  collectRfScripts, createRfPublicationManager, formatRfDiagnostic,
  type PublicationEvent, type RfPublicationOptions,
} from './egeScripts.ts'
import { sdfmApi, sdfmDir } from './renderViews.ts'

export const SWAP_EVENTS_FILE = 'ege/swap/events.json'
export const SWAP_WASM_FILE = 'ege/swap/rf-scripts.wasm'
export const DEMO_GAME = 'royal-fiesta'
export const DEMO_SCRIPT = 'scripts/ege/character/constants.as.ts'
export const DEMO_FROM = 'export const CHAR_JUMP_SPEED: f64 = 7.5'
export const DEMO_TO = 'export const CHAR_JUMP_SPEED: f64 = 15.0'
export const BROKEN_TO = 'export const CHAR_JUMP_SPEED: f64 = 15.0 +'

function fail(message: string): never {
  throw new Error(`saved-script: ${message}`)
}

export interface SavedScriptModeler {
  call(name: string, input?: unknown): Promise<{ text?: string; data?: unknown }>
  close(): Promise<void>
}

export interface SavedScriptSaveOptions {
  page: string
  modeler?: SavedScriptModeler
  compile?: RfPublicationOptions['compile']
  sources?: string
}

export interface SavedScriptSaveResult {
  folder: string
  rejected: PublicationEvent
  accepted: PublicationEvent
  restored: boolean
}

interface Baseline { moduleKey: string; schemaKey: number }
interface GameEntry { id: string; folder: string }

function fileAt(root: string, path: string): Buffer | null {
  const full = join(root, path)
  return existsSync(full) ? readFileSync(full) : null
}

function readBaseline(page: string): Baseline {
  const path = join(page, 'ege', 'rf-publication.json')
  if (!existsSync(path)) fail(`${path} is missing; build the web page first`)
  const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  const source = (typeof raw.publication === 'object' && raw.publication !== null ? raw.publication : raw) as Record<string, unknown>
  const moduleKey = source.moduleKey
  const schemaKey = source.schemaKey
  if (typeof moduleKey !== 'string' || typeof schemaKey !== 'number') {
    fail(`${path} does not name a moduleKey and a schemaKey; build the web page first`)
  }
  return { moduleKey, schemaKey }
}

async function defaultModeler(): Promise<SavedScriptModeler> {
  const { createSdfm } = await sdfmApi(sdfmDir(repoRoot()))
  return createSdfm({})
}

async function registeredGame(modeler: SavedScriptModeler): Promise<string> {
  const result = await modeler.call('game_list')
  const games = (result.data as { games?: GameEntry[] } | undefined)?.games ?? []
  const game = games.find(entry => entry.id === DEMO_GAME)
  if (game === undefined) {
    fail(`the modeler has no registered game '${DEMO_GAME}'; register a disposable checkout (SDFM_GAMES=<folder>) before the swap stage`)
  }
  if (game.folder.includes('/repos/local/')) fail(`${game.folder} is not a disposable checkout; register an isolated clone`)
  return game.folder
}

async function verifyCheckout(modeler: SavedScriptModeler, folder: string, sources: string): Promise<void> {
  const result = await modeler.call('script_list', { game: DEMO_GAME })
  const data = result.data as { scriptsDir?: string; scripts?: Array<{ path: string }> } | undefined
  if (data?.scriptsDir !== 'scripts/ege') {
    fail(`the registered game scripts folder is '${data?.scriptsDir ?? ''}', not 'scripts/ege'; check out this commit there`)
  }
  const listed = data?.scripts ?? []
  if (!listed.some(entry => entry.path === DEMO_SCRIPT)) fail(`the registered checkout is missing ${DEMO_SCRIPT}; check out this commit there`)
  const names = new Set<string>(collectRfScripts(sources).map(file => file.name))
  for (const entry of listed) if (entry.path.startsWith('scripts/ege/')) names.add(entry.path.slice('scripts/ege/'.length))
  for (const name of names) {
    const path = `scripts/ege/${name}`
    if (path === DEMO_SCRIPT) continue
    const build = fileAt(sources, path)
    const registered = fileAt(folder, path)
    if (build === null || registered === null || !build.equals(registered)) {
      fail(`the registered checkout differs from this build at ${path}; check out this commit there`)
    }
  }
  const build = fileAt(sources, 'ege.schema.json')
  const registered = fileAt(folder, 'ege.schema.json')
  if (build === null || registered === null || !build.equals(registered)) {
    fail('the registered checkout differs from this build at ege.schema.json; check out this commit there')
  }
}

async function scriptText(modeler: SavedScriptModeler, path: string): Promise<string> {
  const result = await modeler.call('script_read', { game: DEMO_GAME, path })
  const text = (result.data as { text?: string } | undefined)?.text
  if (typeof text !== 'string') fail(`the modeler returned no text for ${path}`)
  return text
}

async function writeScript(modeler: SavedScriptModeler, text: string): Promise<void> {
  await modeler.call('script_write', { game: DEMO_GAME, path: DEMO_SCRIPT, text })
}

function assertSaved(folder: string, expected: string): void {
  const actual = readFileSync(join(folder, DEMO_SCRIPT), 'utf8')
  if (actual !== expected) fail(`${join(folder, DEMO_SCRIPT)} does not hold the text the modeler just saved`)
}

function compiledErrors(diagnostics: readonly Diagnostic[]): string {
  const errors = diagnostics.filter(d => d.severity === 'error').map(formatRfDiagnostic)
  return errors.length > 0 ? errors.join('; ') : 'no runnable publication'
}

function brokenSave(original: string): string {
  return original.replace(DEMO_FROM, BROKEN_TO)
}

async function rejectedSave(modeler: SavedScriptModeler, folder: string, manager: ReturnType<typeof createRfPublicationManager>, text: string): Promise<PublicationEvent> {
  await writeScript(modeler, text)
  assertSaved(folder, text)
  const event = await manager.request()
  if (event === null) fail('the compile of the rejected save was superseded')
  if (event.status !== 'failure' || event.publication !== null || !event.diagnostics.some(d => d.severity === 'error')) {
    fail(`the rejected save compiled without an error diagnostic: ${compiledErrors(event.diagnostics)}`)
  }
  return event
}

async function acceptedSave(modeler: SavedScriptModeler, folder: string, manager: ReturnType<typeof createRfPublicationManager>, text: string, baseline: Baseline): Promise<PublicationEvent> {
  await writeScript(modeler, text)
  assertSaved(folder, text)
  const event = await manager.request()
  if (event === null) fail('the compile of the accepted save was superseded')
  if (event.status !== 'success' || event.publication === null) fail(`the accepted save did not compile: ${compiledErrors(event.diagnostics)}`)
  const publication = event.publication
  if (publication.schemaKey !== baseline.schemaKey) {
    fail(`the registered checkout compiles schema key ${publication.schemaKey} but the built page uses ${baseline.schemaKey}; rebuild the page from this checkout`)
  }
  if (publication.moduleKey === baseline.moduleKey) {
    fail("the registered checkout compiles the built page's module key; save a script change before the swap stage")
  }
  return { ...event, publication: { ...publication, wasmUrl: SWAP_WASM_FILE } }
}

export async function runSavedScriptSave(options: SavedScriptSaveOptions): Promise<SavedScriptSaveResult> {
  const sources = options.sources ?? repoRoot()
  const baseline = readBaseline(options.page)
  const created = options.modeler === undefined
  const modeler = options.modeler ?? await defaultModeler()
  try {
    const folder = await registeredGame(modeler)
    await verifyCheckout(modeler, folder, sources)
    const original = await scriptText(modeler, DEMO_SCRIPT)
    const hits = original.split(DEMO_FROM).length - 1
    if (hits !== 1) fail(`${join(folder, DEMO_SCRIPT)} holds ${JSON.stringify(DEMO_FROM)} ${hits} times, not once; check out this commit there`)
    const manager = createRfPublicationManager({ root: folder, compile: options.compile })
    let rejected: PublicationEvent
    let accepted: PublicationEvent
    try {
      rejected = await rejectedSave(modeler, folder, manager, brokenSave(original))
      accepted = await acceptedSave(modeler, folder, manager, original.replace(DEMO_FROM, DEMO_TO), baseline)
    } finally {
      await writeScript(modeler, original)
      if (!readFileSync(join(folder, DEMO_SCRIPT)).equals(Buffer.from(original, 'utf8'))) {
        fail(`could not restore ${join(folder, DEMO_SCRIPT)}`)
      }
    }
    const wasm = manager.wasmFor(accepted.revision)
    if (wasm === null) fail('the accepted publication bytes are unavailable')
    mkdirSync(join(options.page, 'ege', 'swap'), { recursive: true })
    writeFileSync(join(options.page, SWAP_WASM_FILE), wasm)
    const document = {
      format: 'royal-fiesta.saved-script-events',
      version: 1,
      game: DEMO_GAME,
      script: DEMO_SCRIPT,
      baseline,
      events: [rejected, accepted],
    }
    writeFileSync(join(options.page, SWAP_EVENTS_FILE), `${JSON.stringify(document, null, 2)}\n`)
    return { folder, rejected, accepted, restored: true }
  } finally {
    if (created) await modeler.close()
  }
}

/**
 * Handoff: the card "Swap inventory, its validator test and the swap command registration" (#9224) runs
 * `main` as its g7-swap-save command; today main parses `--page <dir>`, calls runSavedScriptSave and stages
 * `ege/swap/events.json` beside `ege/swap/rf-scripts.wasm`. State/keys: it reads `<page>/ege/rf-publication.json`
 * {moduleKey, schemaKey} and writes the two staged files; errors print and exit 1, usage exits 2.
 */
export async function main(argv: string[]): Promise<number> {
  if (argv.length !== 2 || argv[0] !== '--page' || argv[1] === '') {
    console.error('usage: node --experimental-strip-types tools/savedScriptSave.ts --page <built page dir>')
    return 2
  }
  try {
    const result = await runSavedScriptSave({ page: argv[1] })
    const moduleKey = result.accepted.publication?.moduleKey ?? ''
    console.log(`saved-script: staged revision ${result.accepted.revision} (module ${moduleKey}) and rejected revision ${result.rejected.revision} with ${result.rejected.diagnostics.length} diagnostics into ${join(argv[1], 'ege', 'swap')}; restored ${DEMO_SCRIPT} in ${result.folder}`)
    return 0
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2))
