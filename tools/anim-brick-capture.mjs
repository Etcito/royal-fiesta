// Run only on the programmatic card: the server GPU client owns Chrome and all rendering.
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { browser, ROOT, run, safe } from '../apps/headless/proofs/m18-raa-brick.ts'
import { unwrapOp } from '../apps/headless/src/gpuRecord.ts'
import { packContent } from './content.ts'

const json = (file, value) => writeFileSync(file, JSON.stringify(value, null, 2) + '\n')
const read = file => JSON.parse(readFileSync(file, 'utf8'))
const wait = Number(process.env.NMC_GPU_WAIT_S ?? 45)
assert(Number.isInteger(wait) && wait > 0 && wait <= 60, 'NMC_GPU_WAIT_S must be 1..60 seconds')
const scratch = mkdtempSync(join(tmpdir(), 'rf-m18-capture-'))
async function main() {
  const deadline = Date.now() + wait * 1000
  while (!process.env.NMC_GPU_CLIENT || !existsSync(process.env.NMC_GPU_CLIENT)) {
    if (Date.now() >= deadline) throw new Error('NMC_GPU_CLIENT missing after NMC_GPU_WAIT_S; server-managed Chrome is required')
    await new Promise(done => setTimeout(done, Math.min(250, deadline - Date.now())))
  }
  const client = (...args) => run(process.execPath, [process.env.NMC_GPU_CLIENT, ...args])
  const publish = async dir => {
    const result = JSON.parse(await client('publish', dir))
    assert(typeof result.page_ref === 'string' && result.page_ref.length > 0, 'publish must return page_ref')
    return result.page_ref
  }
  const render = async (pageRef, input, name) => {
    const out = join(scratch, name); mkdirSync(out)
    const file = join(out, 'input.json'); json(file, input)
    await client('render', file, '--page-ref', pageRef, '-o', out)
    const resultFile = join(out, 'result.json')
    const result = read(resultFile)
    assert(Object.hasOwn(result, 'result'), 'GPU client result envelope missing')
    return { file: resultFile, json: result.result }
  }
  // First prove the transport with a blank page, without starting a local browser.
  const probe = join(scratch, 'probe'); mkdirSync(probe)
  json(join(probe, 'nmc.gpu.json'), { page: 'index.html', ops: ['render'] })
  writeFileSync(join(probe, 'index.html'), '<script>window.nmcGpu={ops:{render:async()=>({json:{ok:true},files:[]})}}</script>')
  const probeResult = await render(await publish(probe), {}, 'probe-result')
  assert.equal(unwrapOp(probeResult, 'ok').out.ok, true)
  await run(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', 'build'])
  const dist = join(ROOT, 'apps/web/dist')
  packContent(join(dist, 'content'))
  const manifestFile = join(dist, 'nmc.gpu.json'); const manifest = read(manifestFile)
  assert.equal(manifest.page, 'game.html'); assert(manifest.ops.includes('animBrick'))
  // The required transport name is render. Delegate it to the existing in-game operation,
  // preserving the built client and its boot imports, all page operations and capture files.
  writeFileSync(join(dist, 'anim-brick-transport.js'),
    'document.addEventListener("DOMContentLoaded",()=>{window.nmcGpu.ops.render=(input)=>window.nmcGpu.ops.animBrick(input)},{once:true});\n')
  const page = join(dist, manifest.page)
  writeFileSync(page, readFileSync(page, 'utf8').replace('</body>', '<script type="module" src="./anim-brick-transport.js"></script></body>'))
  json(manifestFile, { ...manifest, ops: [...new Set([...manifest.ops, 'render'])] })
  const pageRef = await publish(dist)
  const input = { content: 'v1', flow: 'match', clients: 1, width: 64, height: 64, captureAt: ['match-0.016666667s'] }
  const first = unwrapOp(await render(pageRef, input, 'one-frame'), 'captures').out
  browser({ ...first, pageRef })
  const result = await render(pageRef, { ...input, width: 1280, height: 720, captureAt: ['match-1s'] }, 'game')
  const record = { ...unwrapOp(result, 'captures').out, pageRef }
  browser(record)
  // Keep the established game capture envelope and ordered records verbatim; no synthetic evidence.
  const text = JSON.stringify(record, null, 2) + '\n'
  assert.equal(safe(text), text, 'capture contains a token; refusing to write it')
  const destination = join(ROOT, 'proofs/m18'); mkdirSync(destination, { recursive: true })
  writeFileSync(join(destination, 'brick-browser.json'), text)
  console.log(`m18 game capture saved; adapter ${record.adapter.vendor}`)
}
try { await main() }
catch (error) { console.error(safe(error)); process.exitCode = 1 }
finally { rmSync(scratch, { recursive: true, force: true }) }
