import { readFile } from 'node:fs/promises'
import { loadEngine } from '@etcito/game-engine'
import type { EngineInstance } from '@etcito/game-engine/loader'
import { loadCourseV1 } from '@royal-fiesta/game/courseV1'
import type { CourseV1, ResolvedGameAsset } from '@royal-fiesta/game/courseV1'
import { RF_EGE_SCHEMA } from '@royal-fiesta/game/ege/files'
import { createEngineRound } from '@royal-fiesta/game/ege/round'
import type { EngineRound, RoundSetup } from '@royal-fiesta/game/ege/round'
import type { RoundObservation } from '@royal-fiesta/game/ege/observe'
import { emitEngineScene } from '@royal-fiesta/game/ege/sceneEmitter'
import type { EmittedScene } from '@royal-fiesta/game/ege/sceneEmitter'
import { compileRfScripts, formatRfDiagnostic } from '../../../tools/egeScripts.ts'
import { nodeGameAssets } from './contentFiles.ts'
import { readRepoText, repoPath } from './files.ts'

export async function loadEgeCourse(id: string): Promise<{ course: CourseV1; assets: Map<string, ResolvedGameAsset> }> {
  let path = `courses/${id}.course.json`
  let text: string
  try {
    text = await readFile(repoPath(path), 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    path = `fixtures/ege/${id}.course.json`
    text = await readRepoText(path)
  }
  const resolver = nodeGameAssets()
  const course = await loadCourseV1(JSON.parse(text), path, resolver)
  const assets = new Map<string, ResolvedGameAsset>()
  for (const assetId of course.assetIds) assets.set(assetId, await resolver.resolve(assetId))
  return { course, assets }
}

let scripts: Promise<Uint8Array<ArrayBuffer>> | undefined

export function rfScriptBytes(): Promise<Uint8Array<ArrayBuffer>> {
  scripts ??= compileRfScripts().then(result => {
    const errors = result.diagnostics.filter(diagnostic => diagnostic.severity === 'error')
    if (errors.length) throw new Error(errors.map(formatRfDiagnostic).join('\n'))
    if (!result.wasm) throw new Error('RF script compilation produced no wasm')
    return new Uint8Array(result.wasm)
  })
  return scripts
}

export async function harnessRound(id: string, setup: Partial<RoundSetup> = {}): Promise<{
  engine: EngineInstance
  scene: EmittedScene
  course: CourseV1
  round: EngineRound
}> {
  const options: RoundSetup = {
    profile: setup.profile ?? 'sprint',
    seed: setup.seed ?? 7,
    humans: setup.humans ?? [true, false, false, false, false, false, false, false],
  }
  const { course, assets } = await loadEgeCourse(id)
  const engine = await loadEngine()
  const schemaText = await readRepoText(RF_EGE_SCHEMA)
  engine.setSchema(schemaText)
  const scene = emitEngineScene(engine, { course, assets, setup: options })
  const round = await createEngineRound(engine, schemaText, await rfScriptBytes(), scene, course, options)
  return { engine, scene, course, round }
}

export function runTicks(round: EngineRound, n: number, human: (seat: number, tick: number) => number): RoundObservation {
  for (let i = 0; i < n; i++) round.step(seat => human(seat, round.tick))
  return round.observe()
}
