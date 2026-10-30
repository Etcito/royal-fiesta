// Programmatic card only: Chrome and rendering belong to the server GPU client.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { isAbsolute, join, win32 } from 'node:path'
import { promisify } from 'node:util'
import { decodePng, unwrapOp } from '../apps/headless/src/gpuRecord.ts'
import type { ZoneLobbyCaptureInput } from '../apps/web/src/zone/zoneLobbyOps.ts'
import { startGateBots, startZoneGateRelay } from './zoneGateRelay.ts'
import { packContent, profileAssetIds } from './content.ts'
import { MeshBaker } from './meshBake.ts'
import { leakScan } from './guard.ts'

const exec = promisify(execFile)
// A GPU render may run up to the server's job limit (5 minutes, owner rule); the client waits that long
// on top of NMC_GPU_WAIT_S, the time a job may queue for a GPU client (another card's render holds the project's slot).
const RENDER_LIMIT_MS = 300_000
// The profile the zone page loads (apps/web/src/zone/zoneOps.ts content.load).
const ZONE_PROFILE = 'sprint'
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY/.test(key) && value)
  .map(([, value]) => value!)
let stage = 'validate GPU wait'
let scratch: string | undefined
let relay: Awaited<ReturnType<typeof startZoneGateRelay>> | undefined
let bots: ReturnType<typeof startGateBots> | undefined

function publicData(value: unknown): void {
  const text = JSON.stringify(value)
  assert(leakScan(text, secrets).length === 0, 'refusing sensitive output')
  const visit = (v: unknown): void => {
    if (typeof v === 'string') {
      assert(!isAbsolute(v) && !win32.isAbsolute(v), 'refusing absolute paths')
    } else if (v && typeof v === 'object') {
      for (const [key, item] of Object.entries(v)) { visit(key); visit(item) }
    }
  }
  visit(value)
}

function json(file: string, value: unknown): void {
  publicData(value)
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
}

async function main(): Promise<void> {
  const wait = Number(process.env.NMC_GPU_WAIT_S ?? 45)
  assert(Number.isInteger(wait) && wait > 0 && wait <= 900, 'wait must be 1..900 seconds')
  stage = 'wait for NMC_GPU_CLIENT; server-managed Chrome is required'
  const deadline = Date.now() + wait * 1000
  while (!process.env.NMC_GPU_CLIENT || !existsSync(process.env.NMC_GPU_CLIENT)) {
    assert(Date.now() < deadline, 'GPU client missing')
    await new Promise(done => setTimeout(done, Math.min(250, deadline - Date.now())))
  }
  const clientPath = process.env.NMC_GPU_CLIENT
  const limitMs = wait * 1000 + RENDER_LIMIT_MS
  const client = async (...args: string[]): Promise<string> => {
    // Never inherit stdio: client diagnostics can contain credentials or host paths.
    try {
      return (await exec(process.execPath, [clientPath, ...args], {
        timeout: limitMs, killSignal: 'SIGKILL', maxBuffer: 32 * 1024 * 1024,
      })).stdout
    } catch (error) {
      const e = error as { killed?: boolean; stderr?: unknown }
      if (!e?.killed) throw error
      // Killed at the limit: say what the job was doing (its last status line), not the stage's guess.
      const status = String(e.stderr ?? '').trim().split('\n').pop()!.replace(/^GPU job \w+: /, '')
      throw new Error(/waiting for a GPU client/.test(status)
        ? `no GPU client took the job within ${limitMs / 1000} s (NMC_GPU_WAIT_S=${wait} + render limit)`
        : `GPU client call did not finish within ${limitMs / 1000} s; last status: ${status || 'none'}`)
    }
  }
  const publish = async (dir: string): Promise<string> => {
    const result = JSON.parse(await client('publish', dir))
    assert(typeof result.page_ref === 'string' && result.page_ref.length > 0, 'missing page_ref')
    // The reference is passed in memory only, never stored in a public record.
    return result.page_ref
  }
  scratch = mkdtempSync(join(tmpdir(), 'rf-zone-gate-'))
  const render = async (ref: string, value: unknown, name: string) => {
    const out = join(scratch!, name)
    mkdirSync(out)
    const file = join(out, 'input.json')
    // Relay addresses are private transport inputs, never public records.
    writeFileSync(file, JSON.stringify(value), { mode: 0o600 })
    await client('render', file, '--page-ref', ref, '-o', out)
    const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'))
    assert(Object.hasOwn(result, 'result'), 'missing GPU result envelope')
    return { file: 'result.json', json: result.result as unknown }
  }

  stage = 'start zone relay'
  relay = await startZoneGateRelay()
  stage = 'GPU relay reachability probe'
  const probe = join(scratch, 'probe')
  mkdirSync(probe)
  json(join(probe, 'nmc.gpu.json'), { page: 'index.html', ops: ['render'] })
  writeFileSync(join(probe, 'index.html'), `<script>
window.nmcGpu={ops:{render:async(input)=>new Promise(resolve=>{
  let socket, timer, settled=false;
  const finish=(open)=>{
    if(settled)return; settled=true; clearTimeout(timer);
    if(socket)try{socket.close()}catch{}
    resolve({json:{open},files:[]});
  };
  timer=setTimeout(()=>finish(false),10000);
  try{
    socket=new WebSocket(input.relay);
    socket.onopen=()=>finish(true);
    socket.onerror=socket.onclose=()=>finish(false);
  }catch{finish(false)}
})}};
</script>`)
  const reachable = unwrapOp(await render(await publish(probe), { relay: relay.browserUrl }, 'probe-result'), 'open').out
  if (reachable.open !== true) {
    console.error("zone gate: the GPU client cannot reach the card's relay; stopping (no Linux Chrome fallback)")
    throw new Error('relay reachability probe did not open')
  }
  stage = 'start six bot peers'
  bots = startGateBots(relay.localUrl, { peers: 6, seatsPerPeer: 2, players: 8, course: 'race-sprint', seconds: 600 })

  stage = 'prepare built game page'
  const dist = 'apps/web/dist/'
  const manifestFile = join(dist, 'nmc.gpu.json')
  // The runner may drop an unchanged build entry (it never re-runs an entry older than the producing card), so a
  // fresh worktree reaches this point with no dist: build the page here rather than fail on a missing manifest.
  if (!existsSync(manifestFile)) {
    stage = 'build web page (no apps/web/dist)'
    await exec('npm', ['run', 'build'], { maxBuffer: 64 << 20 })
    stage = 'prepare built game page'
  }
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  assert(manifest.page === 'game.html' && Array.isArray(manifest.ops) && manifest.ops.includes('zoneLobbyCapture'))
  // The page answers content/meshes/<key> from the pack; a missing mesh makes the browser run MAMA itself
  // for every asset, which outlasts a render. Mesh on the server first, only the assets the page's load meshes
  // (cached by content key for every worktree, see meshCacheDir; a refusal is cached and published as .failed).
  stage = 'bake meshes on the server'
  // A fresh checkout has no mesh cache: spread the assets over the run's cores (bounded for memory).
  const cpus = Math.max(1, Math.floor(Number(process.env.NMC_CPUS) || 1))
  const requested = Math.max(1, Math.floor(Number(process.env.RF_MESH_JOBS) || cpus))
  process.env.RF_MESH_JOBS = String(Math.min(8, cpus, requested))
  const baker = new MeshBaker(undefined, undefined, await profileAssetIds(ZONE_PROFILE))
  await baker.scan()
  stage = 'prepare built game page'
  // Only this load's meshes: the shared cache holds every worktree's and MAMA pin's, past the page upload limit.
  packContent(join(dist, 'content'), undefined, baker.keys)
  // Adapt the required transport name without changing any source page or declared source op.
  const script = 'zone-gate-transport.js'
  writeFileSync(join(dist, script),
    'document.addEventListener("DOMContentLoaded",()=>{window.nmcGpu.ops.render=(input)=>window.nmcGpu.ops.zoneLobbyCapture(input)},{once:true});\n')
  const page = join(dist, 'game.html')
  const html = readFileSync(page, 'utf8').replace(
    /<script\b[^>]*\bsrc\s*=\s*(["'])(?:\.\/)?zone-capture-transport\.js\1[^>]*>\s*<\/script\s*>/gi, '')
  assert(html.includes('</body>'), 'missing game page body')
  writeFileSync(page, html.includes(`src="./${script}"`) ? html
    : html.replace('</body>', `<script type="module" src="./${script}"></script></body>`))
  json(manifestFile, { ...manifest, ops: [...new Set([...manifest.ops, 'render'])] })
  stage = 'publish game page'
  const ref = await publish(dist)
  stage = 'two Chrome zone captures'
  const names = ['chrome-a', 'chrome-b'] as const
  const jobs = names.map(name => render(ref, {
    relay: relay!.browserUrl, players: 8, seatsPerPeer: 1, course: 'race-sprint',
    seconds: 20, name, width: 1280, height: 720,
  } satisfies ZoneLobbyCaptureInput, name))
  // Keep scratch and the relay alive even if one of the concurrent jobs fails first.
  let results: Awaited<(typeof jobs)[number]>[]
  try { results = await Promise.all(jobs) }
  finally { await Promise.allSettled(jobs) }
  const outputs = results.map(result => unwrapOp(result, 'captures').out)
  const peers: number[] = []
  const images = outputs.map((out, i) => {
    stage = `validate ${names[i]}`
    assert(out.renderer === 'raa', 'RAA renderer required')
    const adapter = out.adapter as Record<string, unknown> | undefined
    assert(adapter && adapter.software === false, 'hardware adapter required')
    publicData(adapter)
    const matched = out.matched as Record<string, unknown> | undefined
    assert(matched && matched.peers === 8, 'eight matched peers required')
    assert(typeof matched.localPeer === 'number' && Number.isInteger(matched.localPeer)
      && matched.localPeer >= 0 && matched.localPeer < 8, 'invalid local peer')
    peers.push(matched.localPeer)
    assert(typeof out.ticks === 'number' && Number.isInteger(out.ticks) && out.ticks >= 600, '600 ticks required')
    assert(typeof out.near === 'number' && Number.isInteger(out.near) && out.near >= 1, 'near players missing')
    assert(typeof out.far === 'number' && Number.isInteger(out.far) && out.far >= 0
      && out.near + out.far >= 3, 'other racers missing')
    assert(Array.isArray(out.captures) && out.captures.length === 1, 'one capture required')
    const capture = out.captures[0]
    assert(capture.name === 'zone-lobby' && capture.width === 1280 && capture.height === 720)
    assert(capture.mime === 'image/png' && typeof capture.base64 === 'string')
    const png = Buffer.from(capture.base64, 'base64')
    decodePng(png, 1280, 720, 'zone-lobby')
    let offset = 8
    let ended = false
    while (offset + 12 <= png.length) {
      const length = png.readUInt32BE(offset)
      const kind = png.toString('ascii', offset + 4, offset + 8)
      assert(['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(kind), 'unexpected PNG chunk')
      assert(offset + length + 12 <= png.length, 'truncated PNG chunk')
      offset += length + 12
      if (kind === 'IEND') { assert(length === 0); ended = true; break }
    }
    assert(ended && offset === png.length, 'missing PNG end or trailing data')
    console.log(`zone gate ${names[i]} adapter: ${JSON.stringify(adapter)}`)
    console.log(`zone gate ${names[i]}: peers ${matched.peers}, localPeer ${matched.localPeer}, ticks ${out.ticks}, near ${out.near}, far ${out.far}`)
    return png
  })
  stage = 'distinct Chrome peers'
  assert(peers[0] !== peers[1], 'Chrome instances must have different local peers')
  stage = 'save zone PNGs'
  mkdirSync('out/m6', { recursive: true })
  images.forEach((png, i) => writeFileSync(`out/m6/zone-${names[i]}.png`, png))
}

// The cause of a failure (the GPU client's answer, the page's exception), with secrets, URLs and
// absolute paths redacted so the log never carries credentials, page references or host paths.
function cause(error: unknown): string {
  const e = error as { message?: unknown; stderr?: unknown; stdout?: unknown }
  let text = [e?.message, e?.stderr, e?.stdout]
    .filter((v): v is string | Buffer => typeof v === 'string' || Buffer.isBuffer(v))
    .map(String).join('\n').trim() || String(error)
  for (const secret of secrets) text = text.split(secret).join('<redacted>')
  text = text
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s)'"]*/gi, '<url>')
    .replace(/[A-Za-z]:[\\/][^\s:)'"]*/g, '<path>')
    .replace(/(^|[\s('"=])\/[^\s:)'"]+/g, '$1<path>')
    .replace(/\b(Bearer|token)\s+\S+/gi, '$1 <redacted>')
  return text.length > 4000 ? `${text.slice(0, 4000)}...` : text
}

function failed(at: string, error: unknown): void {
  console.error(`zone gate failed: ${at}`)
  console.error(cause(error))
  process.exitCode = 1
}

try { await main() }
catch (error) { failed(stage, error) }
finally {
  try {
    if (bots) {
      bots.stop()
      const codes = await bots.done
      codes.forEach((code, peer) => {
        if (code !== 0) console.error(`zone gate: bot ${peer} exited non-zero (${code}); includes requested shutdown`)
      })
    }
  } catch (error) { failed('stop bots', error) }
  try { await relay?.stop() } catch (error) { failed('stop relay', error) }
  try { if (scratch) rmSync(scratch, { recursive: true, force: true }) }
  catch (error) { failed('remove scratch', error) }
}
