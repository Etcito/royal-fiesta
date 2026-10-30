// Node meshing uses a terminable thread so synchronous MAMA work cannot block the timeout.
// Only tsconfig.mama.json checks this file; callers import it through a computed specifier.
import { existsSync } from 'node:fs'
import { register } from 'node:module'
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { GameAsset } from '@royal-fiesta/game/gameAsset'
import { RefusalError, refuse, isRefusal } from '@royal-fiesta/sim/refusal'
import { MAMA_ABSENT_PREFIX, mamaSource, raaSdfmVersion } from '../../../../tools/bricks.ts'
import type { MeshedAsset, MeshRequest } from '../../../web/src/sdf/mamaApi.ts'

type WorkerModule = typeof import('../../../web/src/sdf/mama/worker.ts')

function absent(reason: string): RefusalError {
  return new RefusalError('sdf', 'MAMA', MAMA_ABSENT_PREFIX + reason + '; see docs/bricks.md')
}

function resolvedMama(): { dir: string; commit: string } {
  const source = mamaSource()
  if (source.kind === 'absent') throw absent(source.reason)
  if (source.commit === null) throw absent(`${source.dir} has no readable git HEAD; check out a MAMA commit there`)
  return { dir: source.dir, commit: source.commit }
}

// S15: the resolved commit (a sibling's HEAD, even when it differs from the pin).
export function mamaVersion(): string {
  return resolvedMama().commit
}

export { raaSdfmVersion }

// Node cannot read tsconfig paths, and MAMA's sources import .js names: @etcito/mama/<x>.ts resolves
// to MAMA's built dist/<x>.js, whose own imports find MAMA's node_modules.
function hookSource(distUrl: string): string {
  return [
    `const BASE = ${JSON.stringify(distUrl)}`,
    'export async function resolve(specifier, context, next) {',
    "  if (specifier.startsWith('@etcito/mama/')) {",
    "    const rest = specifier.slice('@etcito/mama/'.length).replace(/\\.ts$/, '.js')",
    '    return { url: new URL(rest, BASE).href, shortCircuit: true }',
    '  }',
    '  return next(specifier, context)',
    '}',
  ].join('\n')
}

let loaded: Promise<WorkerModule> | null = null

async function loadWorker(): Promise<WorkerModule> {
  const { dir } = resolvedMama()
  const dist = join(dir, 'dist')
  if (!existsSync(join(dist, 'index.js'))) throw absent(`${dist} is not built; run npm run build in ${dir}`)
  const wasm = join(dir, 'node_modules', 'manifold-3d', 'manifold.wasm')
  if (!existsSync(wasm)) throw absent(`${wasm} is missing; run npm ci in ${dir}`)
  register('data:text/javascript,' + encodeURIComponent(hookSource(pathToFileURL(dist + '/').href)))
  // Plugins and the bitmap decoder, as every MAMA Node host installs them.
  const plugins = (await import('@etcito/mama/node/load-plugins.ts')) as typeof import('@etcito/mama/node/load-plugins.ts')
  await plugins.loadCorePlugins()
  // The manifold wasm from its file path, before the worker's first ensureMesher.
  const runtime = (await import('@etcito/mama/core/paramesh/runtime.ts')) as typeof import('@etcito/mama/core/paramesh/runtime.ts')
  runtime.setMesherWasm(wasm)
  await runtime.ensureMesher()
  // Variable specifier: the root typecheck never follows it (it excludes mama/ anyway).
  const workerUrl = new URL('../../../web/src/sdf/mama/worker.ts', import.meta.url).href
  return (await import(workerUrl)) as WorkerModule
}

// Once per Node thread: one resolve hook, one plugin install, one manifold init.
function worker(): Promise<WorkerModule> {
  loaded ??= loadWorker().catch((e: unknown) => {
    loaded = null
    throw e
  })
  return loaded
}

export function meshRequestOf(asset: GameAsset): MeshRequest {
  return { assetId: asset.id, hash: asset.hash, mesher: asset.mesher, document: asset.document }
}

export interface MeshNodeOptions { timeoutMs?: number }

interface Payload {
  groups: unknown[]
  materials: { name: string; [key: string]: unknown }[]
}

// Only the asset selection metadata changes in this private copy. Geometry, mesher declarations,
// params and document defaults reach the shared worker unchanged.
function groupRequest(req: MeshRequest, group: string): MeshRequest {
  const document = structuredClone(req.document)
  const nodes = document.nodes as Record<string, { asset?: unknown }>
  for (const [id, node] of Object.entries(nodes)) if (id !== group) delete node.asset
  return { ...req, document }
}

async function meshGroup(req: MeshRequest, group: string | null, timeoutMs: number, signal?: AbortSignal): Promise<MeshedAsset> {
  const thread = new Worker(new URL(import.meta.url), { workerData: { meshNode: true } })
  const abort = (): void => { void thread.terminate() }
  signal?.addEventListener('abort', abort, { once: true })
  if (signal?.aborted) abort()
  try {
    return await new Promise<MeshedAsset>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      if (group === null) timer = setTimeout(() => fail(`timed out after ${timeoutMs / 1000} s`), timeoutMs)
      const fail = (reason: string): void => {
        reject(new RefusalError('mesh', group === null ? req.assetId : `${req.assetId}#${group}`, `${reason}; update the MAMA pin or re-save the asset in SDF Modeler`))
      }
      thread.on('message', (message) => {
        if (message.ready) {
          // Start each group's budget after plugin/wasm initialisation.
          if (group !== null) timer = setTimeout(() => fail(`timed out after ${timeoutMs / 1000} s`), timeoutMs)
          thread.postMessage(group === null ? req : groupRequest(req, group))
        } else {
          clearTimeout(timer)
          if (message.ok) resolve(message.value as MeshedAsset)
          else fail(message.reason as string)
        }
      })
      thread.once('error', (error) => { clearTimeout(timer); fail(error.message) })
      thread.once('exit', (code) => { clearTimeout(timer); fail(`MAMA thread exited (${code}) without a result`) })
    })
  } finally {
    signal?.removeEventListener('abort', abort)
    await thread.terminate()
  }
}

export async function meshWholeAsset(asset: GameAsset, timeoutMs = 300000, signal?: AbortSignal): Promise<MeshedAsset> {
  return meshGroup(meshRequestOf(asset), null, timeoutMs, signal)
}

export async function meshGameAsset(asset: GameAsset, options: MeshNodeOptions = {}): Promise<MeshedAsset> {
  const timeoutMs = options.timeoutMs ?? 300000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) refuse('mesh', asset.id, 'timeoutMs must be positive and finite; supply a duration in milliseconds')
  const req = meshRequestOf(asset)
  const nodes = req.document.nodes as Record<string, { kind: string; asset?: unknown; children?: string[] }>
  const groups: string[] = []
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visited.has(id) || !nodes[id]) return
    visited.add(id)
    const node = nodes[id]
    if (node.kind === 'group' && node.asset !== undefined) groups.push(id)
    for (const child of node.children ?? []) visit(child)
  }
  for (const id of req.document.root as string[]) visit(id)
  if (groups.length === 0) refuse('mesh', asset.id, 'no game asset groups; mark a group as a game asset in SDF Modeler')
  const data: Payload = { groups: [], materials: [] }
  const result: MeshedAsset = { assetId: asset.id, hash: asset.hash, mesher: asset.mesher.output, parts: 0, triangles: 0, data, transfer: [] }
  for (const group of groups) {
    const value = await meshGroup(req, group, timeoutMs)
    const payload = value.data as Payload
    result.parts += value.parts
    result.triangles += value.triangles
    result.transfer.push(...value.transfer)
    data.groups.push(...payload.groups)
    for (const material of payload.materials) {
      if (!data.materials.some(existing => existing.name === material.name)) data.materials.push(material)
    }
  }
  return result
}

if (!isMainThread && (workerData as { meshNode?: boolean } | null)?.meshNode) {
  void worker().then(mod => {
    parentPort!.on('message', async (req: MeshRequest) => {
      try {
        const value = await mod.meshRequest(req)
        parentPort!.postMessage({ ok: true, value }, value.transfer)
      } catch (error) {
        parentPort!.postMessage({ ok: false, reason: isRefusal(error) ? error.reason : error instanceof Error ? error.message : String(error) })
      }
    })
    parentPort!.postMessage({ ready: true })
  }).catch(error => {
    parentPort!.postMessage({ ok: false, reason: error instanceof Error ? error.message : String(error) })
  })
}
