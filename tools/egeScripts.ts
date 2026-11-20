import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { loadEngine } from '@etcito/game-engine'
import { schemaLayout } from '@etcito/game-engine/script'
import { createScriptCompiler, memoryCache, type CompileResult, type Diagnostic, type SdkBundle } from '@etcito/game-engine-compile'
import { repoRoot } from './bricks.ts'

export interface RfScriptFile { name: string; text: string }

const byName = (a: RfScriptFile, b: RfScriptFile): number => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name))

export function collectRfScripts(root: string = repoRoot()): RfScriptFile[] {
  const base = join(root, 'scripts', 'ege')
  const files: RfScriptFile[] = []
  function visit(dir: string, prefix: string): void {
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch (error) {
      if (dir === base && (error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw error
    }
    for (const entry of entries) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name
      const path = join(dir, entry.name)
      if (entry.isDirectory()) visit(path, name)
      else if (entry.isFile() && name.endsWith('.as.ts')) files.push({ name, text: readFileSync(path, 'utf8') })
    }
  }
  visit(base, '')
  return files.sort(byName)
}

export interface RfCompileResult {
  wasm: Uint8Array | null
  diagnostics: Diagnostic[]
  files: string[]
  /** The compiler's cache key of this exact result; '' when the compiler refused before keying. */
  cacheKey?: string
  /** True when the compiler served this result from its cache (identical inputs). */
  fromCache?: boolean
  /** The loaded engine schema key of the compiled schema; null without runnable bytes. */
  schemaKey?: number | null
}

type RfCompiler = {
  compile(files: RfScriptFile[], schemaText: string): Promise<CompileResult>
  schemaKey(schemaText: string): number
}
let compiler: Promise<RfCompiler> | null = null

export function rfCompiler(): Promise<RfCompiler> {
  compiler ??= createCompiler().catch((error: unknown) => {
    compiler = null
    throw error
  })
  return compiler
}

async function createCompiler(): Promise<RfCompiler> {
  const sdk = JSON.parse(readFileSync(fileURLToPath(import.meta.resolve('@etcito/game-engine-compile/sdk.json')), 'utf8')) as SdkBundle
  const engine = await loadEngine()
  const scripts = createScriptCompiler({
    loadAsc: async () => import('assemblyscript/asc'),
    sdk,
    layout: async schemaText => {
      engine.setSchema(schemaText)
      return schemaLayout(engine)
    },
    cache: memoryCache(),
  })
  return {
    compile: (files, schemaText) => scripts.compileScripts(files, schemaText),
    schemaKey: schemaText => {
      engine.setSchema(schemaText)
      return schemaLayout(engine).key
    },
  }
}

/**
 * Handoff: compileRfScripts supplies the sorted compile set and process-wide compiler to
 * AssemblyScript script core and round clock and Vite plugin compiling the scripts and its config entry (ege-build 3/3, web-boot bounded edit).
 */
export async function compileRfScripts(options: { root?: string; overrides?: RfScriptFile[] } = {}): Promise<RfCompileResult> {
  const root = options.root ?? repoRoot()
  const files = new Map(collectRfScripts(root).map(file => [file.name, file]))
  for (const file of options.overrides ?? []) files.set(file.name, file)
  const ordered = [...files.values()].sort(byName)
  const schemaText = readFileSync(join(root, 'ege.schema.json'), 'utf8')
  const compiler = await rfCompiler()
  const result = await compiler.compile(ordered, schemaText)
  const schemaKey = result.wasm === null ? null : compiler.schemaKey(schemaText)
  return {
    wasm: result.wasm,
    diagnostics: result.diagnostics,
    files: ordered.map(file => file.name),
    cacheKey: result.cacheKey,
    fromCache: result.fromCache,
    schemaKey,
  }
}

/** Identity of one admitted engine script module; `moduleKey` is opaque and never derived from bytes. */
export interface EngineModuleIdentity { backend: 'engine'; schemaKey: number; moduleKey: string }

export interface ScriptPublication {
  revision: number
  moduleKey: string
  schemaKey: number
  wasmUrl: string
  diagnostics: readonly Diagnostic[]
}

/** Contract G7-PUBLICATION-EVENT payload, sent as the Vite custom event `rf:script-publication`. */
export interface PublicationEvent {
  revision: number
  status: 'success' | 'failure'
  publication: ScriptPublication | null
  diagnostics: readonly Diagnostic[]
}

export const RF_PUBLICATION_EVENT = 'rf:script-publication'
export const RF_PUBLICATION_FILE = 'rf-publication.json'
export const RF_PUBLICATION_WASM = 'rf-scripts.wasm'
const RF_PUBLICATION_FORMAT = 'royal-fiesta.ege-publication'
const IDENTITY_LIMIT = 64

export interface RfPublicationOptions {
  root?: string
  /** Directory persisting runnable bytes and their identity beside each other; memory only when absent. */
  dir?: string
  /** URL path the publication URLs extend with `?revision=<n>`. */
  wasmPath?: string
  /** Replaces compileRfScripts (tests, alternative compilers). */
  compile?: (options: { root?: string; overrides?: RfScriptFile[] }) => Promise<RfCompileResult>
}

export interface RfPublicationManager {
  /** Highest request revision issued so far (0 before any request). */
  readonly revision: number
  /** Starts a request; resolves to its event, or null when a newer request superseded it. */
  request(overrides?: RfScriptFile[]): Promise<PublicationEvent | null>
  /** The retained runnable publication with the latest settled request's diagnostics; rejects when none exists. */
  read(): Promise<ScriptPublication>
  /** The bytes a publication URL's revision names, for as long as this manager retains them. */
  wasmFor(revision: number): Uint8Array | null
  /** Subscribes to admitted (non-superseded) events; returns the unsubscribe function. */
  onPublication(listener: (event: PublicationEvent) => void): () => void
}

interface PersistedPublication {
  format: string
  latestRevision: number
  settled: { revision: number; status: 'success' | 'failure'; diagnostics: Diagnostic[] }
  publication: ScriptPublication | null
  wasmBytes: number
  identities: Array<[string, string]>
}

const failureDiagnostic = (message: string): Diagnostic =>
  ({ file: '', line: 0, column: 0, endLine: 0, endColumn: 0, severity: 'error', code: 'EGE2000', message })

function writeAtomic(path: string, data: string | Uint8Array): void {
  const temp = `${path}.tmp`
  writeFileSync(temp, data)
  renameSync(temp, path)
}

function loadPersisted(dir: string): { state: PersistedPublication; wasm: Uint8Array | null } | null {
  const path = join(dir, RF_PUBLICATION_FILE)
  if (!existsSync(path)) return null
  try {
    const state = JSON.parse(readFileSync(path, 'utf8')) as PersistedPublication
    if (state.format !== RF_PUBLICATION_FORMAT || !Number.isSafeInteger(state.latestRevision)) return null
    let wasm: Uint8Array | null = null
    if (state.publication !== null) {
      const bytes = existsSync(join(dir, RF_PUBLICATION_WASM)) ? readFileSync(join(dir, RF_PUBLICATION_WASM)) : null
      wasm = bytes !== null && bytes.length === state.wasmBytes ? new Uint8Array(bytes) : null
    }
    return { state, wasm }
  } catch {
    return null
  }
}

/**
 * Handoff: createRfPublicationManager supplies the revision bookkeeping, retained-publication semantics and
 * the exact event payload to G7.1 Identity, inputs and world construction: serve publications and register
 * functional commands (apps/web/src/engineRound/scriptsPlugin.ts); today the manager's
 * onPublication(listener) delivers each non-superseded PublicationEvent, request(overrides) issues a revision,
 * wasmFor(revision) returns the bytes behind each publication URL, and readRfPublication(manager) is the read
 * API; the manager itself sends nothing through Vite and registers no command.
 */
export function createRfPublicationManager(options: RfPublicationOptions = {}): RfPublicationManager {
  const compile = options.compile ?? compileRfScripts
  const wasmPath = options.wasmPath ?? '/ege/rf-scripts.wasm'
  const identities = new Map<string, string>()
  const bytesByModule = new Map<string, Uint8Array>()
  const moduleOfRevision = new Map<number, string>()
  const listeners = new Set<(event: PublicationEvent) => void>()
  let waiters: Array<() => void> = []
  let latest = 0
  let settledRevision = 0
  let settledDiagnostics: readonly Diagnostic[] = []
  let retained: ScriptPublication | null = null

  const persisted = options.dir === undefined ? null : loadPersisted(options.dir)
  if (persisted !== null) {
    latest = persisted.state.latestRevision
    settledRevision = persisted.state.settled.revision
    settledDiagnostics = persisted.state.settled.diagnostics
    for (const [cacheKey, moduleKey] of persisted.state.identities) identities.set(cacheKey, moduleKey)
    if (persisted.state.publication !== null && persisted.wasm !== null) {
      retained = persisted.state.publication
      bytesByModule.set(retained.moduleKey, persisted.wasm)
      moduleOfRevision.set(retained.revision, retained.moduleKey)
    }
  }

  function persist(status: 'success' | 'failure'): void {
    if (options.dir === undefined) return
    mkdirSync(options.dir, { recursive: true })
    const wasm = retained === null ? null : bytesByModule.get(retained.moduleKey) ?? null
    if (wasm !== null) writeAtomic(join(options.dir, RF_PUBLICATION_WASM), wasm)
    const state: PersistedPublication = {
      format: RF_PUBLICATION_FORMAT,
      latestRevision: latest,
      settled: { revision: settledRevision, status, diagnostics: [...settledDiagnostics] },
      publication: retained,
      wasmBytes: wasm?.length ?? 0,
      identities: [...identities],
    }
    writeAtomic(join(options.dir, RF_PUBLICATION_FILE), `${JSON.stringify(state, null, 2)}\n`)
  }

  function admit(revision: number, result: RfCompileResult | null, error: unknown): PublicationEvent {
    const diagnostics = result?.diagnostics.slice() ?? [failureDiagnostic(`script compile failed: ${error instanceof Error ? error.message : String(error)}`)]
    const runnable = result !== null && result.wasm !== null && !diagnostics.some(d => d.severity === 'error')
    let status: 'success' | 'failure' = 'failure'
    if (runnable && typeof result.schemaKey === 'number' && Number.isSafeInteger(result.schemaKey)) {
      const cacheKey = result.cacheKey ?? ''
      // The association is made once per exact compiler result: a cached result keeps its key, an edit gets a new one.
      let moduleKey = cacheKey === '' ? undefined : identities.get(cacheKey)
      if (moduleKey === undefined) moduleKey = randomUUID()
      if (cacheKey !== '') {
        identities.delete(cacheKey)
        identities.set(cacheKey, moduleKey)
        while (identities.size > IDENTITY_LIMIT) identities.delete(identities.keys().next().value as string)
      }
      if (!bytesByModule.has(moduleKey)) bytesByModule.set(moduleKey, new Uint8Array(result.wasm as Uint8Array))
      moduleOfRevision.set(revision, moduleKey)
      retained = { revision, moduleKey, schemaKey: result.schemaKey, wasmUrl: `${wasmPath}?revision=${revision}`, diagnostics: [...diagnostics] }
      status = 'success'
    } else if (runnable) {
      diagnostics.push(failureDiagnostic('script compile produced bytes without a loaded schema key'))
    }
    settledRevision = revision
    settledDiagnostics = diagnostics
    persist(status)
    return { revision, status, publication: retained, diagnostics: [...diagnostics] }
  }

  async function request(overrides?: RfScriptFile[]): Promise<PublicationEvent | null> {
    const revision = ++latest
    let result: RfCompileResult | null = null
    let error: unknown
    try {
      result = await compile({ root: options.root, overrides })
    } catch (caught) {
      error = caught
    }
    if (revision !== latest) return null
    const event = admit(revision, result, error)
    for (const listener of listeners) listener(event)
    const ready = waiters
    waiters = []
    for (const wake of ready) wake()
    return event
  }

  async function read(): Promise<ScriptPublication> {
    while (settledRevision !== latest) await new Promise<void>(resolve => waiters.push(resolve))
    if (retained === null) {
      const detail = settledDiagnostics.filter(d => d.severity === 'error').map(formatRfDiagnostic)
      throw new Error('rf-ege-scripts: no runnable script publication exists; '
        + (latest === 0 ? 'request a build (npm run ege:build) or save a script under scripts/ege first'
          : `fix the script errors and save again${detail.length > 0 ? `:\n${detail.join('\n')}` : ''}`))
    }
    return { ...retained, diagnostics: [...settledDiagnostics] }
  }

  return {
    get revision() { return latest },
    request,
    read,
    wasmFor: revision => {
      const moduleKey = moduleOfRevision.get(revision)
      return moduleKey === undefined ? null : bytesByModule.get(moduleKey) ?? null
    },
    onPublication: listener => {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}

let defaultPublication: RfPublicationManager | null = null

/**
 * Reads the retained runnable publication of `manager` (the process default over out/ege when omitted); a
 * default manager that was never requested compiles first. Rejects with an actionable error without bytes.
 */
export async function readRfPublication(manager?: RfPublicationManager): Promise<ScriptPublication> {
  const target = manager ?? (defaultPublication ??= createRfPublicationManager({ dir: join(repoRoot(), 'out', 'ege') }))
  if (manager === undefined && target.revision === 0) await target.request()
  return target.read()
}

export function formatRfDiagnostic(d: Diagnostic): string {
  const path = d.file === 'components.gen.ts' ? 'generated/components.gen.ts'
    : d.file.startsWith('ege/') ? `sdk/${d.file.slice(4)}`
      : `scripts/ege/${d.file}`
  return `${path}:${d.line}:${d.column} ${d.code} ${d.message}`
}

export async function main(argv: string[]): Promise<number> {
  const check = argv.length === 1 && argv[0] === 'check'
  const build = argv.length === 3 && argv[0] === 'build' && argv[1] === '--out' && !!argv[2]
  if (!check && !build) {
    console.error('usage: node --experimental-strip-types tools/egeScripts.ts check | build --out <dir>')
    return 2
  }
  try {
    const manager = createRfPublicationManager(build ? { dir: argv[2] } : {})
    const event = await manager.request()
    const diagnostics = event?.diagnostics ?? []
    for (const diagnostic of diagnostics) console.log(formatRfDiagnostic(diagnostic))
    const errors = diagnostics.filter(d => d.severity === 'error').length
    const warnings = diagnostics.filter(d => d.severity === 'warning').length
    if (build) {
      const publication = event?.publication ?? null
      writeFileSync(join(argv[2], 'build.json'), `${JSON.stringify({
        files: collectRfScripts().map(file => file.name),
        errors,
        warnings,
        ...(publication === null ? {} : { revision: publication.revision, moduleKey: publication.moduleKey, schemaKey: publication.schemaKey }),
      }, null, 2)}\n`)
    }
    return errors > 0 ? 1 : 0
  } catch (error) {
    console.error(`ege-scripts: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2))
