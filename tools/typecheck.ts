// npm run typecheck: every TypeScript project of the repository, the root one and each workspace's own
// (apps/*/tsconfig.json, packages/*/tsconfig.json, found on disk so a new workspace is checked without editing this).
// The root project leaves the MAMA modules out (a public clone has no MAMA); apps/web and apps/headless compile them
// with the rest of the app, as Vite bundles them, so their programs are the ones that see MAMA's sources and RF's code
// together. `tsc -p apps/web` was red for weeks because nothing ran it (2026-11-05). The pre-push hook runs this.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { mamaSource, repoRoot } from './bricks.ts'

interface Project { config: string; needsMama: boolean }

export function typecheckProjects(root: string): Project[] {
  const configs = ['tsconfig.json']
  for (const group of ['apps', 'packages']) {
    const dir = join(root, group)
    if (!existsSync(dir)) continue
    for (const name of readdirSync(dir).sort()) {
      if (existsSync(join(dir, name, 'tsconfig.json'))) configs.push(`${group}/${name}/tsconfig.json`)
    }
  }
  // A project that maps @etcito/mama/* onto .bricks/MAMA compiles MAMA's sources.
  return configs.map(config => ({ config, needsMama: readFileSync(join(root, config), 'utf8').includes('.bricks/MAMA') }))
}

function run(root: string, config: string): Promise<{ code: number; output: string }> {
  return new Promise(resolve => {
    const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc')
    const child = spawn(process.execPath, [tsc, '--noEmit', '-p', config], { cwd: root })
    let output = ''
    child.stdout.on('data', chunk => { output += chunk })
    child.stderr.on('data', chunk => { output += chunk })
    child.on('error', error => resolve({ code: 1, output: `could not run tsc: ${error.message}\n` }))
    child.on('close', code => resolve({ code: code ?? 1, output }))
  })
}

async function main(): Promise<void> {
  const root = repoRoot()
  const mama = mamaSource(root)
  const projects = typecheckProjects(root)
  const runnable: Project[] = []
  for (const project of projects) {
    if (!project.needsMama) runnable.push(project)
    else if (mama.kind === 'absent') console.log(`typecheck: ${project.config} skipped, MAMA is absent (${mama.reason})`)
    else if (!existsSync(join(root, '.bricks', 'MAMA', 'src'))) {
      console.error(`typecheck: ${project.config} reads MAMA through .bricks/MAMA, which is missing; run npm run bricks -- fetch mama`)
      process.exitCode = 1
      return
    } else runnable.push(project)
  }
  const results = await Promise.all(runnable.map(async project => ({ project, ...(await run(root, project.config)) })))
  let failed = 0
  for (const { project, code, output } of results) {
    if (code === 0) {
      console.log(`typecheck: ${project.config} ok`)
      continue
    }
    failed++
    console.error(`typecheck: ${project.config} failed\n${output.trimEnd()}`)
  }
  if (failed > 0) {
    console.error(`typecheck: ${failed} project(s) red; fix each error at its cause (no ts-ignore, no excludes, no looser options)`)
    process.exitCode = 1
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) await main()
