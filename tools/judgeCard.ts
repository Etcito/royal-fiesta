// Judge cards (S31): reads .nmc/judge/mN.json, writes the gameCapture input to out/judge/mN/input.json, then
// builds, publishes and renders the GPU page and hands each PNG to the judge client. Runs on a programmatic
// card only: a model card never waits on a GPU job. Tokens and env values are never printed.
import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { isRefusal, refuse } from '../packages/sim/src/refusal.ts'
import { repoRoot } from './bricks.ts'

const AREA = 'judge'
const GPU_CLIENT = '$NMC_GPU_CLIENT'
const JUDGE_CLIENT = '$NMC_JUDGE_CLIENT'
const PAGE_REF = '$PAGE_REF'
const PAGE = 'game'
const OP = 'gameCapture'
const MIN_SCORE = 6
const DIST_DIR = 'apps/web/dist/'
const MILESTONE_RE = /^m[0-9]{1,3}$/
const CAPTURE_RE = /^[A-Za-z0-9._+-]{1,80}$/
const INPUT_KEYS = ['page', 'op', 'input', 'judge']
const PREFIX_RE = /^[a-z0-9-]{0,24}$/
const ITEM_KEYS = ['capture', 'description']

export interface JudgeItem { capture: string; description: string }
export interface SingleJudgeInput { page: 'game'; op: 'gameCapture'; input: Record<string, unknown>; judge: JudgeItem[] }

export interface JudgeCaptureItem { prefix?: string; input: Record<string, unknown>; judge: JudgeItem[] }
export interface MultiJudgeInput { page: 'game'; op: 'gameCapture'; items: JudgeCaptureItem[] }
export type JudgeInput = SingleJudgeInput | MultiJudgeInput

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function escapePointer(key: string): string {
  return key.replace(/~/g, '~0').replace(/\//g, '~1')
}

function fail(file: string, pointer: string, reason: string): never {
  return refuse(AREA, `${file}#${pointer}`, reason)
}

function onlyKeys(o: Obj, allowed: readonly string[], file: string, pointer: string): void {
  for (const key of Object.keys(o)) {
    if (!allowed.includes(key)) {
      fail(file, `${pointer}/${escapePointer(key)}`, `has unknown key '${key}'; fix the file to keep only ${allowed.join(', ')}`)
    }
  }
}

// S31 judge input: page, op, the op input and one judge item per capture. Refusals name the file and JSON pointer.
export function parseJudgeInput(json: unknown, path: string): JudgeInput {
  if (!isObj(json)) fail(path, '/', 'is not a JSON object; fix it to {"page":"game","op":"gameCapture","input":{...},"judge":[...]}')
  onlyKeys(json, 'items' in json ? ['page', 'op', 'items'] : INPUT_KEYS, path, '')
  if (json.page !== PAGE) fail(path, '/page', `page is ${JSON.stringify(json.page)}, not '${PAGE}'; fix the judge file to run the game page`)
  if (json.op !== OP) fail(path, '/op', `op is ${JSON.stringify(json.op)}, not '${OP}'; fix the judge file to use the game capture op`)
  const seen = new Set<string>()
  if ('items' in json) {
    if (!Array.isArray(json.items) || json.items.length < 1 || json.items.length > 8) {
      fail(path, '/items', 'items must contain 1..8 items')
    }
    const items = json.items.map((raw: unknown, k: number) => {
      const at = `/items/${k}`
      if (!isObj(raw)) fail(path, at, 'item must be an object')
      onlyKeys(raw, ['prefix', 'input', 'judge'], path, at)
      if (raw.prefix !== undefined && (typeof raw.prefix !== 'string' || !PREFIX_RE.test(raw.prefix))) {
        fail(path, `${at}/prefix`, `prefix must match ${PREFIX_RE.source}`)
      }
      const prefix = (raw.prefix as string | undefined) ?? ''
      const item = parseCaptureItem(raw, path, at, prefix, seen)
      return raw.prefix === undefined ? item : { prefix, ...item }
    })
    return { page: PAGE, op: OP, items }
  }
  return { page: PAGE, op: OP, ...parseCaptureItem(json, path, '', '', seen) }
}

function parseCaptureItem(json: Obj, path: string, base: string, prefix: string, seen: Set<string>): JudgeCaptureItem {
  if (!isObj(json.input)) fail(path, `${base}/input`, 'input is not an object; fix it to the gameCapture input JSON')
  if (!Array.isArray(json.judge) || json.judge.length === 0) {
    fail(path, `${base}/judge`, 'judge is not a non-empty array; fix it to list at least one {capture, description} item')
  }
  const judge: JudgeItem[] = []
  json.judge.forEach((raw: unknown, i: number) => {
    const at = `${base}/judge/${i}`
    if (!isObj(raw)) fail(path, at, 'is not an object; fix it to {"capture": "<name>", "description": "<what the PNG must show>"}')
    onlyKeys(raw, ITEM_KEYS, path, at)
    if (typeof raw.capture !== 'string' || !CAPTURE_RE.test(raw.capture)) {
      fail(path, `${at}/capture`, `capture ${JSON.stringify(raw.capture)} is not a file-safe capture name; fix it to match ${CAPTURE_RE.source}`)
    }
    if (seen.has(prefix + raw.capture)) fail(path, `${at}/capture`, `capture '${raw.capture}' repeats; fix the file so each capture is judged once`)
    seen.add(prefix + raw.capture)
    if (typeof raw.description !== 'string' || raw.description.trim().length === 0) {
      fail(path, `${at}/description`, 'description is missing or empty; fix it to say what the capture must show')
    }
    judge.push({ capture: raw.capture, description: raw.description })
  })
  return { input: json.input, judge }
}

function outDirOf(dir: string): string {
  return dir.endsWith('/') ? dir : `${dir}/`
}

// The S31 contract, one argv array per step: build, publish, render, then one judge run per item. The client
// scripts stay as $NMC_GPU_CLIENT / $NMC_JUDGE_CLIENT here; main resolves them from the environment. Render
// takes the page_ref that publish printed ($PAGE_REF here), never a fixed page name. The client's first argument
// is the op the page declares in nmc.gpu.json (gameCapture), not the word 'render'.
export function judgeCommands(input: JudgeInput, outDir: string, inputPath: string, itemIndex?: number): string[][] {
  const selected = selectedItems(input, itemIndex)
  const dir = outDirOf(outDir)
  const commands: string[][] = [
    ['npm', 'run', 'build'],
    // The plain web build has no game data and the page fetches content/index.json from its own folder:
    // pack it into the published dist (a missing file is a CORS-less 404, a bare "Failed to fetch" in the page).
    ['npm', 'run', 'content:pack', '--', `${DIST_DIR}content`],
    ['node', GPU_CLIENT, 'publish', DIST_DIR],
  ]
  for (const { item, k } of selected) {
    const multi = 'items' in input
    const renderDir = multi ? `${dir}item-${k}/` : dir
    commands.push(['node', GPU_CLIENT, input.op, multi ? `${dir}input-${k}.json` : inputPath, '--page-ref', PAGE_REF, '-o', renderDir])
    if (multi) for (const entry of item.judge) {
      commands.push(['cp', `${renderDir}${entry.capture}.png`, `${dir}${item.prefix ?? ''}${entry.capture}.png`])
    }
  }
  for (const { item } of selected) for (const entry of item.judge) {
    commands.push(['python3', JUDGE_CLIENT, `${dir}${item.prefix ?? ''}${entry.capture}.png`, '--description', entry.description, '--min-score', String(MIN_SCORE)])
  }
  return commands
}

function selectedItems(input: JudgeInput, itemIndex?: number): { item: JudgeCaptureItem; k: number }[] {
  const items = 'items' in input ? input.items : [input]
  if (itemIndex !== undefined && (!Number.isInteger(itemIndex) || itemIndex < 0 || itemIndex >= items.length)) {
    refuse(AREA, 'argv/--item', 'item index is out of range')
  }
  return items.map((item, k) => ({ item, k })).filter(({ k }) => itemIndex === undefined || k === itemIndex)
}

function clientEnv(name: string, wait: boolean): string {
  const value = process.env[name]
  if (value === undefined || value.trim().length === 0) {
    if (wait) {
      return refuse(AREA, name, 'is unset; no GPU client is attached (waiting for a GPU client; a job fails with GPU waiting timeout); fix by running this card where the GPU client is attached')
    }
    return refuse(AREA, name, 'is unset; fix by running this card where the judge client is attached')
  }
  return value
}

function resolveStep(args: readonly string[], gpu: string, judge: string, pageRef: string | null): string[] {
  return args.map(arg => {
    if (arg === GPU_CLIENT) return gpu
    if (arg === JUDGE_CLIENT) return judge
    if (arg === PAGE_REF) return pageRef ?? refuse(AREA, 'render', 'has no page_ref; publish must run first and print {"page_ref": ...}')
    return arg
  })
}

interface StepResult { code: number; stdout: string }

// stdout is echoed and kept when capture is set (publish), so its page_ref can feed the render step.
function runStep(args: readonly string[], cwd: string, capture: boolean): Promise<StepResult> {
  return new Promise((done, reject) => {
    const command = args[0]
    if (command === undefined) return reject(new Error('empty command'))
    const child = spawn(process.platform === 'win32' && command === 'npm' ? 'npm.cmd' : command, args.slice(1), {
      cwd,
      stdio: ['inherit', capture ? 'pipe' : 'inherit', 'inherit'],
    })
    let stdout = ''
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8')
      process.stdout.write(chunk)
    })
    child.once('error', reject)
    child.once('close', code => done({ code: code ?? 1, stdout }))
  })
}

export function pageRefOf(stdout: string): string {
  let result: unknown
  try {
    result = JSON.parse(stdout.trim()) as unknown
  } catch {
    return refuse(AREA, 'publish', 'printed invalid JSON; check the GPU client publish response')
  }
  if (!isObj(result) || typeof result.page_ref !== 'string' || result.page_ref.length === 0) {
    return refuse(AREA, 'publish', 'response has no page_ref; use the GPU client response for the published page')
  }
  return result.page_ref
}

function labelOf(args: readonly string[], index: number): string {
  const op = args[2]
  if (index === 0) return 'build'
  if (args[2] === 'content:pack') return 'pack content'
  if (args[0] === 'cp') return `copy ${args[2]}`
  if (op === 'publish') return 'publish'
  if (op === OP) return 'render'
  const png = args[2]
  return png === undefined ? `judge ${index}` : `judge ${png.slice(png.lastIndexOf('/') + 1)}`
}

function readJudgeInput(root: string, rel: string): unknown {
  let text: string
  try {
    text = readFileSync(join(root, rel), 'utf8')
  } catch {
    return refuse(AREA, rel, 'cannot read the judge file; fix the path or write it under .nmc/judge/')
  }
  try {
    return JSON.parse(text) as unknown
  } catch (e) {
    return fail(rel, '/', `invalid JSON (${(e as Error).message}); fix the file syntax`)
  }
}

export async function main(argv: string[]): Promise<number> {
  try {
    const name = argv[0]
    if ((argv.length !== 1 && !(argv.length === 3 && argv[1] === '--item' && /^[0-9]+$/.test(argv[2]!))) || name === undefined || !MILESTONE_RE.test(name)) {
      refuse(AREA, 'argv', 'takes one milestone name like m1; fix the call to: node --experimental-strip-types tools/judgeCard.ts m1 [--item k]')
    }
    const itemIndex = argv[2] === undefined ? undefined : Number(argv[2])
    const root = repoRoot()
    const judgePath = `.nmc/judge/${name}.json`
    const input = parseJudgeInput(readJudgeInput(root, judgePath), judgePath)
    const outDir = `out/judge/${name}/`
    const inputPath = `${outDir}input.json`
    const selected = selectedItems(input, itemIndex)
    mkdirSync(join(root, outDir), { recursive: true })
    for (const { item, k } of selected) {
      const path = 'items' in input ? `${outDir}input-${k}.json` : inputPath
      writeFileSync(join(root, path), `${JSON.stringify(item.input, null, 2)}\n`)
    }
    const commands = judgeCommands(input, outDir, inputPath, itemIndex)
    let pageRef: string | null = null
    for (let i = 0; i < commands.length; i++) {
      const step = commands[i] as string[]
      const label = labelOf(step, i)
      console.log(`[judge] ${name} ${i + 1}/${commands.length}: ${label}`)
      let result: StepResult
      try {
        // Build and input preparation also work without attached clients.
        // Resolve credentials only at the step that actually needs them.
        const gpu = step.includes(GPU_CLIENT) ? clientEnv('NMC_GPU_CLIENT', true) : ''
        const judge = step.includes(JUDGE_CLIENT) ? clientEnv('NMC_JUDGE_CLIENT', false) : ''
        result = await runStep(resolveStep(step, gpu, judge, pageRef), root, label === 'publish')
      } catch (e) {
        if (isRefusal(e)) throw e
        return refuse(AREA, label, 'could not start; fix the command or the client script')
      }
      if (result.code !== 0) {
        console.error(`[judge] ${name} ${label} exited with ${result.code}; stopping`)
        return 1
      }
      if (label === 'publish') pageRef = pageRefOf(result.stdout)
    }
    console.log(`[judge] ${name} passed ${selected.reduce((count, { item }) => count + item.judge.length, 0)} judge item(s); PNGs in ${outDir}`)
    return 0
  } catch (e) {
    if (!isRefusal(e)) throw e
    console.error(e.message)
    return 1
  }
}

const entry = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : ''
if (import.meta.url === entry) process.exitCode = await main(process.argv.slice(2))
