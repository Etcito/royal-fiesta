import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { networkInterfaces } from 'node:os'
import { extname, join, normalize, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildContentIndex, contentDir, shippedContent } from './content.ts'
import { repoRoot } from './bricks.ts'
import type { CameraPose } from '../packages/game/src/render/port.ts'
import type { InteractiveStartInput } from '../apps/web/src/game/ops.ts'
import { sceneCamera } from '../packages/game/src/sceneCamera.ts'
import { quatRotate } from '../packages/sim/src/vec.ts'

// Ported from the V0 M11 play tool, on the public dependency path: the RAA release comes from
// package.json, so there is no raaBuild step, no sibling and no vite preview.
//
// Test-only seams (internal, never documented for players):
// - RF_PLAY_SKIP_BUILD=1 skips audio:bake and the web build;
// - RF_PLAY_DIST=<dir> serves <dir> instead of apps/web/dist.

const HOST = '127.0.0.1'
// The server binds every interface so a phone on the same network can open it (RF_PLAY_HOST=127.0.0.1 keeps it local).
const BIND = process.env.RF_PLAY_HOST ?? '0.0.0.0'
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
  '.mesh': 'application/octet-stream',
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
  const fonts = await run(npm, ['run', 'ui:fonts'], root)
  if (fonts !== 0) return fonts
  return run(npm, ['run', 'build', '-w', '@royal-fiesta/web'], root)
}

// S29: content is served live as saved; there is no server-side meshing (S24 meshes in the browser).
export function serveDir(dist: string): Server {
  const base = resolve(dist)
  const server = createServer((req, res) => {
    let path: string
    try {
      path = decodeURIComponent(new URL(req.url ?? '/', 'http://localhost').pathname)
    } catch {
      res.writeHead(400).end('bad request')
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
    if (path === '/rf-build.json' && !existsSync(join(base, 'rf-build.json'))) {
      // A dev server has no build stamp (wavedash.ts writes one into a built upload): answer an empty one, a 404 is a console error.
      res.writeHead(200, { 'content-type': TYPES['.json'], 'cache-control': 'no-store' })
      res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ commit: null, builtAt: 'dev' }))
      return
    }
    const live = path.startsWith('/content/')
    const requestBase = live ? contentDir() : base
    if (live) path = path.slice('/content'.length)
    // Live content is only the game files: the content directory may be the repository root.
    if (live && !/^\/(?:courses\/[^/]+(?:\/[^/]+)?\.course\.json|courses\/[^/]+\.thumb\.avif|assets\/[^/]+\/[^/]+\.(?:asset\.json|mesh|thumb\.avif)|audio\/[^/]+\.haa\.json)$/.test(path)) {
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
    server.listen(port, BIND, () => resolveListen(null))
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
  if (BIND !== '127.0.0.1') {
    for (const list of Object.values(networkInterfaces())) {
      for (const net of list ?? []) {
        if (net.family === 'IPv4' && !net.internal) console.log(`play (phone, same network): http://${net.address}:${port}/game.html`)
      }
    }
  }

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

// CPU checks live here because card 7143 owns only play.ts, ops.ts, commands.json and the minimal main.ts fix.
async function interactiveApi() {
  const { runInNewContext } = await import('node:vm')
  const { transpileModule, ModuleKind } = await import('typescript')
  const compile = (source: string, context: Record<string, unknown> = {}) => {
    const exports: Record<string, any> = {}
    runInNewContext(transpileModule(source, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports, setTimeout, ...context })
    return exports
  }
  const source = readFileSync('apps/web/src/game/ops.ts', 'utf8')
  const api = compile(source.slice(source.indexOf('export interface InteractiveStartInput'), source.indexOf('interface InteractiveState')))
  return { compile, validate: api.validateInteractiveStart as (raw: unknown) => InteractiveStartInput,
    inView: api.interactiveInView as (camera: CameraPose, box: { min: number[]; max: number[] }) => boolean }
}

async function checkSceneRetention(): Promise<void> {
  const { compile } = await interactiveApi()
  const source = readFileSync('apps/web/src/game/main.ts', 'utf8')
  const local = source.slice(source.indexOf('class LocalMode implements Mode'))
  const method = (text: string, from: string, to: string) => text.slice(text.indexOf(from), text.indexOf(to))
  const deferred = () => {
    let resolve!: () => void, reject!: (error: Error) => void
    const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no })
    return { promise, resolve, reject }
  }
  for (const outcome of ['ready', 'failed', 'obsolete']) {
    const failure = outcome === 'failed', obsolete = outcome === 'obsolete'
    const gate = deferred(), visibility = { hub: true, round: false }, labels: (string | null)[] = []
    let warmed = false, released = false
    const exports = compile(`class Subject { ${method(local, '  setVisible(', '  constructor(')}
      ${method(local, '  private async enterRound(', '  private restoreHubScene(')} }; exports.Subject = Subject`, {
      prepareCourse: (_port: unknown, _course: string, o: { progress?: (done: number, total: number) => void }) => {
        o.progress?.(0, 3)
        return gate.promise.then(() => { warmed = true })
      }, courseWarmed: () => warmed,
      renderFrame: (_port: unknown, draw: () => void) => draw(), pendingPipelines: () => 0,
    })
    const subject = new exports.Subject()
    Object.assign(subject, { selection: 0, disposed: false, match: null,
      hubLayer: { setVisible: (v: boolean) => { visibility.hub = v } },
      matchLayer: { port: {}, setVisible: (v: boolean) => { visibility.round = v } },
      presenter: { begin() {}, draw() {}, reaim() {} }, restoreHubScene() {},
      c: { loaded: { ports: [{ render() {} }] }, setLayout() {}, setLoading: (v: string | null) => labels.push(v) },
    })
    const pending = subject.enterRound({ match: { sim: { course: () => ({ id: 'selected' }) }, dispose: () => { released = true } } }, 1)
    subject.setVisible(true)
    assert.deepEqual(visibility, { hub: true, round: false }, 'pending preparation must retain complete previous scenery on every frame')
    assert.equal(labels.at(-1), 'Preparing round... 0/3', 'Play shows readable preparation progress')
    if (obsolete) subject.selection++
    if (failure) gate.reject(new Error('preparation failed'))
    else gate.resolve()
    await pending
    assert.deepEqual(visibility, { hub: failure || obsolete, round: !failure && !obsolete })
    assert.equal(released, failure || obsolete)
    if (failure) assert.match(subject.failure, /preparation failed/)
  }
  for (const outcome of ['ready', 'failed', 'obsolete', 'loading']) {
    const failure = outcome === 'failed', obsolete = outcome === 'obsolete'
    const gate = deferred(), created = deferred()
    let released = false, stopped = false, error = '', loading: string | null = null, prepared = false
    const canvas = { style: { display: '' } }
    const show = { failure: null, models: { loading: outcome === 'loading' }, lookCanvas: { style: { display: 'none' } },
      fits: () => true, adopt() { return this }, preload() {}, roundStage: () => ({ port: {}, course: 'selected' }), dispose() {},
      frame() { this.models.loading = !prepared; this.lookCanvas.style.display = ''; canvas.style.display = 'none' },
    }
    class LocalMode { showRequested = true }
    const exports = compile(`class Subject { ${method(source, '  private async startShow(', '  private unmountShowView(')} }; exports.Subject = Subject`, {
      LocalMode, ShowMode: { create: async () => { await created.promise; return show } }, ShowAdapter: class {},
      prepareCourse: () => gate.promise, neutralInput: () => ({}), messageOf: (e: Error) => e.message,
    })
    const subject = new exports.Subject()
    Object.assign(subject, { loaded: { canvases: [canvas] }, query: {}, mode: new LocalMode(), showAhead: null, showLoad: 0,
      wornLook: () => null, showOptions: () => ({}), disposed: false, setLayout() {},
      stopMode: () => { stopped = true }, releaseLobby: () => { released = true },
      loadingOverlay: { show: (v: string) => { loading = v }, hide: () => { loading = null } }, host: { setLoading() {} },
      fail: (v: string) => { error = v }, nav: { dispatch() {} }, run() {},
    })
    const pending = subject.startShow()
    assert.equal(released || stopped, false, 'show creation retains the previous mode and lobby')
    created.resolve()
    await new Promise<void>(resolve => setTimeout(resolve, 0))
    assert.equal(released || stopped, false, 'creating a show is not complete selected-scene preparation')
    assert.equal(loading, 'Preparing show')
    assert.equal(canvas.style.display, '', 'the complete lobby canvas stays displayed during show preparation')
    assert.equal(show.lookCanvas.style.display, 'none', 'a preparing show never replaces the lobby canvas')
    prepared = true
    if (obsolete) subject.showLoad++
    if (failure) gate.reject(new Error('show preparation failed'))
    else gate.resolve()
    await pending
    assert.equal(released, !failure && !obsolete)
    assert.equal(stopped, !failure && !obsolete)
    if (failure) assert.match(error, /show preparation failed/)
  }
  // Play on a ?course= page: the selected round starts preparing only once the App holds its LocalMode, so the
  // round-load notifications of that preparation (Course instances, RAA render, ready) keep 'Preparing round...'.
  const constructor = method(local, '  constructor(', '  openCourse(')
  assert.ok(constructor.length > 0 && !/this\.enqueue\(/.test(constructor), 'LocalMode must not start its round from its constructor: the App does not hold the mode yet')
  let notify: (label: string | null) => void = () => {}
  class StubLocal {
    preparing = false
    c: { setLoading(label: string | null): void }
    constructor(c: StubLocal['c']) { this.c = c; notify('Course instances: warm-up'); notify(null) }
    get preparingRound() { return this.preparing }
    openCourse() {
      this.preparing = true
      this.c.setLoading('Preparing round...')
      for (const step of ['Course instances: selected', 'RAA render / pipeline compilation', null]) notify(step)
    }
  }
  const app = compile(`class Subject { ${method(source, '  private startMode(', '  // Play goes online by itself')}
    ${method(source, '  private onRoundLoad(', '  // A mode\'s visible loading state')}
    ${method(source, '  private setRoundLoading(', '  private showLoading(')} }; exports.Subject = Subject`, {
    LocalMode: StubLocal, ShowAdapter: class {}, OnlineMode: class {}, InPageMode: class {}, checkPhase() {},
    messageOf: (e: Error) => e.message, refusal: (...parts: string[]) => parts.join(' '), console,
  })
  const overlay = { label: '', hidden: true }
  let overScene = false
  const shell = new app.Subject()
  Object.assign(shell, { loaded: {}, query: { server: null, clients: 1 }, mode: null, preparedLocal: null, showAhead: null, roundLoading: null,
    pendingRelay: null, orbit: {}, touchOn: false, views: {}, wornLook: () => null, setLayout() {}, stopMode() {},
    fail: (v: string) => { throw new Error(v) }, host: { setLoading() {} },
    loadingOverlay: { show: (v: string, _d?: number, _t?: number, o?: { overScene?: boolean }) => { overlay.label = v; overlay.hidden = false; overScene = o?.overScene === true }, hide: () => { overlay.hidden = true } } })
  notify = label => shell.onRoundLoad(label)
  shell.startMode()
  assert.ok(shell.mode instanceof StubLocal)
  assert.deepEqual(overlay, { label: 'Preparing round...', hidden: false }, 'Play must keep its loading state through the selected round\'s own round-load steps')
  assert.ok(overScene, 'the round loading panel is compact over the retained hub, not an opaque full-screen cover')
  console.info('Scene retention passed: pending frames, successful local/show handoff, failure and obsolete selection retention, Play loading state')
}

async function interactivePreflight(): Promise<InteractiveStartInput> {
  const { validate, inView } = await interactiveApi()
  const dir = contentDir(), ship = await shippedContent(dir), index = buildContentIndex(dir)
  type Placement = { asset: string; t: number[]; r: [number, number, number, number]; s: number[] }
  type Course = { id: string; kind: string; profiles: string[]; scene?: unknown; start?: { spot: { t: number[] } }; spawns: { t: number[]; yawDeg: number }[]; obstacles: Placement[]; decor: Placement[] }
  const courses: Course[] = index.courses.filter(c => ship.courses.has(c.id)).map(c => JSON.parse(readFileSync(join(dir, c.path), 'utf8')))
  const boxes = (course: Course) => [...course.obstacles, ...course.decor].map(item => {
    const entry = index.assets.find(a => a.id === item.asset)
    if (!entry || !ship.assets.has(item.asset)) throw new Error(`interactiveStart: ${course.id} uses unpacked asset ${item.asset}`)
    const { bounds } = JSON.parse(readFileSync(join(dir, entry.path), 'utf8')) as { bounds: { min: number[]; max: number[] } }
    const points = Array.from({ length: 8 }, (_, k) => {
      const v = [0, 1, 2].map(i => (k & (1 << i) ? bounds.max[i] : bounds.min[i]) * item.s[i])
      const r = { x: 0, y: 0, z: 0 }
      quatRotate({ x: item.r[0], y: item.r[1], z: item.r[2], w: item.r[3] }, { x: v[0], y: v[1], z: v[2] }, r)
      return [r.x + item.t[0], r.y + item.t[1], r.z + item.t[2]]
    })
    return { key: item.asset, min: [0, 1, 2].map(i => Math.min(...points.map(p => p[i]))), max: [0, 1, 2].map(i => Math.max(...points.map(p => p[i]))) }
  })
  const spawnCamera = (course: Course): CameraPose => {
    const spawn = course.spawns[0]
    if (!spawn) throw new Error(`interactiveStart: ${course.id} has no start pose`)
    const yaw = spawn.yawDeg * Math.PI / 180, [x, y, z] = spawn.t
    return { eye: [x - Math.sin(yaw) * 7, y + 4, z - Math.cos(yaw) * 7], target: [x, y + 1.2, z], fovYDeg: 60, near: 0.1, far: 500 }
  }
  const framed = (course: Course, camera: CameraPose) => boxes(course).some(b => b.key.startsWith('candy.') && inView(camera, b))
  const start = courses.find(c => c.kind === 'start'), hub = courses.find(c => c.kind === 'hub')
  if (!start || !hub) throw new Error('interactiveStart: the build must ship its complete start and hub')
  const camera = sceneCamera(start.scene, 'start')
  if (!camera || !framed(start, camera) || !framed(hub, spawnCamera(hub))) throw new Error('interactiveStart: start or loading-hub scenery is outside its view')
  const selected = courses.find(c => c.kind === 'race' && c.profiles.includes('sprint') && framed(c, spawnCamera(c)))
  if (!selected) throw new Error('interactiveStart: no shipped race frames candy scenery from its spawn')
  const penguin = index.assets.find(a => a.id === 'penguin.body' && ship.meshed.has(a.id))
  if (!penguin) throw new Error('interactiveStart: the packed load set has no penguin')
  const body = JSON.parse(readFileSync(join(dir, penguin.path), 'utf8')).bounds as { min: number[]; max: number[] }
  for (const [what, view, at] of [
    ['start', camera, start.start?.spot.t], ['loading', spawnCamera(hub), hub.spawns[0].t], ['round', spawnCamera(selected), selected.spawns[0].t],
  ] as const) {
    if (!at || !inView(view, { min: body.min.map((v, i) => v + at[i]), max: body.max.map((v, i) => v + at[i]) })) throw new Error(`interactiveStart: ${what} penguin is outside its view`)
  }
  const request = validate({ test: true, course: selected.id, startCourse: start.id, phase: 'transition' })
  for (const phase of ['start', 'transition']) validate({ ...request, phase })
  for (const bad of [{ ...request, test: false }, { ...request, phase: 'oops' }, { ...request, course: '../missing' }, { ...request, waitMs: 3000 }]) assert.throws(() => validate(bad))
  const view: CameraPose = { eye: [0, 0, 0], target: [0, 0, 1], fovYDeg: 60, near: 0.1, far: 500 }
  assert.equal(inView(view, { min: [-100, -100, 1], max: [100, 100, 2] }), true, 'a screen-filling box need not have any corner inside')
  assert.equal(inView(view, { min: [-1, -1, -10], max: [1, 1, -1] }), false)
  assert.equal(inView(view, { min: [100, -1, 1], max: [101, 1, 2] }), false)
  await checkSceneRetention()
  console.info(`Interactive start preflight passed: ${start.id}, ${hub.id}, ${selected.id}; all three captured views have packed scenery`)
  return request
}

async function interactiveClient(args: string[]): Promise<string> {
  const client = process.env.NMC_GPU_CLIENT
  if (!client || !existsSync(client)) throw new Error('GPU waiting: NMC_GPU_CLIENT is unavailable; card 7144 needs the real Chrome GPU client')
  return new Promise((resolveClient, reject) => {
    // No wall-clock timeout: the service bounds rendering and the client may wait for its GPU slot.
    const child = spawn(process.execPath, [client, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', error = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { error += chunk; process.stderr.write(chunk) })
    child.once('error', reject)
    child.once('close', code => code === 0 ? resolveClient(output) : reject(new Error(`GPU client exited ${code}: ${error.slice(-2000)}`)))
  })
}

const INTERACTIVE_SHOTS = ['start', 'loading', 'round'] as const
async function renderInteractiveStart(out: string): Promise<void> {
  const request = await interactivePreflight()
  const { packPreparedPage } = await import('./fieldShadingRender.ts')
  if (process.env.NMC_CACHE_DIR) process.env.RF_CACHE_DIR = process.env.NMC_CACHE_DIR
  await packPreparedPage()
  const dist = resolve('apps/web/dist'), packed = JSON.parse(readFileSync(join(dist, 'content/index.json'), 'utf8')) as { courses: { id: string }[] }
  for (const id of [request.course, request.startCourse]) if (!packed.courses.some(c => c.id === id)) throw new Error(`interactiveStart: packed build omits ${id}`)
  console.info(await interactiveClient(['limits']))
  mkdirSync(out, { recursive: true })
  rmSync(join(out, 'probe'), { recursive: true, force: true })
  for (const name of [...INTERACTIVE_SHOTS.map(s => `${s}.png`), 'result.json']) rmSync(join(out, name), { force: true })
  const blank = join(out, 'blank'); mkdirSync(blank, { recursive: true })
  writeFileSync(join(blank, 'index.html'), '<script>window.nmcGpu={ops:{probe:async()=>({json:{ok:true},files:[]})}}</script>\n')
  writeFileSync(join(blank, 'nmc.gpu.json'), JSON.stringify({ page: 'index.html', ops: ['probe'] }, null, 2) + '\n')
  const input = join(out, 'input.json'); writeFileSync(input, '{}\n')
  const blankRef = JSON.parse(await interactiveClient(['publish', blank])).page_ref
  if (!blankRef) throw new Error('Blank probe publish returned no page_ref')
  await interactiveClient(['probe', input, '--page-ref', blankRef, '-o', join(out, 'blank-result')])
  if (JSON.parse(readFileSync(join(out, 'blank-result/result.json'), 'utf8')).result?.ok !== true) throw new Error('Blank GPU probe failed')
  // The game fetches its build stamp (LobbyDiag); a published page without one logs a 404 into the job, as the dev server avoids.
  const stamp = join(dist, 'rf-build.json')
  if (!existsSync(stamp)) writeFileSync(stamp, JSON.stringify({ commit: null, builtAt: 'dev' }) + '\n')
  const manifest = join(dist, 'nmc.gpu.json'), previous = readFileSync(manifest, 'utf8')
  let pageRef: string
  try {
    writeFileSync(manifest, JSON.stringify({ page: 'game.html', ops: ['interactiveStart'] }, null, 2) + '\n')
    pageRef = JSON.parse(await interactiveClient(['publish', dist])).page_ref
  } finally { writeFileSync(manifest, previous) }
  if (!pageRef) throw new Error('Interactive start publish returned no page_ref')
  // One complete start frame before the resident transition; each job waits on state, never multi-second sleeps.
  for (const phase of ['start', 'transition'] as const) {
    const target = phase === 'start' ? join(out, 'probe') : out
    mkdirSync(target, { recursive: true })
    writeFileSync(input, JSON.stringify({ ...request, phase }, null, 2) + '\n')
    await interactiveClient(['interactiveStart', input, '--page-ref', pageRef, '-o', target])
    const result = JSON.parse(readFileSync(join(target, 'result.json'), 'utf8')), report = result.result
    if (report?.ok !== true || report.adapter?.software !== false || report.course !== request.course) throw new Error(`interactiveStart ${phase}: GPU operation failed`)
    for (const name of phase === 'start' ? ['start'] : INTERACTIVE_SHOTS) {
      if (!report.captures?.includes(`${name}.png`) || !statSync(join(target, `${name}.png`)).size) throw new Error(`interactiveStart: missing or empty ${name}.png`)
    }
    mkdirSync('proofs/interactive-start', { recursive: true })
    copyFileSync(join(target, 'result.json'), `proofs/interactive-start/${phase}.json`)
  }
}

async function interactiveCommand(argv: string[]): Promise<number> {
  const [mode, out = 'out/interactive-start', judge] = argv
  if (!/^out\/[a-z0-9/_-]+$/.test(out)) throw new Error('interactiveStart: captures must stay under out/')
  if (mode === 'interactive-start-check') await interactivePreflight()
  else if (mode === 'interactive-start-render') await renderInteractiveStart(out)
  else if (mode === 'interactive-start-judge') {
    if (!judge) throw new Error('interactiveStart: pass the NMC_JUDGE_CLIENT path')
    const descriptions = {
      start: 'Royal Fiesta complete interactive start scene: a complete penguin and rounded candy scenery with smooth shading, clean colours and readable selection and Play controls; no missing geometry, faceting or dark inverted normals',
      loading: 'Royal Fiesta loading transition: complete previous candy scenery and penguin retained beneath the loading UI, with readable preparation progress; no missing geometry, faceting or dark inverted normals',
      round: 'Royal Fiesta complete selected candy round: a complete penguin, complete candy course geometry and readable round HUD, smoothly shaded rounded surfaces with clean colours; no missing geometry, faceting or dark inverted normals',
    }
    const captures = [{ path: 'probe/start', description: descriptions.start }, ...INTERACTIVE_SHOTS.map(name => ({ path: name, description: descriptions[name] }))]
    for (const capture of captures) {
      const code = await run('python3', [judge, join(out, `${capture.path}.png`), '--description', capture.description, '--min-score', '6'], repoRoot())
      if (code !== 0) return code
    }
  } else throw new Error(`Unknown interactive start command: ${mode}`)
  return 0
}

export async function main(argv: string[]): Promise<number> {
  if (argv[0]?.startsWith('interactive-start-')) return interactiveCommand(argv)
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
