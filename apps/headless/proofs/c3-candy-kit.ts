import { contentPath } from '../../../tools/content.ts'
import { readFile } from 'node:fs/promises'
import { isDeepStrictEqual } from 'node:util'
import { parseColliderJson } from '@royal-fiesta/game/prims'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { report, runProof } from '@royal-fiesta/headless/proofkit'
import type { CheckResult, ProofCheck } from '@royal-fiesta/headless/proofkit'
import { isAuthored, readAuthored } from '../../../tools/authored.ts'
import { repoRoot } from '../../../tools/bricks.ts'
import { documentNodes, loadAssetFile, materialColours, proceduralProblems, rigidGroups, visualFitsCollision } from '../../../tools/contentProbe.ts'
import type { AuthoredAsset } from '../../../tools/contentProbe.ts'
import { buildContent } from '../../../tools/placeholders.ts'
import { viewsProblems } from '../../../tools/viewsRecord.ts'
import type { ViewsRecord } from '../../../tools/viewsRecord.ts'

// C3: the reworked candy kit (15 ids) and its 5 new scenery pieces hold the 1.11/1.13 rules, the reworked
// collisions equal the generated ones, and the committed views record is fresh. Reads committed files only.

const REWORKED = [
  'bounce-pad', 'conveyor-belt', 'checkpoint-gate', 'floor-disc', 'finish-arch', 'queue-pad', 'pendulum-hammer',
  'plaza-fountain', 'floor-tile', 'moving-platform', 'rotating-door', 'podium-block', 'seesaw-plank', 'spinner-bar', 'wall-block',
]
const SCENERY = ['slime-pool', 'banner', 'hot-air-balloon', 'tower', 'cloud']
const path = (id: string): string => `assets/candy/${id}.asset.json`
const FILES = [
  ...REWORKED.map(n => ({ rel: path(`candy.${n}`), id: `candy.${n}`, reworked: true })),
  ...SCENERY.map(n => ({ rel: path(`candy.${n}`), id: `candy.${n}`, reworked: false })),
]
const PALETTE = ['#f0287f', '#ffc93c', '#3fa9f5', '#7cff3a', '#9b7fe0', '#ffffff', '#ff8a3d']
const VIEWS_INPUT = 'proofs/c3/views.input.json'
const VIEWS_RECORD = 'proofs/c3/views.json'

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

// Each asset loads once per process; a refusal becomes the note of the check that needs it.
const loads = new Map<string, Promise<AuthoredAsset>>()
function load(rel: string): Promise<AuthoredAsset> {
  let p = loads.get(rel)
  if (p === undefined) {
    p = loadAssetFile(rel)
    loads.set(rel, p)
  }
  return p
}

async function tryLoad(rel: string, notes: string[]): Promise<AuthoredAsset | null> {
  try {
    return await load(rel)
  } catch (e) {
    if (!isRefusal(e) && !(e instanceof SyntaxError)) throw e
    notes.push(`${rel}: ${messageOf(e)}`)
    return null
  }
}

async function fileBytes(rel: string): Promise<number | null> {
  try {
    return (await readFile(contentPath(rel))).length
  } catch {
    return null
  }
}

// The generated candy files are the reference for category and collision of the 15 reworked ids.
async function generatedReference(notes: string[]): Promise<Map<string, Record<string, unknown>>> {
  const content = await buildContent({ files: [] })
  const ref = new Map<string, Record<string, unknown>>()
  for (const f of FILES) {
    if (!f.reworked) continue
    const text = content.get(f.rel)
    if (text === undefined) notes.push(`${f.rel}: tools/placeholders.ts does not generate it; the reference is unknown`)
    else ref.set(f.rel, JSON.parse(text) as Record<string, unknown>)
  }
  return ref
}

// ---- assets --------------------------------------------------------------------------------------------

async function checkAssets(): Promise<CheckResult> {
  const notes: string[] = []
  const authored = readAuthored(repoRoot())
  const ref = await generatedReference(notes)
  let ok = 0
  for (const f of FILES) {
    const before = notes.length
    const bytes = await fileBytes(f.rel)
    if (bytes === null) {
      notes.push(`${f.rel}: missing; save it with SDF Modeler asset_save_game`)
      continue
    }
    if (!isAuthored(authored, f.rel)) notes.push(`${f.rel}: not listed in tools/authored.json; add it (sorted)`)
    const a = await tryLoad(f.rel, notes)
    if (a === null) continue
    const { asset } = a
    if (asset.id !== f.id) notes.push(`${f.rel}: id '${asset.id}', expected '${f.id}'`)
    if (asset.world !== 'candy') notes.push(`${f.rel}: world '${asset.world}', expected 'candy'`)
    const wantCategory = f.reworked ? ref.get(f.rel)?.category : 'scenery'
    if (wantCategory !== undefined && asset.category !== wantCategory) {
      notes.push(`${f.rel}: category '${asset.category}', expected '${String(wantCategory)}'`)
    }
    const scenery = asset.category === 'scenery'
    const wantMesher = scenery ? 'lowpoly' : 'quad'
    if (asset.mesher.output !== wantMesher) notes.push(`${f.rel}: mesher.output '${asset.mesher.output}', expected '${wantMesher}'`)
    let nodes = -1
    let materials = '-'
    try {
      for (const g of rigidGroups(a)) {
        const output = typeof g.mesher === 'object' && g.mesher !== null ? (g.mesher as Record<string, unknown>).output : undefined
        if (output !== wantMesher) notes.push(`${f.rel}: rigid group '${g.name}' mesher.output ${JSON.stringify(output)}, expected '${wantMesher}'`)
      }
      nodes = documentNodes(a).length
      const max = scenery ? 48 : 64
      if (nodes > max) notes.push(`${f.rel}: ${nodes} document nodes > ${max}; simplify the scene`)
      const colours = materialColours(a)
      materials = colours.map(c => `${c.name}=${c.hex}`).join(',') || '-'
      for (const c of colours) {
        if (!c.name.startsWith('candy-')) notes.push(`${f.rel}: material '${c.name}' must be named candy-<role>`)
        if (!PALETTE.includes(c.hex.toLowerCase())) notes.push(`${f.rel}: material '${c.name}' colour ${c.hex} is not in the candy palette ${PALETTE.join(' ')}`)
      }
    } catch (e) {
      if (!isRefusal(e)) throw e
      notes.push(`${f.rel}: ${messageOf(e)}`)
    }
    if (!f.reworked) {
      if (asset.collision.length !== 0) notes.push(`${f.rel}: collision has ${asset.collision.length} colliders; scenery has collision []`)
      if (Object.keys(asset.anchors).length !== 0) notes.push(`${f.rel}: anchors [${Object.keys(asset.anchors).join(', ')}]; scenery has anchors {}`)
    }
    notes.push(...proceduralProblems(a, bytes))
    report(`assets:${f.id}`, { nodes, bytes, materials })
    if (notes.length === before) ok++
  }
  return { value: `${ok}/${FILES.length}`, threshold: `${FILES.length}/${FILES.length}`, pass: ok === FILES.length && notes.length === 0, notes }
}

// ---- collision-kept ------------------------------------------------------------------------------------

function parseColliders(raw: unknown, path: string): unknown[] {
  if (!Array.isArray(raw)) throw new Error(`${path}: collision must be an array`)
  return raw.map((c, i) => parseColliderJson(c, `${path}/${i}`))
}

async function checkCollisionKept(): Promise<CheckResult> {
  const notes: string[] = []
  const ref = await generatedReference(notes)
  let kept = 0
  let nReworked = 0
  for (const f of FILES) {
    if (!f.reworked) continue
    nReworked++
    const want = ref.get(f.rel)
    const a = await tryLoad(f.rel, notes)
    if (a === null || want === undefined) continue
    // Parsed specs, so SDF Modeler's halfExtents/borderRadius spelling equals half/border.
    try {
      const have = parseColliders(a.json.collision, `${f.rel}#/collision`)
      const exp = parseColliders(want.collision, `${f.rel}#/collision (generated)`)
      if (isDeepStrictEqual(have, exp)) kept++
      else notes.push(`${f.rel}: collision ${JSON.stringify(have)} differs from the generated ${JSON.stringify(exp)}; keep it unchanged`)
    } catch (e) {
      notes.push(`${f.rel}: ${messageOf(e)}`)
    }
  }
  let fits = 0
  let solid = 0
  for (const f of FILES) {
    const a = await tryLoad(f.rel, [])
    if (a === null || (a.asset.category !== 'obstacle' && a.asset.category !== 'prop')) continue
    solid++
    try {
      const problem = visualFitsCollision(a)
      if (problem === null) fits++
      else notes.push(`${f.rel}: ${problem}`)
    } catch (e) {
      if (!isRefusal(e)) throw e
      notes.push(`${f.rel}: ${messageOf(e)}`)
    }
  }
  return {
    value: `kept=${kept}/${nReworked} fits=${fits}/${solid}`,
    threshold: `kept=${nReworked}/${nReworked} fits=${solid}/${solid}`,
    pass: kept === nReworked && fits === solid && notes.length === 0,
    notes,
  }
}

// ---- views ---------------------------------------------------------------------------------------------

interface Shape { name: string; assets: string[]; views: string[] }

async function readJson(rel: string): Promise<unknown | null> {
  let text: string
  try {
    text = await readFile(contentPath(rel), 'utf8')
  } catch {
    return null
  }
  return JSON.parse(text)
}

async function checkViews(): Promise<CheckResult> {
  const notes: string[] = []
  // The subjects come from the asset table, so a hand-edited input cannot shrink the proof.
  const expected: Shape[] = FILES.map(f => ({ name: f.id.replace('.', '-'), assets: [f.id], views: ['three-quarter'] }))
  const total = expected.length
  const value = (ok: number): string => `${ok}/${total}`
  const threshold = `${total}/${total}`
  const input = await readJson(VIEWS_INPUT) as { subjects: Shape[] } | null
  if (input === null) notes.push(`${VIEWS_INPUT}: missing; restore the committed input`)
  else {
    const have = input.subjects.map(s => ({ name: s.name, assets: s.assets, views: s.views }))
    if (!isDeepStrictEqual(have, expected)) notes.push(`${VIEWS_INPUT}: subjects ${JSON.stringify(have)} differ from the asset table ${JSON.stringify(expected)}; fix the input`)
  }
  const record = await readJson(VIEWS_RECORD) as ViewsRecord | null
  if (record === null) return { value: value(0), threshold, pass: false, notes: [...notes, `${VIEWS_RECORD}: missing; run the C3 producer`] }
  const got = record.subjects.map(s => ({ name: s.name, assets: Object.keys(s.assets), views: s.views.map(v => v.name) }))
  if (!isDeepStrictEqual(got, expected)) {
    notes.push(`${VIEWS_RECORD}: subjects/views ${JSON.stringify(got)} differ from the asset table; re-run tools/viewsRecord.ts ${VIEWS_INPUT}`)
  }
  const problems = await viewsProblems(record, repoRoot())
  notes.push(...problems.map(p => `${VIEWS_RECORD}: ${p}`))
  // A view counts when its subject is fresh and the view itself is 1024x1024 and not empty.
  let ok = 0
  for (const s of record.subjects) {
    const want = expected.find(e => e.name === s.name)
    if (want === undefined) continue
    const stale = problems.some(p => p.startsWith(`${s.name}: `))
    for (const v of s.views) {
      if (!stale && want.views.includes(v.name) && v.width === 1024 && v.height === 1024 && v.nonEmpty) ok++
    }
  }
  return { value: value(ok), threshold, pass: ok === total && notes.length === 0, notes }
}

const checks: ProofCheck[] = [
  { label: 'assets', inQuick: true, run: checkAssets },
  { label: 'collision-kept', inQuick: true, run: checkCollisionKept },
  { label: 'views', inQuick: true, run: checkViews },
]

await runProof('c3-candy-kit', import.meta.url, checks)
