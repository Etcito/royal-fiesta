import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { report, runProof } from '@royal-fiesta/headless/proofkit'
import type { CheckResult, ProofCheck } from '@royal-fiesta/headless/proofkit'
import { isAuthored, readAuthored } from '../../../tools/authored.ts'
import { repoRoot } from '../../../tools/bricks.ts'
import { documentNodes, loadAssetFile, materialColours, mountedBounds, proceduralProblems, rigidGroups } from '../../../tools/contentProbe.ts'
import type { AuthoredAsset } from '../../../tools/contentProbe.ts'
import { buildContent } from '../../../tools/placeholders.ts'
import { viewsProblems } from '../../../tools/viewsRecord.ts'
import type { ViewsRecord } from '../../../tools/viewsRecord.ts'

// C2: the authored penguin and its three costumes hold the 1.12 values, the 1.11 budgets and rules,
// and the committed SDF Modeler views record is fresh (1.14). Reads committed files only, writes none.

type V3 = [number, number, number]

const PENGUIN = 'assets/common/penguin.body.asset.json'
const COSTUMES = [
  { id: 'costume.propeller-hat', anchor: 'head' },
  { id: 'costume.fish-scarf', anchor: 'neck' },
  { id: 'costume.pineapple-suit', anchor: 'body' },
]
const costumePath = (id: string): string => `assets/common/${id}.asset.json`
const FILES = [
  { rel: PENGUIN, id: 'penguin.body', category: 'character', maxNodes: 160 },
  ...COSTUMES.map(c => ({ rel: costumePath(c.id), id: c.id, category: 'cosmetic', maxNodes: 64 })),
]

const GROUPS: Record<string, V3> = {
  body: [0, 0, 0],
  head: [0, 0.38, 0],
  'flipper-r': [0.40, 0.15, 0],
  'flipper-l': [-0.40, 0.15, 0],
  'foot-r': [0.18, -0.70, 0.05],
  'foot-l': [-0.18, -0.70, 0.05],
}
const ANCHORS: Record<string, V3> = { body: [0, 0, 0], neck: [0, 0.30, 0], head: [0, 0.80, 0] }
const EPS = 1e-6
const COSTUME_MARGIN = 0.45
const VIEWS_INPUT = 'proofs/c2/views.input.json'
const VIEWS_RECORD = 'proofs/c2/views.json'

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

const near = (a: readonly number[], b: readonly number[]): boolean => a.every((v, i) => Math.abs(v - b[i]) <= EPS)
const fmt = (v: readonly number[]): string => `(${v.join(', ')})`

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
    return (await readFile(join(repoRoot(), rel))).length
  } catch {
    return null
  }
}

// ---- assets --------------------------------------------------------------------------------------------

async function checkAssets(): Promise<CheckResult> {
  const notes: string[] = []
  const authored = readAuthored(repoRoot())
  const generated = (await buildContent({ files: [] })).get(PENGUIN)
  const expectedCollision = generated === undefined ? undefined : (JSON.parse(generated) as Record<string, unknown>).collision
  if (expectedCollision === undefined) notes.push(`${PENGUIN}: tools/placeholders.ts no longer generates it; the reference collision is unknown`)
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
    if (asset.world !== 'common') notes.push(`${f.rel}: world '${asset.world}', expected 'common'`)
    if (asset.category !== f.category) notes.push(`${f.rel}: category '${asset.category}', expected '${f.category}'`)
    if (asset.mesher.output !== 'quad') notes.push(`${f.rel}: mesher.output '${asset.mesher.output}', expected 'quad'`)
    if (f.rel === PENGUIN) {
      if (expectedCollision !== undefined && !isDeepStrictEqual(a.json.collision, expectedCollision)) {
        notes.push(`${f.rel}: collision ${JSON.stringify(a.json.collision)} differs from the generated ${JSON.stringify(expectedCollision)}; keep it unchanged`)
      }
    } else if (asset.collision.length !== 0) {
      notes.push(`${f.rel}: collision has ${asset.collision.length} colliders; a costume has collision []`)
    }
    let nodes = -1
    try {
      nodes = documentNodes(a).length
      if (nodes > f.maxNodes) notes.push(`${f.rel}: ${nodes} document nodes > ${f.maxNodes}; simplify the scene`)
    } catch (e) {
      if (!isRefusal(e)) throw e
      notes.push(`${f.rel}: ${messageOf(e)}`)
    }
    notes.push(...proceduralProblems(a, bytes))
    report(`assets:${f.id}`, { nodes, bytes })
    if (notes.length === before) ok++
  }
  return { value: `${ok}/${FILES.length}`, threshold: `${FILES.length}/${FILES.length}`, pass: ok === FILES.length && notes.length === 0, notes }
}

// ---- structure -----------------------------------------------------------------------------------------

const xyz = (v: { x: number; y: number; z: number }): V3 => [v.x, v.y, v.z]

async function checkStructure(): Promise<CheckResult> {
  const notes: string[] = []
  let groupsOk = 0
  let anchorsOk = 0
  let plush = 0
  let costumesOk = 0
  const body = await tryLoad(PENGUIN, notes)
  if (body !== null) {
    try {
      const groups = rigidGroups(body)
      const names = groups.map(g => g.name)
      for (const n of names) if (!(n in GROUPS)) notes.push(`${PENGUIN}: unexpected rigid group '${n}'; keep only ${Object.keys(GROUPS).join(', ')}`)
      for (const [name, pivot] of Object.entries(GROUPS)) {
        const hits = groups.filter(g => g.name === name)
        if (hits.length !== 1) {
          notes.push(`${PENGUIN}: ${hits.length} rigid groups named '${name}', expected 1`)
          continue
        }
        const g = hits[0]
        const output = typeof g.mesher === 'object' && g.mesher !== null ? (g.mesher as Record<string, unknown>).output : undefined
        const before = notes.length
        if (output !== 'quad') notes.push(`${PENGUIN}: rigid group '${name}' mesher.output ${JSON.stringify(output)}, expected 'quad'`)
        if (!near(g.pivot, pivot)) notes.push(`${PENGUIN}: rigid group '${name}' pivot ${fmt(g.pivot)}, expected ${fmt(pivot)} within ${EPS}`)
        if (notes.length === before) groupsOk++
      }
      if (names.some(n => !(n in GROUPS))) groupsOk = Math.min(groupsOk, Object.keys(GROUPS).length - 1)
    } catch (e) {
      if (!isRefusal(e)) throw e
      notes.push(`${PENGUIN}: ${messageOf(e)}`)
    }
    const anchors = body.asset.anchors
    for (const n of Object.keys(anchors)) if (!(n in ANCHORS)) notes.push(`${PENGUIN}: unexpected anchor '${n}'; keep only body, neck, head`)
    for (const [name, t] of Object.entries(ANCHORS)) {
      const a = anchors[name]
      if (a === undefined) {
        notes.push(`${PENGUIN}: anchor '${name}' missing; add it at ${fmt(t)}`)
        continue
      }
      const before = notes.length
      if (!near(xyz(a.t), t)) notes.push(`${PENGUIN}: anchor '${name}' t ${fmt(xyz(a.t))}, expected ${fmt(t)} within ${EPS}`)
      const r = [a.r.x, a.r.y, a.r.z, a.r.w]
      if (!near(r, [0, 0, 0, 1])) notes.push(`${PENGUIN}: anchor '${name}' r ${fmt(r)}, expected identity (0, 0, 0, 1)`)
      if (notes.length === before) anchorsOk++
    }
    if (Object.keys(anchors).some(n => !(n in ANCHORS))) anchorsOk = Math.min(anchorsOk, Object.keys(ANCHORS).length - 1)
    try {
      const colours = materialColours(body)
      plush = colours.filter(c => c.name === 'penguin-plush').length
      report('structure:materials', { materialColours: colours.map(c => `${c.name}=${c.hex}`).join(',') || '-' })
    } catch (e) {
      if (!isRefusal(e)) throw e
      notes.push(`${PENGUIN}: ${messageOf(e)}`)
    }
    if (plush !== 1) notes.push(`${PENGUIN}: ${plush} materials named 'penguin-plush' in document.materials, expected 1`)
  }
  for (const c of COSTUMES) {
    const rel = costumePath(c.id)
    const costume = await tryLoad(rel, notes)
    if (costume === null || body === null) continue
    const names = Object.keys(costume.asset.anchors)
    if (names.length !== 1 || names[0] !== c.anchor) {
      notes.push(`${rel}: anchors [${names.join(', ')}], expected exactly one named '${c.anchor}'`)
      continue
    }
    let m: { min: V3; max: V3 }
    try {
      m = mountedBounds(costume, body)
    } catch (e) {
      if (!isRefusal(e)) throw e
      notes.push(`${rel}: ${messageOf(e)}`)
      continue
    }
    const lo = xyz(body.asset.bounds.min).map(v => v - COSTUME_MARGIN)
    const hi = xyz(body.asset.bounds.max).map(v => v + COSTUME_MARGIN)
    const inside = m.min.every((v, i) => v >= lo[i] - EPS) && m.max.every((v, i) => v <= hi[i] + EPS)
    if (!inside) notes.push(`${rel}: mounted bounds ${fmt(m.min)}..${fmt(m.max)} leave the penguin bounds + ${COSTUME_MARGIN} m ${fmt(lo)}..${fmt(hi)}`)
    else costumesOk++
  }
  const nG = Object.keys(GROUPS).length
  const nA = Object.keys(ANCHORS).length
  const pass = groupsOk === nG && anchorsOk === nA && plush === 1 && costumesOk === COSTUMES.length && notes.length === 0
  return {
    value: `groups=${groupsOk}/${nG} anchors=${anchorsOk}/${nA} plush=${plush} costumes=${costumesOk}/${COSTUMES.length}`,
    threshold: `groups=${nG}/${nG} anchors=${nA}/${nA} plush=1 costumes=${COSTUMES.length}/${COSTUMES.length}`,
    pass, notes,
  }
}

// ---- views ---------------------------------------------------------------------------------------------

interface Shape { name: string; assets: string[]; views: string[] }

async function readJson(rel: string): Promise<unknown | null> {
  let text: string
  try {
    text = await readFile(join(repoRoot(), rel), 'utf8')
  } catch {
    return null
  }
  return JSON.parse(text)
}

async function checkViews(): Promise<CheckResult> {
  const notes: string[] = []
  const input = await readJson(VIEWS_INPUT) as { subjects: Shape[] } | null
  if (input === null) return { value: '0/?', threshold: '12/12', pass: false, notes: [`${VIEWS_INPUT}: missing; restore the committed input`] }
  const expected = input.subjects.map(s => ({ name: s.name, assets: s.assets, views: s.views }))
  const total = expected.reduce((n, s) => n + s.views.length, 0)
  const value = (ok: number): string => `${ok}/${total}`
  const threshold = `${total}/${total}`
  const record = await readJson(VIEWS_RECORD) as ViewsRecord | null
  if (record === null) return { value: value(0), threshold, pass: false, notes: [`${VIEWS_RECORD}: missing; run the C2 producer`] }
  const got = record.subjects.map(s => ({ name: s.name, assets: Object.keys(s.assets), views: s.views.map(v => v.name) }))
  if (!isDeepStrictEqual(got, expected)) {
    notes.push(`${VIEWS_RECORD}: subjects/views ${JSON.stringify(got)} differ from ${VIEWS_INPUT}; re-run tools/viewsRecord.ts ${VIEWS_INPUT}`)
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
  { label: 'structure', inQuick: true, run: checkStructure },
  { label: 'views', inQuick: true, run: checkViews },
]

await runProof('c2-penguin', import.meta.url, checks)
