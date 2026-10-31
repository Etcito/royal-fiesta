// Programmatic GPU card only. The browser op owns the tour and its input validation.
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { unwrapOp } from '../apps/headless/src/gpuRecord.ts'

// uiTour.ts imports a Vite ?raw module. Keep Node independent; the test checks this list against it.
const SCREENS = ['start', 'vote', 'countdown', 'round', 'result', 'elimShow', 'endScreen']
export function flowTourInput(): object {
  return { page: 'game', op: 'flowTour', input: { width: 1920, height: 1080 }, screens: [...SCREENS] }
}

function pageErrors(value: unknown): void {
  if (!value || typeof value !== 'object') return
  const o = value as Record<string, unknown>
  for (const key of ['error', 'pageError', 'page_error', 'refusal', 'errors']) {
    const error = o[key]
    if (error && (!Array.isArray(error) || error.length > 0)) {
      throw new Error(typeof error === 'string' ? error : JSON.stringify(error))
    }
  }
  if (o.ok === false || o.status === 'refused' || o.status === 'error') throw new Error(JSON.stringify(o))
  for (const key of ['result', 'json']) pageErrors(o[key])
}

async function main(): Promise<void> {
  const dist = 'apps/web/dist/'
  const manifestPath = join(dist, 'nmc.gpu.json')
  assert(existsSync(manifestPath), 'apps/web/dist/nmc.gpu.json missing; run npm run build first')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  assert(manifest.page === 'game.html' && manifest.ops.includes('flowTour'), 'built game page must declare flowTour')
  const client = process.env.NMC_GPU_CLIENT
  assert(client, 'NMC_GPU_CLIENT is unset')
  const exec = promisify(execFile)
  const run = async (...args: string[]) => (await exec(process.execPath, [client, ...args], {
    maxBuffer: 32 << 20,
  })).stdout
  // Like zoneCapture: adapt the requested transport name in dist only. The metadata (screens)
  // stays outside the op input, whose validator permits only width and height.
  const script = 'flow-tour-transport.js'
  writeFileSync(join(dist, script), 'document.addEventListener("DOMContentLoaded",()=>{window.nmcGpu.ops.render=(request)=>window.nmcGpu.ops.flowTour(request.input)},{once:true});\n')
  const page = join(dist, 'game.html')
  const html = readFileSync(page, 'utf8')
  assert(html.includes('</body>'), 'built game page has no body')
  if (!html.includes(`src="./${script}"`)) {
    writeFileSync(page, html.replace('</body>', `<script type="module" src="./${script}"></script></body>`))
  }
  writeFileSync(manifestPath, JSON.stringify({ ...manifest, ops: [...new Set([...manifest.ops, 'render'])] }))
  // The build does not pack the relative content URLs used by the game page.
  const { packContent } = await import('./content.ts')
  packContent(join(dist, 'content'))
  const published = JSON.parse(await run('publish', dist))
  pageErrors(published)
  assert(typeof published.page_ref === 'string' && published.page_ref.length, 'publish returned no page_ref')
  const outDir = 'out/s3/m7/'
  mkdirSync(outDir, { recursive: true })
  // Do not allow a previous run's files to satisfy a missing capture in this run.
  for (const file of ['result.json', 'tour.png', ...SCREENS.flatMap(s => [`${s}.png`, `tour-${s}.png`])]) {
    rmSync(join(outDir, file), { force: true })
  }
  const inputPath = join(outDir, 'input.json')
  writeFileSync(inputPath, JSON.stringify(flowTourInput(), null, 2) + '\n')
  await run('render', inputPath, '--page-ref', published.page_ref, '-o', outDir)
  const raw: unknown = JSON.parse(readFileSync(join(outDir, 'result.json'), 'utf8'))
  pageErrors(raw)
  const { out } = unwrapOp({ file: 'result.json', json: raw }, 'captures')
  assert(Array.isArray(out.captures), 'missing captures')
  const adapter = out.adapter as { software?: boolean } | undefined
  assert(adapter?.software === false, 'hardware GPU adapter required')
  console.log(`flow tour adapter: ${JSON.stringify(adapter)}`)
  const { default: sharp } = await import('sharp')
  const tiles = []
  const width = 640, height = 360, labelHeight = 48, columns = 3
  for (const [i, screen] of SCREENS.entries()) {
    const capture = out.captures.find((c: { screen?: string }) => c.screen === screen)
    assert(capture && capture.file === `${screen}.png`, `missing capture: ${screen}`)
    const source = join(outDir, `${screen}.png`)
    assert(existsSync(source), `missing capture: ${screen}.png`)
    const meta = await sharp(source).metadata()
    assert(meta.format === 'png' && meta.width === 1920 && meta.height === 1080, `invalid capture: ${screen}`)
    copyFileSync(source, join(outDir, `tour-${screen}.png`))
    const left = (i % columns) * width, top = Math.floor(i / columns) * (height + labelHeight)
    tiles.push({ input: await sharp(source).resize(width, height).toBuffer(), left, top })
    const label = Buffer.from(`<svg width="${width}" height="${labelHeight}"><rect width="100%" height="100%" fill="#172033"/><text x="320" y="32" text-anchor="middle" font-family="sans-serif" font-size="24" fill="white">${screen}</text></svg>`)
    tiles.push({ input: label, left, top: top + height })
  }
  await sharp({ create: { width: columns * width, height: Math.ceil(SCREENS.length / columns) * (height + labelHeight), channels: 3, background: '#172033' } })
    .composite(tiles).png().toFile(join(outDir, 'tour.png'))
  console.log('flow tour saved to out/s3/m7/tour.png')
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try { await main() } catch (error) {
    const e = error as { message?: string; stderr?: string; stdout?: string }
    let message = [e.message, e.stderr, e.stdout].filter(Boolean).join('\n') || String(error)
    for (const [key, secret] of Object.entries(process.env)) {
      if (secret && /TOKEN|SECRET|PASSWORD|API_KEY/.test(key)) message = message.split(secret).join('<redacted>')
    }
    console.error(message)
    process.exitCode = 1
  }
}
