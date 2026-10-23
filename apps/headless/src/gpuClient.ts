import { spawn } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { isRefusal, refuse } from '@royal-fiesta/sim/refusal'

const AREA = 'gpu-client'

export interface OpResult { file: string; json: unknown }

function clientPath(): string {
  const path = process.env.NMC_GPU_CLIENT
  if (!path) refuse(AREA, 'NMC_GPU_CLIENT', 'is unset; set it to the GPU client script path supplied by the card')
  return path
}

function waitMs(): number {
  const raw = process.env.NMC_GPU_WAIT_S
  if (raw === undefined || raw === '') return 150_000
  const seconds = Number(raw)
  if (!Number.isInteger(seconds) || seconds < 1) {
    refuse(AREA, 'NMC_GPU_WAIT_S', 'must be a positive integer; set it to the maximum GPU client wait in seconds')
  }
  return seconds * 1000
}

function safe(text: string): string {
  return text
    .replace(/((?:token|authorization|bearer)\s*[:=]?\s*)([A-Za-z0-9+/_=-]{16,})/gi, '$1[REDACTED]')
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, '[REDACTED EMAIL]')
}

function stderrTail(stderr: string): string {
  const lines = stderr.split(/\r?\n/).filter(Boolean).slice(-20).map(safe)
  return lines.length ? `\nGPU client stderr (last ${lines.length} lines):\n${lines.join('\n')}` : ''
}

function fail(where: string, what: string): never {
  return refuse(AREA, safe(where), what)
}

async function run(args: string[], where: string): Promise<string> {
  const script = clientPath()
  const timeout = waitMs()
  let stderr = ''
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [script, ...args], { stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let done = false
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      finish(new Error('timeout'))
    }, timeout)
    const finish = (error?: Error): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(stdout)
    }
    child.stdout.setEncoding('utf8').on('data', (s: string) => { stdout += s })
    child.stderr.setEncoding('utf8').on('data', (s: string) => {
      stderr = `${stderr}${s}`.split(/\r?\n/).slice(-20).join('\n')
    })
    child.on('error', () => finish(new Error('launch')))
    child.on('close', code => {
      if (code !== 0) {
        finish(new Error(`exit:${code}`))
        return
      }
      finish()
    })
  }).catch(e => {
    if (isRefusal(e)) throw e
    const reason = e instanceof Error && e.message === 'timeout'
      ? `exceeded ${Math.ceil(timeout / 1000)} seconds; increase NMC_GPU_WAIT_S if the render needs more time`
      : e instanceof Error && e.message.startsWith('exit:')
        ? `exited with status ${e.message.slice(5)}`
        : 'could not start; check that NMC_GPU_CLIENT names an accessible Node script'
    fail(where, `${reason}${stderrTail(stderr)}`)
  })
}

export async function publishDist(dist: string): Promise<string> {
  const stdout = await run(['publish', dist], dist)
  let result: unknown
  try { result = JSON.parse(stdout) as unknown } catch {
    return fail(dist, 'publish returned invalid JSON; check the GPU client response')
  }
  if (typeof result !== 'object' || result === null || !('page_ref' in result) || typeof result.page_ref !== 'string' || result.page_ref.length === 0) {
    return fail(dist, 'publish response has no page_ref; use the GPU client response for the published page')
  }
  return result.page_ref
}

export async function renderOp(op: string, input: unknown, outDir: string, name: string, pageRef: string): Promise<OpResult> {
  if (!/^[A-Za-z0-9_-]{1,80}$/.test(name)) fail(name, 'is not a safe output name; use 1..80 letters, digits, underscore or hyphen')
  if (!/^[A-Za-z][A-Za-z0-9_-]{0,79}$/.test(op)) fail(op, 'is not a valid GPU op name; use the name declared in nmc.gpu.json')
  const inputFile = join(outDir, `${name}.input.json`)
  mkdirSync(outDir, { recursive: true })
  writeFileSync(inputFile, `${JSON.stringify(input, null, 2)}\n`)
  await run([op, inputFile, '--page-ref', pageRef, '-o', outDir], inputFile)
  const resultFile = join(outDir, 'result.json')
  let parsed: unknown
  try {
    parsed = JSON.parse(readFileSync(resultFile, 'utf8')) as unknown
  } catch {
    return fail(resultFile, 'cannot read valid GPU client result JSON; rerun the op and check its output directory')
  }
  if (typeof parsed !== 'object' || parsed === null || !('result' in parsed)) {
    return fail(resultFile, 'result JSON has no result field; pass the unmodified GPU client output')
  }
  return { file: resultFile, json: parsed.result }
}
