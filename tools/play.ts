import { spawn } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildContentIndex, contentDir } from './content.ts'
import { repoRoot } from './bricks.ts'
import { MeshBaker, meshTimeoutMs } from './meshBake.ts'

// Ported from the V0 M11 play tool, on the public dependency path: the RAA release comes from
// package.json, so there is no raaBuild step, no sibling and no vite preview.
//
// Test-only seams (internal, never documented for players):
// - RF_PLAY_SKIP_BUILD=1 skips audio:bake and the web build;
// - RF_PLAY_DIST=<dir> serves <dir> instead of apps/web/dist.

const HOST = '127.0.0.1'
const DEFAULT_PORT = 5173

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.avif': 'image/avif',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
}

function run(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolveExit, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit' })
    child.once('error', reject)
    child.once('close', (code) => resolveExit(code ?? 1))
  })
}

async function build(root: string): Promise<number> {
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const bake = await run(npm, ['run', 'audio:bake'], root)
  if (bake !== 0) return bake
  return run(npm, ['run', 'build', '-w', '@royal-fiesta/web'], root)
}

export function serveDir(dist: string, baker = new MeshBaker()): Server {
  const base = resolve(dist)
  const scan = (): void => { void baker.scan().catch(error => console.error(`mesh: ${error.message}`)) }
  let interval: ReturnType<typeof setInterval> | undefined
  const server = createServer((req, res) => {
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      res.writeHead(400).end('bad request')
      return
    }
    const mesh = /^\/(?:content\/)?meshes\/([a-f0-9]{64})$/.exec(path)
    if (mesh) {
      const key = mesh[1]
      const base = join(baker.cache, key)
      const headers = { 'cache-control': 'no-store', 'x-mesh-timeout-ms': String(meshTimeoutMs()) }
      if (existsSync(base + '.mesh')) {
        res.writeHead(200, { ...headers, 'content-type': 'application/octet-stream' })
        res.end(req.method === 'HEAD' ? undefined : readFileSync(base + '.mesh'))
      } else if (existsSync(base + '.failed')) {
        res.writeHead(422, { ...headers, 'content-type': 'text/plain; charset=utf-8' }).end(readFileSync(base + '.failed'))
      } else if (baker.pending.has(key) || existsSync(base + '.lock')) {
        res.writeHead(202, { ...headers, 'retry-after': '1' }).end('Building meshes on the server')
      } else res.writeHead(404, headers).end('unknown mesh')
      return
    }
    if (path === '/content/index.json') {
      try {
        res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : JSON.stringify(buildContentIndex()))
      } catch {
        res.writeHead(500).end('cannot build content index')
      }
      return
    }
    const live = path.startsWith('/content/')
    const requestBase = live ? contentDir() : base
    if (live) path = path.slice('/content'.length)
    // Live content is only the asset and course files: the content directory may be the repository root.
    if (live && !/^\/(assets|courses)\/[^/]+(\/[^/]+)?\.(asset|course)\.json$/.test(path)) {
      res.writeHead(404).end('not found')
      return
    }
    if (path.endsWith('/')) path += 'index.html'
    const file = normalize(join(requestBase, path))
    // Never serve outside the selected build or content directory.
    if (file !== requestBase && !file.startsWith(requestBase + sep)) {
      res.writeHead(403).end('forbidden')
      return
    }
    if (!existsSync(file) || !statSync(file).isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }).end('not found')
      return
    }
    const type = TYPES[extname(file).toLowerCase()] ?? 'application/octet-stream'
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' })
    res.end(req.method === 'HEAD' ? undefined : readFileSync(file))
  })
  server.once('listening', () => { scan(); interval = setInterval(scan, 2000) })
  server.once('close', () => { clearInterval(interval); baker.stop() })
  return server
}

// strictPort: a busy port is refused, never replaced by another one.
function listen(server: Server, port: number): Promise<string | null> {
  return new Promise((resolveListen) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      resolveListen(error.code === 'EADDRINUSE'
        ? `[bricks] port ${port}: in use; stop the other server`
        : `[bricks] port ${port}: ${error.message}; choose another port with --port`)
    })
    server.listen(port, HOST, () => resolveListen(null))
  })
}

function close(server: Server): Promise<void> {
  return new Promise((resolveClose) => {
    server.closeAllConnections()
    server.close(() => resolveClose())
  })
}

function firstJsAsset(dist: string): string | null {
  const dir = join(dist, 'assets')
  if (!existsSync(dir)) return null
  const js = readdirSync(dir).filter((name) => name.endsWith('.js')).sort()
  return js.length > 0 ? `assets/${js[0]}` : null
}

async function check(dist: string, port: number): Promise<number> {
  const asset = firstJsAsset(dist)
  if (asset === null) {
    console.error(`[bricks] ${join(dist, 'assets')}: no built JS asset; run npm run build`)
    return 1
  }
  let failed = 0
  for (const path of ['game.html', 'play.html', asset]) {
    const url = `http://${HOST}:${port}/${path}`
    let status = 0
    try {
      const res = await fetch(url)
      await res.arrayBuffer()
      status = res.status
    } catch (error) {
      console.error(`play: GET /${path} failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    console.log(`play: GET /${path} ${status}`)
    if (status !== 200) failed++
  }
  if (failed > 0) {
    console.error(`[bricks] ${dist}: ${failed} page(s) did not answer 200; run npm run build`)
    return 1
  }
  console.log('play: check PASS')
  return 0
}

export async function play(opts: { check: boolean; port?: number }): Promise<number> {
  const port = opts.port ?? DEFAULT_PORT
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(`[bricks] port ${port}: invalid; use an integer from 1 to 65535`)
    return 1
  }
  const root = repoRoot()
  if (process.env.RF_PLAY_SKIP_BUILD !== '1') {
    const code = await build(root)
    if (code !== 0) return code
  }
  const dist = resolve(process.env.RF_PLAY_DIST ?? join(root, 'apps', 'web', 'dist'))

  const server = serveDir(dist)
  const refused = await listen(server, port)
  if (refused !== null) {
    console.error(refused)
    return 1
  }
  console.log(`play: http://localhost:${port}/game.html`)

  if (opts.check) {
    try {
      return await check(dist, port)
    } finally {
      await close(server)
    }
  }

  return new Promise((resolveExit) => {
    const stop = (code: number) => (): void => {
      void close(server).then(() => resolveExit(code))
    }
    process.once('SIGINT', stop(130))
    process.once('SIGTERM', stop(143))
  })
}

function parseArgs(argv: string[]): { check: boolean; port?: number } {
  const opts: { check: boolean; port?: number } = { check: false }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--check') opts.check = true
    else if (arg === '--port') {
      const value = argv[++i]
      if (value === undefined) throw new Error('missing value for --port')
      opts.port = Number(value)
    } else if (arg.startsWith('--port=')) opts.port = Number(arg.slice('--port='.length))
    else throw new Error(`unknown option ${arg}`)
  }
  return opts
}

export async function main(argv: string[]): Promise<number> {
  let opts: { check: boolean; port?: number }
  try {
    opts = parseArgs(argv)
  } catch (error) {
    console.error(`play: ${error instanceof Error ? error.message : String(error)}`)
    console.error('usage: npm run play [-- --check] [--port <1..65535>]')
    return 1
  }
  return play(opts)
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
