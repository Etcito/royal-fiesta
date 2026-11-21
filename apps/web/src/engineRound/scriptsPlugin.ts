import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Plugin } from 'vite'
import { repoRoot } from '../../../../tools/bricks.ts'
import type { PublicationEvent, RfPublicationOptions } from '../../../../tools/egeScripts.ts'

// The Vite config runner closes before build hooks; load the compiler with Node.
const importNodeModule = new Function('url', 'return import(url)') as (url: string) => Promise<typeof import('../../../../tools/egeScripts.ts')>
const compilerModule = () => importNodeModule(pathToFileURL(join(repoRoot(), 'tools/egeScripts.ts')).href)

const assetPath = 'ege/rf-scripts.wasm'

export interface RfEgeScriptsOptions {
  root?: string
  /** Directory persisting the runnable bytes and `rf-publication.json` beside each other. */
  dir?: string
  /** URL path the publication URLs extend with `?revision=<n>` (default `/ege/rf-scripts.wasm`). */
  wasmPath?: string
  /** Replaces compileRfScripts (tests, alternative compilers). */
  compile?: RfPublicationOptions['compile']
  /** Compile once when the dev server starts (default true). */
  initial?: boolean
}

export function rfEgeScripts(options: RfEgeScriptsOptions = {}): Plugin {
  const root = options.root ?? repoRoot()
  const publicationOptions: RfPublicationOptions = {
    root,
    dir: options.dir ?? join(root, 'out', 'ege'),
    wasmPath: options.wasmPath,
    compile: options.compile,
  }
  const wasmPath = options.wasmPath ?? '/ege/rf-scripts.wasm'
  const publicationPath = wasmPath.replace(/[^/]*$/, '') + 'rf-publication.json'

  return {
    name: 'rf-ege-scripts',
    async generateBundle() {
      const { createRfPublicationManager, formatRfDiagnostic } = await compilerModule()
      const manager = createRfPublicationManager(publicationOptions)
      const event = await manager.request()
      if (event === null || event.status !== 'success' || event.publication === null) {
        throw new Error('rf-ege-scripts: script compile failed\n'
          + (event?.diagnostics ?? []).map(formatRfDiagnostic).join('\n'))
      }
      const wasm = manager.wasmFor(event.publication.revision)
      if (wasm === null) throw new Error('rf-ege-scripts: the accepted publication bytes are unavailable')
      this.emitFile({ type: 'asset', fileName: assetPath, source: wasm })
      this.emitFile({ type: 'asset', fileName: assetPath.replace(/[^/]*$/, '') + 'rf-publication.json', source: `${JSON.stringify(event.publication, null, 2)}\n` })
    },
    configureServer(server) {
      const ready = compilerModule().then(({ createRfPublicationManager, RF_PUBLICATION_EVENT }) => {
        const manager = createRfPublicationManager(publicationOptions)
        manager.onPublication((event: PublicationEvent) => {
          server.ws.send({ type: 'custom', event: RF_PUBLICATION_EVENT, data: event })
        })
        return { manager }
      })
      let inflight: Promise<void> | null = null
      let queued = false
      const refresh = (): void => {
        if (inflight !== null) {
          queued = true
          return
        }
        inflight = (async () => {
          try {
            do {
              queued = false
              const { collectRfScripts } = await compilerModule()
              const { manager } = await ready
              await manager.request(collectRfScripts(root))
            } while (queued)
          } catch (error) {
            console.error(`rf-ege-scripts: ${error instanceof Error ? error.message : String(error)}`)
          } finally {
            inflight = null
          }
        })()
      }
      server.middlewares.use(async (request, response, next) => {
        const url = new URL(request.url ?? '/', 'http://localhost')
        if (url.pathname !== wasmPath && url.pathname !== publicationPath) {
          next()
          return
        }
        try {
          const { manager } = await ready
          if (url.pathname === publicationPath) {
            const publication = await manager.read()
            response.setHeader('Content-Type', 'application/json; charset=utf-8')
            response.setHeader('Cache-Control', 'no-cache')
            response.end(JSON.stringify(publication))
            return
          }
          const requested = url.searchParams.get('revision')
          let bytes: Uint8Array | null
          if (requested === null) {
            const publication = await manager.read()
            bytes = manager.wasmFor(publication.revision)
          } else {
            const revision = Number(requested)
            bytes = Number.isSafeInteger(revision) && revision > 0 ? manager.wasmFor(revision) : null
          }
          if (bytes === null) {
            response.statusCode = 404
            response.end(`rf-ege-scripts: no retained script publication for ${requested === null ? 'the current revision' : `revision ${requested}`}`)
            return
          }
          response.setHeader('Content-Type', 'application/wasm')
          response.setHeader('Cache-Control', 'no-cache')
          response.end(Buffer.from(bytes))
        } catch (error) {
          response.statusCode = 500
          response.end(error instanceof Error ? error.message : String(error))
        }
      })
      const schemaFile = join(root, 'ege.schema.json').replaceAll('\\', '/')
      const scriptsDir = join(root, 'scripts', 'ege').replaceAll('\\', '/')
      const savedScriptChange = (file: string): boolean => {
        const changed = file.replaceAll('\\', '/')
        return changed === schemaFile
          || changed === scriptsDir
          || (changed.startsWith(`${scriptsDir}/`) && changed.endsWith('.as.ts'))
      }
      server.watcher.add([join(root, 'ege.schema.json'), join(root, 'scripts', 'ege')])
      server.watcher.on('all', (_event, file) => {
        if (savedScriptChange(file)) refresh()
      })
      if (options.initial !== false) refresh()
    },
  }
}
