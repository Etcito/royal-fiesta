// Cards 7086 (build/pack/render) and 7087 (judge) run only the playable-* entries named in the handoff.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { runInNewContext } from 'node:vm'
import { transpileModule, ModuleKind } from 'typescript'
import { FIELD_ATLAS_BYTES } from '../apps/web/src/sdf/fieldAtlas.ts'
import { parseGameAsset } from '../packages/game/src/gameAsset.ts'
import { resolveGameRigs } from '../packages/game/src/rigReference.ts'
import { meshCacheKey } from '../apps/web/src/sdf/meshCache.ts'
import { buildContentIndex, contentDir, meshCacheDir, packContent, shippedContent } from './content.ts'

/** Copy the page's load set, using saved meshes first and prepared cache entries only. */
export async function packPreparedPage(dist = resolve('apps/web/dist')): Promise<void> {
  if (!existsSync(join(dist, 'game.html'))) throw new Error('Missing built game.html; run npm run build')
  const dir = contentDir()
  const ship = await shippedContent(dir)
  const index = buildContentIndex(dir)
  const keys = new Set<string>()
  const missing: string[] = []
  const serverOnly = [...ship.meshed].filter(id => !index.assets.some(a => a.id === id && a.mesh))
  if (serverOnly.length) {
    const moduleUrl = new URL('../apps/headless/src/mama/meshNode.ts', import.meta.url).href
    const { meshCompatibility } = await import(moduleUrl) as { meshCompatibility(): Promise<string> }
    const compatibility = await meshCompatibility()
    const readAsset = async (id: string) => {
      const entry = index.assets.find(a => a.id === id)
      if (!entry) throw new Error(`Required asset ${id} is absent from the content index`)
      return await parseGameAsset(JSON.parse(readFileSync(join(dir, entry.path), 'utf8')), entry.path)
    }
    for (const id of serverOnly) {
      const asset = await readAsset(id)
      asset.document = await resolveGameRigs(asset.document, async (game, rigId) => {
        const rig = await readAsset(rigId)
        return rig.game === game ? rig.document : null
      })
      const key = await meshCacheKey(asset, compatibility, async bytes => createHash('sha256').update(bytes).digest('hex'))
      if (!existsSync(join(meshCacheDir(), `${key}.mesh`))) missing.push(id)
      keys.add(key)
    }
  }
  if (missing.length) throw new Error(`Prepared meshes missing: ${missing.join(', ')}; prepare them outside this render job`)
  // A clean pack cannot retain unrelated assets or server meshes from an earlier job.
  rmSync(join(dist, 'content'), { recursive: true, force: true })
  packContent(join(dist, 'content'), dir, keys, ship)
}

const sequence = ['start', 'run', 'turn', 'jump', 'dive']
const requests = { probe: { search: '?test=1', sequence: ['start'] }, selected: { search: '?test=1', sequence }, fallback: { search: '?test=1', sequence: ['start', 'run'], atlasBytes: 1 } }
export function preflight(): void {
  const source = readFileSync('apps/web/src/game/checks/fieldShading.ts', 'utf8')
  const snippet = source.slice(source.indexOf('const ACTIONS'), source.indexOf('interface ResidentState'))
  const api = {} as { validateGameplay(input: unknown): unknown }
  runInNewContext(transpileModule(snippet, { compilerOptions: { module: ModuleKind.CommonJS } }).outputText, { exports: api, URLSearchParams, FIELD_ATLAS_BYTES })
  for (const request of Object.values(requests)) api.validateGameplay(request)
  api.validateGameplay({ ...requests.selected, search: '?test=1&normals=vertex', atlasBytes: FIELD_ATLAS_BYTES })
  for (const atlasBytes of [0, -1, 0.5, NaN, Infinity, '1', FIELD_ATLAS_BYTES + 1]) assert.throws(() => api.validateGameplay({ ...requests.selected, atlasBytes }))
  for (const request of [{ ...requests.selected, search: '' }, { sequence: ['run'], search: '?test=1' }, { ...requests.selected, extra: true }, { ...requests.selected, sequence: [...sequence, 'oops'] }]) assert.throws(() => api.validateGameplay(request))
  console.info('Gameplay request preflight passed: ordered controls, test isolation, vertex and atlas limits')
}
function check(args: string[]): void {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', ...args], { stdio: 'inherit' })
  if (r.status !== 0) throw new Error(`Check failed: ${args.join(' ')} (exit ${r.status})`)
}
async function client(args: string[]): Promise<string> {
  const seconds = Number(process.env.NMC_GPU_WAIT_S ?? 60), deadline = Date.now() + seconds * 1000
  if (!Number.isInteger(seconds) || seconds < 1) throw new Error('NMC_GPU_WAIT_S must be a positive integer')
  if (!process.env.NMC_GPU_CLIENT || !existsSync(process.env.NMC_GPU_CLIENT)) console.info('Waiting for NMC_GPU_CLIENT access; no substitute renderer is used')
  while (!process.env.NMC_GPU_CLIENT || !existsSync(process.env.NMC_GPU_CLIENT)) {
    if (Date.now() >= deadline) throw new Error('GPU client unavailable; connect the client and rerun card 7086')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [process.env.NMC_GPU_CLIENT!, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let output = '', errors = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk; errors += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { errors += chunk; process.stderr.write(chunk) })
    child.on('error', reject)
    // The page's console.warn lines (hundreds, one per vertex-normal part) follow the job's own error in the client's stderr
    // and the card keeps only the tail: the error that failed the job is repeated LAST (card 7086, run 12564 showed warnings only).
    child.on('close', code => code === 0 ? resolve(output) : reject(new Error(`GPU client exited ${code}: ` +
      errors.split('\n').filter(l => /^\s*Error: /.test(l)).map(l => l.split(' | page:')[0].slice(0, 700)).slice(-4).join(' | '))))
  })
}
async function render(out: string): Promise<void> {
  preflight()
  console.info(await client(['limits']))
  rmSync(out, { force: true, recursive: true }); mkdirSync(out, { recursive: true })
  // A blank page first; then the start frame, before either complete resident case. No CPU browser.
  const blank = join(out, 'blank'); mkdirSync(blank)
  writeFileSync(join(blank, 'index.html'), '<script>window.nmcGpu={ops:{probe:async()=>({json:{ok:true},files:[]})}}</script>')
  writeFileSync(join(blank, 'nmc.gpu.json'), JSON.stringify({ page: 'index.html', ops: ['probe'] }))
  const blankRef = JSON.parse(await client(['publish', blank])).page_ref as string
  const blankInput = join(out, 'blank.json'); writeFileSync(blankInput, '{}\n')
  await client(['probe', blankInput, '--page-ref', blankRef, '-o', join(out, 'blank-result')])
  if (JSON.parse(readFileSync(join(out, 'blank-result/result.json'), 'utf8')).result?.ok !== true) throw new Error('Blank page probe failed')
  const dist = 'apps/web/dist'
  // Declare the existing check operation in this published build only.
  const manifest = join(dist, 'nmc.gpu.json'), old = readFileSync(manifest, 'utf8')
  let pageRef: string
  try { writeFileSync(manifest, JSON.stringify({ page: 'game.html', ops: ['fieldShading'] })); pageRef = JSON.parse(await client(['publish', dist])).page_ref as string }
  finally { writeFileSync(manifest, old) }
  if (!pageRef) throw new Error('Publish returned no page_ref')
  for (const [name, request] of Object.entries(requests)) {
    const dir = join(out, name); mkdirSync(dir)
    const input = join(dir, 'input.json'); writeFileSync(input, JSON.stringify(request, null, 2) + '\n')
    await client(['fieldShading', input, '--page-ref', pageRef, '-o', dir])
    const result = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8')), report = result.result
    if (report?.ok !== true || report.adapter?.software !== false) throw new Error(`${name}: real GPU gameplay failed: ${JSON.stringify(report)}`)
    for (const action of request.sequence) if (!report.captures?.includes(`${action}.png`) || !statSync(join(dir, `${action}.png`)).size) throw new Error(`${name}: missing or empty ${action} capture`)
    if (name === 'selected') for (const subject of ['costume.propeller-hat', 'pendulum-hammer']) {
      const poses = report.observations.slice(1).map((o: { subjects: { key: string }[] }) => JSON.stringify(o.subjects.filter(b => b.key.includes(subject))))
      if (new Set(poses).size === 1) throw new Error(`${subject}: gameplay did not move its geometry`)
    }
    // The service's unmodified text result is the committed evidence; all PNGs stay in out/.
    mkdirSync('proofs/playable-field-render', { recursive: true }); copyFileSync(join(dir, 'result.json'), `proofs/playable-field-render/${name}.json`)
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [mode, out = 'out/playable-field-render'] = process.argv.slice(2)
  if (mode === 'preflight') preflight()
  else if (mode === 'pack') {
    if (process.env.NMC_CACHE_DIR) process.env.RF_CACHE_DIR = process.env.NMC_CACHE_DIR
    preflight()
    check(['tools/typecheck.ts'])
    check(['--test', '--test-concurrency=1', 'apps/web/test/sdfTint.test.ts', 'apps/web/test/fieldShading.test.ts'])
    check(['tools/fieldPreflight.ts'])
    await packPreparedPage()
  } else if (mode === 'render') await render(out)
  else throw new Error('Use preflight, pack or render [out/playable-field-render]')
}
