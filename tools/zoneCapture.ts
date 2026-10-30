// Programmatic card only: Chrome and rendering belong to the server GPU client.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { availableParallelism, tmpdir } from 'node:os'
import { isAbsolute, join, win32 } from 'node:path'
import { promisify } from 'node:util'
import { decodePng, unwrapOp } from '../apps/headless/src/gpuRecord.ts'
import type { ZoneCaptureInput } from '../apps/web/src/zone/zoneOps.ts'
import { packContent, profileAssetIds } from './content.ts'
import { MeshBaker } from './meshBake.ts'
import { leakScan } from './guard.ts'

const exec = promisify(execFile)
// A GPU render may run up to the server's job limit (5 minutes, owner rule); the client waits that long
// on top of NMC_GPU_WAIT_S, the time a job may queue for a GPU client (another card's render holds the project's slot).
const RENDER_LIMIT_MS = 300_000
// The profile the zone page loads (apps/web/src/zone/zoneOps.ts content.load).
const ZONE_PROFILE = 'sprint'
const input = {
  width: 1280, height: 720, peers: 8, seatsPerPeer: 2, course: 'race-sprint',
  // One epoch establishes the domains and FAR stream before bots converge on the path.
  seconds: 1.2,
} satisfies ZoneCaptureInput
const secrets = Object.entries(process.env)
  .filter(([key, value]) => /TOKEN|SECRET|PASSWORD|API_KEY/.test(key) && value)
  .map(([, value]) => value!)
let stage = 'validate GPU wait'
let scratch: string | undefined

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
  scratch = mkdtempSync(join(tmpdir(), 'rf-zone-capture-'))
  const render = async (ref: string, value: unknown, name: string) => {
    const out = join(scratch!, name)
    mkdirSync(out)
    const file = join(out, 'input.json')
    json(file, value)
    await client('render', file, '--page-ref', ref, '-o', out)
    const result = JSON.parse(readFileSync(join(out, 'result.json'), 'utf8'))
    assert(Object.hasOwn(result, 'result'), 'missing GPU result envelope')
    return { file: 'result.json', json: result.result as unknown }
  }

  stage = 'blank GPU transport probe'
  const probe = join(scratch, 'probe')
  mkdirSync(probe)
  json(join(probe, 'nmc.gpu.json'), { page: 'index.html', ops: ['render'] })
  writeFileSync(join(probe, 'index.html'), '<script>window.nmcGpu={ops:{render:async()=>({json:{ok:true},files:[]})}}</script>')
  assert(unwrapOp(await render(await publish(probe), {}, 'probe-result'), 'ok').out.ok === true)

  stage = 'prepare built game page'
  const dist = 'apps/web/dist/'
  const manifestFile = join(dist, 'nmc.gpu.json')
  const manifest = JSON.parse(readFileSync(manifestFile, 'utf8'))
  assert(manifest.page === 'game.html' && Array.isArray(manifest.ops) && manifest.ops.includes('zoneCapture'))
  // The page answers content/meshes/<key> from the pack; a missing mesh makes the browser run MAMA itself
  // for every asset, which outlasts a render. Mesh on the server first, only the assets the page's load meshes
  // (cached by content key for every worktree, see meshCacheDir; a refusal is cached and published as .failed).
  stage = 'bake meshes on the server'
  // A fresh checkout has no mesh cache: spread the assets over the run's cores (bounded for memory).
  process.env.RF_MESH_JOBS ??= String(Math.min(8, Number(process.env.NMC_CPUS) || Math.max(1, availableParallelism() - 1)))
  await new MeshBaker(undefined, undefined, await profileAssetIds(ZONE_PROFILE)).scan()
  stage = 'prepare built game page'
  packContent(join(dist, 'content'))
  // Adapt the required transport name without changing any source page or declared source op.
  const script = 'zone-capture-transport.js'
  writeFileSync(join(dist, script),
    'document.addEventListener("DOMContentLoaded",()=>{window.nmcGpu.ops.render=(input)=>window.nmcGpu.ops.zoneCapture(input)},{once:true});\n')
  const page = join(dist, 'game.html')
  const html = readFileSync(page, 'utf8')
  assert(html.includes('</body>'), 'missing game page body')
  if (!html.includes(`src="./${script}"`)) {
    writeFileSync(page, html.replace('</body>', `<script type="module" src="./${script}"></script></body>`))
  }
  json(manifestFile, { ...manifest, ops: [...new Set([...manifest.ops, 'render'])] })
  stage = 'publish game page'
  const ref = await publish(dist)
  stage = 'one-frame zone probe'
  const first = unwrapOp(await render(ref, { ...input, seconds: 1 / 60 }, 'one-frame'), 'captures').out
  assert(first.renderer === 'raa' && Array.isArray(first.captures) && first.captures.length === 1)
  stage = 'capture zone view'
  const out = unwrapOp(await render(ref, input, 'zone'), 'captures').out
  assert(out.renderer === 'raa', 'RAA renderer required')
  const adapter = out.adapter as Record<string, unknown> | undefined
  assert(adapter && adapter.software === false, 'hardware adapter required')
  publicData(adapter)
  assert(typeof out.near === 'number' && Number.isInteger(out.near) && out.near >= 1, 'near players missing')
  assert(typeof out.far === 'number' && Number.isInteger(out.far) && out.far >= 1, 'far players missing')
  assert(Array.isArray(out.captures) && out.captures.length === 1, 'one capture required')
  const capture = out.captures[0]
  assert(capture.name === 'zone-view' && capture.width === input.width && capture.height === input.height)
  assert(capture.mime === 'image/png' && typeof capture.base64 === 'string')
  const png = Buffer.from(capture.base64, 'base64')
  decodePng(png, input.width, input.height, 'zone-view')
  // Refuse textual/unknown metadata rather than copying paths or credentials into the PNG.
  let offset = 8
  while (offset + 12 <= png.length) {
    const length = png.readUInt32BE(offset)
    const kind = png.toString('ascii', offset + 4, offset + 8)
    assert(['IHDR', 'IDAT', 'IEND', 'sRGB', 'gAMA', 'cHRM', 'pHYs'].includes(kind))
    offset += length + 12
    if (kind === 'IEND') break
  }
  assert(offset === png.length, 'unexpected trailing PNG data')
  stage = 'save zone PNG'
  // Persist only canvas pixels; no client envelope, page reference or adapter record.
  mkdirSync('out/m4', { recursive: true })
  writeFileSync('out/m4/zone-view.png', png)
  console.log(`zone adapter: ${JSON.stringify(adapter)}`)
  console.log(`zone players: near ${out.near}, far ${out.far}`)
  console.log('zone capture saved to out/m4/zone-view.png')
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

try { await main() }
catch (error) {
  console.error(`zone capture failed: ${stage}`)
  console.error(cause(error))
  process.exitCode = 1
} finally {
  if (scratch) rmSync(scratch, { recursive: true, force: true })
}
