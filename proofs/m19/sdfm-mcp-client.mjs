// Dispatcher client for task 5617: spawns the SDF Modeler CLI's stdio MCP server (`mcp` command, one shared session) and
// invokes registered tools in order through tools/list + tools/call. It never imports or calls an authoring function itself.
// usage: node sdfm-mcp-client.mjs <steps.json> <transcript.jsonl>   (steps = [{tool, input}], tool "@list" lists the tools)
import { spawn } from 'node:child_process'
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'

const [stepsFile, transcript] = process.argv.slice(2)
const steps = JSON.parse(readFileSync(stepsFile, 'utf8'))
const cli = process.env.SDFM_CLI ?? '/tmp/env/sdfm-cli.mjs'
const child = spawn(process.execPath, [cli, 'mcp'], { stdio: ['pipe', 'pipe', 'inherit'], env: process.env })
const rl = createInterface({ input: child.stdout })
const waiting = new Map()
rl.on('line', (line) => {
  let m
  try { m = JSON.parse(line) } catch { return }
  if (m.id !== undefined && waiting.has(m.id)) { waiting.get(m.id)(m); waiting.delete(m.id) }
})
let nextId = 1
const rpc = (method, params) => new Promise((res) => {
  const id = nextId++
  waiting.set(id, res)
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
})
const log = (o) => appendFileSync(transcript, JSON.stringify(o) + '\n')
writeFileSync(transcript, '')

const init = await rpc('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'rf-5617-client', version: '1' } })
log({ step: 'initialize', result: init.result ?? init.error })
child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n')
let failed = 0
for (const s of steps) {
  if (s.tool === '@list') {
    const r = await rpc('tools/list', {})
    const names = (r.result?.tools ?? []).map((t) => t.name)
    log({ step: 'tools/list', count: names.length, anim: names.filter((n) => /^anim_(clip|key|preview|auto)/.test(n)) })
    continue
  }
  const r = await rpc('tools/call', { name: s.tool, arguments: s.input ?? {} })
  const text = (r.result?.content ?? []).map((c) => c.text).join('\n')
  const isError = Boolean(r.error || r.result?.isError)
  if (isError) failed++
  log({ tool: s.tool, input: s.input ?? {}, isError, text: text.slice(0, 1500), structured: s.keep ? r.result?.structuredContent : undefined, error: r.error })
  if (isError && !s.allowError) { console.error(`FAILED ${s.tool}: ${text || JSON.stringify(r.error)}`); break }
}
child.stdin.end()
child.kill()
process.exit(failed ? 1 : 0)
