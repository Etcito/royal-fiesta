import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin } from 'vite'
import { repoRoot } from '../../../../tools/bricks.ts'
import type { RfCompileResult } from '../../../../tools/egeScripts.ts'

// The Vite config runner closes before build hooks; load the compiler with Node.
const importNodeModule = new Function('url', 'return import(url)') as (url: string) => Promise<typeof import('../../../../tools/egeScripts.ts')>
const compilerModule = () => importNodeModule(pathToFileURL(join(repoRoot(), 'tools/egeScripts.ts')).href)

const assetPath = 'ege/rf-scripts.wasm'

function compiledBytes(result: RfCompileResult, formatRfDiagnostic: typeof import('../../../../tools/egeScripts.ts').formatRfDiagnostic): Uint8Array {
  if (result.diagnostics.some(diagnostic => diagnostic.severity === 'error')) {
    throw new Error('rf-ege-scripts: script compile failed\n' + result.diagnostics.map(formatRfDiagnostic).join('\n'))
  }
  if (result.wasm === null) throw new Error('rf-ege-scripts: compiler returned no wasm')
  return result.wasm
}

export function rfEgeScripts(): Plugin {
  let cachedKey: string | undefined
  let cachedCompile: Promise<Uint8Array> | undefined

  return {
    name: 'rf-ege-scripts',
    async generateBundle() {
      const { compileRfScripts, formatRfDiagnostic } = await compilerModule()
      const wasm = compiledBytes(await compileRfScripts(), formatRfDiagnostic)
      this.emitFile({ type: 'asset', fileName: assetPath, source: wasm })
    },
    configureServer(server) {
      server.middlewares.use('/ege/rf-scripts.wasm', async (_req, res) => {
        try {
          const { collectRfScripts, compileRfScripts, formatRfDiagnostic } = await compilerModule()
          const root = repoRoot()
          const files = collectRfScripts(root)
          const schemaText = readFileSync(join(root, 'ege.schema.json'), 'utf8')
          const key = JSON.stringify([files, schemaText])
          if (key !== cachedKey || cachedCompile === undefined) {
            cachedKey = key
            cachedCompile = compileRfScripts({ root, overrides: files }).then(result => compiledBytes(result, formatRfDiagnostic))
          }
          const wasm = await cachedCompile
          res.setHeader('Content-Type', 'application/wasm')
          res.end(Buffer.from(wasm))
        } catch (error) {
          res.statusCode = 500
          res.end(error instanceof Error ? error.message : String(error))
        }
      })
    },
  }
}
