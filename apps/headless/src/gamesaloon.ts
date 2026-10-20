import { spawn, execFile, execFileSync } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { Agent, get } from 'node:http'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { join } from 'node:path'
import { refuse } from '../../../packages/sim/src/refusal.ts'
import { brickDir, repoRoot } from '../../../tools/bricks.ts'

export interface LocalServer { url: string; port: number; dir: string; logs: string[]; stop(): Promise<void> }

// GameSaloon env (docs/configuration.md): PORT, HOST, LOG_LEVEL. LOG_LEVEL accepts only error|info|debug ('warn' is rejected with [config] LOG_LEVEL), so we pass 'error'.
// PLAYER_STORE defaults to 'memory', so no other env is needed to boot without stores.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const port = (srv.address() as { port: number }).port
      srv.close(() => resolve(port))
    })
  })
}

// node:http with a private Agent: the global agent honours NODE_USE_ENV_PROXY and would proxy 127.0.0.1.
function healthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get({ host: '127.0.0.1', port, path: '/health', timeout: 1000, agent: new Agent() }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('timeout', () => req.destroy())
    req.on('error', () => resolve(false))
  })
}

function waitExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) resolve()
    else child.once('exit', () => resolve())
  })
}

// The brick is read-only and may have no install (no node_modules/ws): run a copy
// of its src/examples under out/ with its own `npm ci --omit=dev` instead of writing there.
function runtimeDir(dir: string): string {
  if (existsSync(join(dir, 'node_modules', 'ws'))) return dir
  const lock = readFileSync(join(dir, 'package-lock.json'), 'utf8')
  const stamp = JSON.stringify({ dir, lock: lock.length, src: readFileSync(join(dir, 'src', 'main.ts'), 'utf8').length })
  const out = join(repoRoot(), 'out', 'gamesaloon-runtime')
  const stampFile = join(out, '.rf-stamp.json')
  if (existsSync(join(out, 'node_modules', 'ws')) && existsSync(stampFile) && readFileSync(stampFile, 'utf8') === stamp) return out
  rmSync(out, { recursive: true, force: true })
  mkdirSync(out, { recursive: true })
  for (const entry of ['src', 'examples', 'package.json', 'package-lock.json']) cpSync(join(dir, entry), join(out, entry), { recursive: true })
  try {
    execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: out, stdio: ['ignore', 'pipe', 'pipe'], timeout: 180000 })
  } catch (e) {
    refuse('gamesaloon', join(dir, 'node_modules/ws'), `missing, and npm ci in ${out} failed (${e instanceof Error ? e.message.split('\n')[0] : String(e)}); run npm ci in ${dir}`)
  }
  writeFileSync(stampFile, stamp)
  return out
}

export async function startGameSaloon(opts: { env?: Record<string, string>; timeoutMs?: number } = {}): Promise<LocalServer> {
  const dir = brickDir('gamesaloon-public')
  if (!dir) refuse('gamesaloon', 'gamesaloon-public', 'directory not found; clone gamesaloon-public next to this repo or set GAMESALOON_DIR')
  const runDir = runtimeDir(dir)
  // NODE_USE_ENV_PROXY makes the global WebSocket (undici) proxy 127.0.0.1 too; it reads no_proxy lazily, both cases.
  const noProxy = [...new Set([...(process.env.no_proxy || process.env.NO_PROXY || '').split(',').filter(Boolean), '127.0.0.1', 'localhost'])].join(',')
  process.env.NO_PROXY = noProxy
  process.env.no_proxy = noProxy
  const timeoutMs = opts.timeoutMs ?? 10000
  const port = await freePort()
  const logs: string[] = []
  const child = spawn(process.execPath, ['--experimental-strip-types', 'src/main.ts'], {
    cwd: runDir,
    env: { ...process.env, PORT: String(port), HOST: '127.0.0.1', LOG_LEVEL: 'error', ...opts.env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [child.stdout, child.stderr]) {
    let partial = ''
    stream.setEncoding('utf8')
    stream.on('data', (chunk: string) => {
      const lines = (partial + chunk).split('\n')
      partial = lines.pop() ?? ''
      logs.push(...lines)
    })
    stream.on('end', () => { if (partial) logs.push(partial) })
  }
  const stop = async (): Promise<void> => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000)
    await waitExit(child)
    clearTimeout(timer)
  }
  const deadline = Date.now() + timeoutMs
  let early = false
  child.once('close', () => { early = true })
  while (true) {
    if (await healthy(port)) break
    if (early || Date.now() > deadline) {
      const why = early ? 'exited early' : `no /health 200 within ${timeoutMs} ms`
      await stop()
      refuse('gamesaloon', `${runDir}/src/main.ts`, `${why}; last logs:\n${logs.slice(-10).join('\n')}`)
    }
    await new Promise((r) => setTimeout(r, 100))
  }
  return { url: `ws://127.0.0.1:${port}/ws`, port, dir: runDir, logs, stop }
}

export function helloHandshake(server: LocalServer): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(process.execPath, ['examples/hello-client.mjs', server.url], { cwd: server.dir, timeout: 10000, env: { ...process.env, NO_PROXY: '127.0.0.1', no_proxy: '127.0.0.1' } }, (err, stdout, stderr) => {
      const line = stdout.split('\n').find((l) => l.startsWith('OK: created room'))
      if (line) return resolve(line)
      try {
        refuse('gamesaloon', 'examples/hello-client.mjs', `handshake failed${err ? ` (${err.message.split('\n')[0]})` : ''}; output:\n${(stdout + stderr).trim()}`)
      } catch (e) {
        reject(e)
      }
    })
  })
}
