import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { dirname, join, resolve } from 'node:path'
import { createServer, type Connect, type Plugin } from 'vite'
import { mamaSource } from './bricks.ts'

// Derive the live roots from the same file: manifests npm/Kong install. Vite follows
// symlinks, so allow/watch their real paths rather than a node_modules cache copy.
export function liveDependencies(root: string): { names: string[]; roots: string[] } {
  const names = new Set<string>()
  const roots = new Set<string>([root])
  for (const file of ['package.json', 'apps/web/package.json']) {
    const manifest = join(root, file)
    const pkg = JSON.parse(readFileSync(manifest, 'utf8'))
    for (const [name, spec] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (typeof spec !== 'string' || !spec.startsWith('file:')) continue
      names.add(name)
      const dir = resolve(dirname(manifest), spec.slice(5))
      if (existsSync(dir)) roots.add(realpathSync(dir))
    }
  }
  const mama = mamaSource(root)
  if (mama.kind !== 'absent') {
    names.add('@etcito/mama')
    roots.add(mama.dir)
  }
  return { names: [...names], roots: [...roots] }
}

export async function devServer(root: string, port: number, host: string, middleware: Connect.NextHandleFunction) {
  const live = liveDependencies(root)
  const httpServer = createHttpServer()
  let reload: ReturnType<typeof setTimeout> | undefined
  const routes: Plugin = {
    name: 'rf-play-live',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use(middleware)
      // Include wasm and generated files that may not be in the module graph yet.
      server.watcher.add(live.roots.filter(dir => dir !== root))
      server.watcher.on('all', (event, file) => {
        if (!['add', 'change', 'unlink'].includes(event)) return
        if (live.roots.some(dir => dir !== root && file.startsWith(dir + '/'))) {
          // A brick rebuild replaces several glue/wasm files. Let Vite invalidate
          // its module graph and coalesce that burst before reloading the page.
          clearTimeout(reload)
          reload = setTimeout(() => server.ws.send({ type: 'full-reload', path: '*' }), 150)
        }
      })
    },
    closeServer() { clearTimeout(reload) },
  }
  const vite = await createServer({
    // This is the production entry config: one alias table and plugin pipeline.
    configFile: join(root, 'apps/web/anim-brick.vite.config.ts'),
    configLoader: 'runner',
    plugins: [routes],
    // In particular, never put the RAA glue/wasm in an optimized dependency bundle.
    optimizeDeps: { exclude: live.names },
    server: {
      host, port, strictPort: true,
      middlewareMode: true,
      ws: { server: httpServer },
      fs: { strict: true, allow: live.roots },
      headers: { 'Cache-Control': 'no-store', 'X-RF-Play-Mode': 'vite' },
    },
  })
  httpServer.on('request', vite.middlewares)
  return {
    httpServer,
    vite,
    async close(): Promise<void> {
      await vite.close()
      httpServer.closeAllConnections()
      await new Promise<void>(done => httpServer.close(() => done()))
    },
  }
}
