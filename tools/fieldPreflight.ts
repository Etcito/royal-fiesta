// Field shading preflight: what the fieldShading GPU op (apps/web/src/game/checks/fieldShading.ts) will report for every
// saved part of its world, read statically from the saved .mesh files in about a second, with no browser and no render.
// It runs the same pure decisions SdfRenderPort.fieldProgramMaterial runs (checkFieldPart, the frame scale rule,
// planFieldAtlas, fieldProgramWords, fieldMaterialWgsl against RAA's 64 KB material limit), so a refused operand, an
// over-size material function or an invalid program is listed here, all of them at once, before a GPU job is spent.
// Exit 1 when a part would be a hard failure of the GPU op; refusals and atlas demotions are named fallbacks (listed).
//   node --experimental-strip-types tools/fieldPreflight.ts [--profile sprint] [--json]
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  MATERIAL_FUNCTION_MAX_BYTES, uniformFieldFrameScale, checkFieldPart, fieldMaterialWgsl, fieldProgramWords,
} from '../apps/web/src/sdf/fieldShading.ts'
import type { FieldLabelGraphLike } from '../apps/web/src/sdf/fieldShading.ts'
import { partDiag, planFieldPrograms } from '../apps/web/src/sdf/fieldAtlas.ts'
import type { PartFieldProgram } from '../apps/web/src/sdf/fieldAtlas.ts'
import { decodeMesh } from '../apps/web/src/sdf/meshWire.ts'
import { buildContentIndex, contentDir, profileAssetIds } from './content.ts'

/** field: draws its field material; refused / demoted: a named vertex fallback; scaled / invalid / material: hard. */
export type PreflightMode = 'field' | 'refused' | 'demoted' | 'scaled' | 'invalid' | 'material'
export interface PreflightPart { key: string; mode: PreflightMode; reason: string }
export interface PreflightAsset {
  id: string
  data: { groups: { group: string; parts: unknown[] }[]; materials: unknown[] }
}
export interface PreflightReport {
  fieldGridScale: number
  resampledParts: number
  repackedBytes: number
  bytes: number
  assets: number
  parts: PreflightPart[]
  /** The parts the GPU op would fail on (hardShadingFailures), with their full reason. */
  hard: PreflightPart[]
}

const HARD: ReadonlySet<PreflightMode> = new Set(['scaled', 'invalid', 'material'])

interface PartLike {
  partId: string
  frame?: ArrayLike<number>
  meshes?: { positions: Float32Array }[]
  fieldProgram?: unknown
  fieldRefusal?: unknown
}

/** Every field-contract part of `assets` as the SDF port would shade it, in asset/group/part order. */
export function fieldPreflight(assets: readonly PreflightAsset[], budget?: number): PreflightReport {
  const parts: PreflightPart[] = []
  const costs: PartFieldProgram[] = []
  const candidates: { key: string; part: PartLike; byName: Map<string, FieldLabelGraphLike> }[] = []
  for (const asset of [...assets].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))) {
    const byName = new Map((asset.data.materials as FieldLabelGraphLike[]).map(m => [m.name, m]))
    for (const group of asset.data.groups) {
      for (const raw of group.parts) {
        const part = raw as PartLike
        if (part.fieldProgram === undefined && part.fieldRefusal === undefined) continue
        if (!part.meshes || part.meshes.length === 0) continue
        const key = `${asset.id}#${group.group}/${part.partId}`
        const check = checkFieldPart(part)
        if (!check.ok) {
          const refused = typeof part.fieldRefusal === 'string' && part.fieldRefusal !== ''
          parts.push({ key, mode: refused ? 'refused' : 'invalid', reason: check.reason })
          continue
        }
        if (uniformFieldFrameScale(part.frame) === null) {
          parts.push({ key, mode: 'scaled', reason: 'field frame has non-uniform scale; mesh normals' })
          continue
        }
        costs.push({ key, diag: partDiag(part.meshes), program: check.program })
        candidates.push({ key, part, byName })
      }
    }
  }
  const gridPlan = planFieldPrograms(costs, budget)
  const plan = gridPlan.plan
  for (const { key, part, byName } of candidates) {
    if (!plan.field.has(key)) { parts.push({ key, mode: 'demoted', reason: 'atlas budget: smaller parts first' }); continue }
    const check = checkFieldPart(part)
    if (!check.ok) continue
    const words = fieldProgramWords(gridPlan.programs.get(key)!)
    if (!words.ok) { parts.push({ key, mode: 'invalid', reason: words.reason }); continue }
    const graphs = check.program.labels.map(l => (l.material === null ? null : byName.get(l.material) ?? null))
    try {
      // debug adds the ?normalsDebug lines: the larger of the two texts the page can register.
      const out = fieldMaterialWgsl({ program: gridPlan.programs.get(key)!, labelGraphs: graphs, debug: true })
      const bytes = new TextEncoder().encode(out.wgsl).length
      if (bytes > MATERIAL_FUNCTION_MAX_BYTES) {
        parts.push({ key, mode: 'material', reason: `material function ${out.functionName}: ${bytes} bytes, more than ${MATERIAL_FUNCTION_MAX_BYTES}` })
        continue
      }
    } catch (e) {
      parts.push({ key, mode: 'material', reason: e instanceof Error ? e.message : String(e) })
      continue
    }
    parts.push({ key, mode: 'field', reason: '' })
  }
  parts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
  return { assets: assets.length, parts, hard: parts.filter(p => HARD.has(p.mode)),
    fieldGridScale: gridPlan.fieldGridScale, resampledParts: gridPlan.resampledParts, repackedBytes: gridPlan.repackedBytes, bytes: plan.bytes }
}

// The fieldShading op's world: the profile's SDF load set (its costumes included) and the penguin it poses.
export async function preflightAssets(profile: 'sprint' | 'standard' = 'sprint', dir = contentDir()): Promise<PreflightAsset[]> {
  const index = buildContentIndex(dir)
  const ids = new Set([...(await profileAssetIds(profile, dir)), 'penguin.body'])
  const out: PreflightAsset[] = []
  for (const entry of index.assets) {
    if (!ids.has(entry.id) || !entry.mesh) continue
    const meshed = decodeMesh(new Uint8Array(readFileSync(join(dir, entry.mesh)))) as unknown as { data: PreflightAsset['data'] }
    out.push({ id: entry.id, data: meshed.data })
  }
  return out
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const at = args.indexOf('--profile')
  const profile = at >= 0 ? args[at + 1] : 'sprint'
  if (profile !== 'sprint' && profile !== 'standard') throw new Error(`--profile ${profile}: use sprint or standard`)
  const report = fieldPreflight(await preflightAssets(profile))
  if (args.includes('--json')) console.log(JSON.stringify(report, null, 2))
  else {
    console.info(`field grids: repacked ${report.repackedBytes} bytes, scale ${report.fieldGridScale}, final ${report.bytes} bytes (${report.resampledParts} resampled parts)`)
    const count = (mode: PreflightMode): number => report.parts.filter(p => p.mode === mode).length
    console.log(`field preflight (${profile}): ${report.assets} assets, ${report.parts.length} field-contract parts: ` +
      `${count('field')} field, ${count('refused')} refused, ${count('demoted')} atlas-demoted, ${report.hard.length} hard`)
    for (const p of report.parts) if (p.mode !== 'field' && p.mode !== 'demoted') console.log(`${p.mode}: ${p.key}: ${p.reason}`)
  }
  if (report.hard.length > 0) {
    console.error(`field preflight: ${report.hard.length} parts the fieldShading GPU op would fail on:\n` +
      report.hard.map(p => `${p.key}: ${p.reason}`).join('\n'))
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
