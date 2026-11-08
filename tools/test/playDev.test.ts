import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { repoRoot } from '../bricks.ts'
import { devServer } from '../playDev.ts'
import { playMiddleware } from '../play.ts'

async function listen(server: Awaited<ReturnType<typeof devServer>>): Promise<string> {
  await new Promise<void>(done => server.httpServer.listen(0, '127.0.0.1', done))
  const address = server.httpServer.address()
  assert.ok(address && typeof address !== 'string')
  return `http://127.0.0.1:${address.port}`
}

test('dev uses the production config, live RAA, shared routes, and bounded filesystem access', async () => {
  const root = repoRoot()
  const server = await devServer(root, 0, '127.0.0.1', playMiddleware(join(root, 'apps/web'), true))
  try {
    const base = await listen(server)
    for (const page of ['index.html', 'game.html', 'client.html', 'play.html', 'candy-assets.html']) {
      const response = await fetch(`${base}/${page}`)
      assert.equal(response.status, 200, page)
      assert.match(await response.text(), /@vite\/client/)
    }
    const module = await server.vite.environments.client.pluginContainer.resolveId('@etcito/raa')
    assert.ok(module)
    assert.match(module.id.replaceAll('\\', '/'), /\/raa\/dist\/bricks\/raa\/index\.js$/)
    const response = await fetch(`${base}/@fs${module.id}`)
    assert.equal(response.status, 200)
    assert.match(await response.text(), /pkg\/raa_js\.js/)
    const wasm = await fetch(`${base}/@fs${dirname(module.id)}/pkg/raa_js_bg.wasm`)
    assert.equal(wasm.status, 200)
    assert.equal(wasm.headers.get('content-type'), 'application/wasm')
    assert.equal(wasm.headers.get('cache-control'), 'no-store')
    assert.equal(wasm.headers.get('x-rf-play-mode'), 'vite')
    await wasm.arrayBuffer()
    assert.equal((await fetch(`${base}/@fs/etc/passwd`)).status, 403)
    assert.equal((await fetch(`${base}/content/package.json`)).status, 404)
    const course = await fetch(`${base}/content/courses/s1-i-honeycomb-heights.course.json`)
    assert.equal(course.status, 200)
    assert.deepEqual(await course.json(), JSON.parse(readFileSync(join(root, 'courses/s1-i-honeycomb-heights.course.json'), 'utf8')))
    assert.deepEqual(await (await fetch(`${base}/rf-build.json`)).json(), { commit: null, builtAt: 'dev' })
    assert.ok(server.vite.config.optimizeDeps.exclude?.includes('@etcito/raa'))
    assert.ok(server.vite.config.optimizeDeps.exclude?.includes('@etcito/uaa'))
    assert.ok(server.vite.config.optimizeDeps.exclude?.includes('@etcito/haa-spatial'))
    assert.ok(server.vite.config.plugins.some(plugin => plugin.name === 'rf-anim-brick'))
    assert.ok(server.vite.config.plugins.some(plugin => plugin.name === 'rf-uaa-text-edges'))
  } finally { await server.close() }
})

test('touching a live file: dependency sends a full reload and edits are served without a game build', async () => {
  // A writable sibling fixture exercises actual filesystem events without touching live repos.
  mkdirSync(join(repoRoot(), 'out'), { recursive: true })
  const scratch = mkdtempSync(join(repoRoot(), 'out/play-dev-'))
  const root = join(scratch, 'game')
  const brick = join(scratch, 'raa')
  const web = join(root, 'apps/web')
  mkdirSync(web, { recursive: true })
  mkdirSync(brick)
  writeFileSync(join(root, 'package.json'), JSON.stringify({ type: 'module', dependencies: { '@etcito/raa': 'file:../raa' } }))
  writeFileSync(join(web, 'package.json'), '{}')
  writeFileSync(join(web, 'anim-brick.vite.config.ts'), `export default { root: ${JSON.stringify(web)}, resolve: { alias: { '@etcito/raa': ${JSON.stringify(join(brick, 'index.js'))} } } }`)
  writeFileSync(join(web, 'game.html'), '<script type="module">import "@etcito/raa"</script>')
  const file = join(brick, 'index.js')
  const binary = join(brick, 'engine.wasm')
  writeFileSync(file, 'export const version = 1')
  writeFileSync(binary, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]))
  const server = await devServer(root, 0, '127.0.0.1', playMiddleware(web, true))
  let socket: WebSocket | undefined
  try {
    const base = await listen(server)
    assert.match(await (await fetch(`${base}/@fs${file}`)).text(), /version = 1/)
    socket = new WebSocket(`${base.replace('http:', 'ws:')}/?token=${server.vite.config.webSocketToken}`, 'vite-hmr')
    const message = (type: string): Promise<void> => new Promise((done, reject) => {
      const timer = setTimeout(() => { socket!.removeEventListener('message', receive); reject(new Error(`no ${type} from Vite`)) }, 10000)
      const receive = (event: MessageEvent): void => {
        if (JSON.parse(String(event.data)).type !== type) return
        clearTimeout(timer)
        socket!.removeEventListener('message', receive)
        done()
      }
      socket!.addEventListener('message', receive)
    })
    await message('connected')
    const reloaded = message('full-reload')
    const now = new Date(Date.now() + 1000)
    utimesSync(binary, now, now)
    await reloaded
    const edited = message('full-reload')
    writeFileSync(file, 'export const version = 2')
    await edited
    assert.match(await (await fetch(`${base}/@fs${file}`)).text(), /version = 2/)
  } finally {
    socket?.close()
    await server.close()
    rmSync(scratch, { recursive: true, force: true })
  }
})
