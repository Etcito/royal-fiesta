import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
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
}

type RfCompiler = { compile(files: RfScriptFile[], schemaText: string): Promise<CompileResult> }
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
  return { compile: (files, schemaText) => scripts.compileScripts(files, schemaText) }
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
  const result = await (await rfCompiler()).compile(ordered, schemaText)
  return { wasm: result.wasm, diagnostics: result.diagnostics, files: ordered.map(file => file.name) }
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
    const result = await compileRfScripts()
    for (const diagnostic of result.diagnostics) console.log(formatRfDiagnostic(diagnostic))
    const errors = result.diagnostics.filter(d => d.severity === 'error').length
    const warnings = result.diagnostics.filter(d => d.severity === 'warning').length
    if (build) {
      mkdirSync(argv[2], { recursive: true })
      if (result.wasm !== null) writeFileSync(join(argv[2], 'rf-scripts.wasm'), result.wasm)
      writeFileSync(join(argv[2], 'build.json'), `${JSON.stringify({ files: result.files, errors, warnings }, null, 2)}\n`)
    }
    return errors > 0 ? 1 : 0
  } catch (error) {
    console.error(`ege-scripts: ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) process.exitCode = await main(process.argv.slice(2))
