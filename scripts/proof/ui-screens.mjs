#!/usr/bin/env node
// M6 proof: the twelve Royal Fiesta screens and the round HUD, drawn by uaa.
// Usage: node scripts/proof/ui-screens.mjs [--only assets|screens|evidence|build]
// Prints one PASS/FAIL line per check and exits 1 when any check fails.
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const UI = join(ROOT, 'ui'), NAV = join(ROOT, 'packages/game/src/screens/nav.ts')
const DOC = join(UI, 'screens.ui-doc.json'), FONTS = join(UI, 'fonts.json')
const EVIDENCE = join(ROOT, 'proofs/ui/screens.json'), OUT = join(ROOT, 'out/ui')
const WEB_DIST = join(ROOT, 'apps/web/dist'), ASSET_LIMIT = 262144, BUILD_TIMEOUT = 600000
const FONT_URL = /^https:\/\/assets\.etcito\.com\/objects\//
// uaa widget ids allow no dots, so the HUD prefix is matched as hud. / hud_ / hud-.
const HUD_ID = /^hud(?:[._-].+)?$/
const UAA_FIX = 'make @etcito/uaa resolve and build the uaa sibling (npm run bricks -- fetch uaa, then its npm run build)'

const rel = (file) => relative(ROOT, file) || file
const fail = (file, detail, fix) => new Error(`${rel(file)}: ${detail} (fix: ${fix})`)
const first = (errors) => `${errors.slice(0, 3).join('; ')}${errors.length > 3 ? ` (and ${errors.length - 3} more)` : ''}`

let uaaModule = null
async function uaa() {
  if (uaaModule) return uaaModule
  let mod
  try { mod = await import('@etcito/uaa') } catch (error) { throw fail(join(ROOT, 'package.json'), `@etcito/uaa does not import: ${error.message}`, UAA_FIX) }
  const missing = ['validateUiAsset', 'loadUiAsset', 'loadUiDoc'].filter((name) => typeof mod[name] !== 'function')
  if (missing.length) throw fail(join(ROOT, 'package.json'), `@etcito/uaa exports no ${missing.join('/')}()`, `${UAA_FIX}; use a uaa build with the reader`)
  return (uaaModule = mod)
}

function readJson(file, fix) {
  let text
  try { text = readFileSync(file) } catch (error) { throw fail(file, `cannot be read (${error.code ?? error.message})`, fix) }
  try { return { text, json: JSON.parse(text.toString('utf8')) } } catch (error) { throw fail(file, `is not valid JSON: ${error.message}`, fix) }
}

// The ids of `export const SCREENS = Object.freeze([...])` in nav.ts, from its source.
function screenIds() {
  let source
  try { source = readFileSync(NAV, 'utf8') } catch (error) { throw fail(NAV, `cannot be read (${error.code ?? error.message})`, 'restore the navigation source') }
  const match = source.match(/export\s+const\s+SCREENS\s*=\s*Object\.freeze\s*\(\s*\[([\s\S]*?)\]/)
  const ids = [...(match?.[1] ?? '').matchAll(/(['"])([^'"]+)\1/g)].map((m) => m[2])
  if (!match || !ids.length) throw fail(NAV, 'has no `export const SCREENS = Object.freeze([...])` string array', 'keep the SCREENS export as a frozen string array')
  return ids
}

// Validates every ui/*.ui.json with uaa; returns id -> UiAsset and the problems.
async function collectAssets() {
  const mod = await uaa()
  let names
  try { names = readdirSync(UI).filter((name) => name.endsWith('.ui.json')).sort() } catch (error) { throw fail(UI, `cannot be listed (${error.code ?? error.message})`, 'create ui/ with the UI assets') }
  const assets = new Map()
  const errors = []
  for (const name of names) {
    const file = join(UI, name), id = basename(name, '.ui.json')
    let text, json
    try { ({ text, json } = readJson(file, 'regenerate this asset with the uaa/MAMA writer')) } catch (error) { errors.push(error.message); continue }
    if (text.byteLength > ASSET_LIMIT) errors.push(`${rel(file)}: is ${text.byteLength} bytes, over the ${ASSET_LIMIT}-byte limit (fix: simplify the baked drawing)`)
    const issues = mod.validateUiAsset(json, text.byteLength)
    if (issues.length) {
      const issue = issues[0], more = issues.length > 1 ? ` (+${issues.length - 1} more)` : ''
      errors.push(`${rel(file)}: ${issue.path || '<root>'}: ${issue.message}${more} (fix: correct the field so uaa's validator accepts it)`)
      continue
    }
    if (json && typeof json.id === 'string' && json.id !== id) errors.push(`${rel(file)}: id "${json.id}" does not match the file name (fix: rename the file or the asset id)`)
    try { assets.set(id, mod.loadUiAsset(json, text.byteLength)) } catch (error) { errors.push(`${rel(file)}: uaa could not load the asset: ${error.message} (fix: correct the asset)`) }
  }
  return { names, assets, errors }
}

async function checkAssets() {
  const { names, errors } = await collectAssets()
  const value = readJson(join(UI, 'assets.json'), 'write {"real":[ids],"placeholder":[ids]}').json
  const lists = ['real', 'placeholder'].map((kind) => {
    const list = value && typeof value === 'object' ? value[kind] : undefined
    if (!Array.isArray(list) || list.some((id) => typeof id !== 'string' || !id)) throw fail(join(UI, 'assets.json'), `must list ${kind} asset ids as a string array`, `write {"real":[ids],"placeholder":[ids]} with "${kind}" as an array of ids`)
    return list
  })
  const counts = new Map()
  for (const list of lists) for (const id of list) counts.set(id, (counts.get(id) ?? 0) + 1)
  const files = new Set(names.map((name) => basename(name, '.ui.json')))
  for (const name of names) {
    const count = counts.get(basename(name, '.ui.json')) ?? 0
    if (count !== 1) errors.push(`${rel(join(UI, name))}: appears ${count} times in ui/assets.json (fix: list it exactly once under real or placeholder)`)
  }
  for (const id of counts.keys()) if (!files.has(id)) errors.push(`${rel(join(UI, 'assets.json'))}: lists "${id}" but ui/${id}.ui.json is missing (fix: add the asset file or remove the id)`)
  if (!names.length) errors.push(`${rel(UI)}: has no *.ui.json files (fix: add the UI assets)`)
  if (errors.length) throw new Error(first(errors))
  return `${names.length} assets validate within ${ASSET_LIMIT} B; real=[${lists[0].join(', ')}]; placeholder=[${lists[1].join(', ')}]`
}

function walkWidgets(widgets, visit) {
  for (const widget of Array.isArray(widgets) ? widgets : []) {
    visit(widget)
    walkWidgets(widget.children, visit)
  }
}

async function checkScreens() {
  const mod = await uaa()
  const { assets, errors } = await collectAssets()
  if (errors.length) throw new Error(`ui assets must load before the document: ${first(errors)}`)
  const ids = screenIds()
  const { json } = readJson(DOC, 'write the uaa.ui-doc v1 document with one screen per SCREENS id')
  let doc
  try { doc = mod.loadUiDoc(json, assets) } catch (error) {
    const issue = Array.isArray(error.issues) ? error.issues[0] : null
    throw fail(DOC, `uaa's doc loader rejects it: ${issue ? `${issue.path || '<root>'}: ${issue.message}` : error.message}`, 'correct the document or the asset ids it names')
  }
  const docIds = new Set(doc.screens.map((screen) => screen.id)), missing = ids.filter((id) => !docIds.has(id))
  if (missing.length) throw fail(DOC, `has no screen for SCREENS id(s) ${missing.join(', ')}`, 'add one screen per id from packages/game/src/screens/nav.ts')
  const round = doc.screens.find((screen) => screen.id === 'round'), hud = []
  walkWidgets(round.widgets, (widget) => { if (typeof widget.id === 'string' && HUD_ID.test(widget.id)) hud.push(widget.id) })
  if (!hud.length) throw fail(DOC, "screen 'round' has no hud.* widget", 'give the round HUD widgets ids like hud_timer')
  const used = new Map()
  for (const screen of doc.screens) walkWidgets(screen.widgets, (widget) => {
    if (widget.type === 'label' && widget.font && typeof widget.font.family === 'string') used.set(`${widget.font.family}:${widget.font.weight}`, widget.font)
  })
  const fonts = readJson(FONTS, 'list every label font as {"family","weight","url"}').json?.fonts
  if (!Array.isArray(fonts)) throw fail(FONTS, 'must be {"fonts":[{family,weight,url}]}', 'write the font registry uaa reads')
  const missingFonts = [...used.values()].filter((font) => !fonts.some((entry) => entry && entry.family === font.family && entry.weight === font.weight && typeof entry.url === 'string' && FONT_URL.test(entry.url)))
  if (missingFonts.length) throw fail(FONTS, `does not list ${missingFonts.map((font) => `${font.family} ${font.weight}`).join(', ')} with an ${FONT_URL} URL`, 'add the font family/weight with its asset-store URL')
  return `${ids.length}/${ids.length} SCREENS ids have a screen; round has ${hud.join(', ')}; ${used.size} label font(s) listed with asset URLs`
}

function checkEvidence() {
  const ids = screenIds()
  const { json } = readJson(EVIDENCE, 'record one capture per SCREENS id (12 screens plus the round HUD)')
  const entries = Array.isArray(json) ? json : (json && (json.entries ?? json.captures ?? json.screens))
  if (!Array.isArray(entries)) throw fail(EVIDENCE, 'has no capture entries array', 'write a JSON array or {"entries":[...]} of capture records')
  if (entries.length !== ids.length) throw fail(EVIDENCE, `has ${entries.length} entries, expected ${ids.length} (12 screens plus the round HUD)`, 'record exactly one entry per SCREENS id')
  const seen = new Set()
  let hashed = 0
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') throw fail(EVIDENCE, 'has an entry that is not an object', 'write a capture record object per screen')
    const { screen } = entry
    if (!ids.includes(screen)) throw fail(EVIDENCE, `entry screen ${JSON.stringify(screen)} is not a SCREENS id`, 'set screen to the id the host reported')
    if (seen.has(screen)) throw fail(EVIDENCE, `screen "${screen}" appears twice`, 'record one entry per SCREENS id')
    seen.add(screen)
    if (!Array.isArray(entry.inputs) || !entry.inputs.length) throw fail(EVIDENCE, `entry "${screen}" has no inputs`, 'record the real keys and clicks that reached the screen')
    entry.inputs.forEach((input, index) => {
      const where = `entry "${screen}" input[${index}]`
      if (!input || typeof input !== 'object') throw fail(EVIDENCE, `${where} is not an event object`, 'use {kind:"key",key} or {kind:"click",x,y,target}')
      if (input.kind === 'key') {
        if (typeof input.key !== 'string' || !input.key.trim()) throw fail(EVIDENCE, `${where} is a key event without a key name`, 'add the key name, e.g. {kind:"key",key:"Enter"}')
      } else if (input.kind === 'click') {
        if (!Number.isFinite(input.x) || !Number.isFinite(input.y)) throw fail(EVIDENCE, `${where} is a click without x/y in canvas px`, 'add finite x and y canvas coordinates')
        const target = input.target ?? input.widget ?? input.widgetId ?? input.targetWidget
        if (typeof target !== 'string' || !target) throw fail(EVIDENCE, `${where} is a click without the target widget id`, 'add target: the widget id that was clicked')
      } else throw fail(EVIDENCE, `${where} has kind ${JSON.stringify(input.kind)}`, 'use kind "key" or kind "click"')
    })
    const capture = `out/ui/${screen}.png`
    if (entry.capture !== capture) throw fail(EVIDENCE, `entry "${screen}" capture is ${JSON.stringify(entry.capture)}, expected "${capture}"`, 'write out/ui/<screen>.png')
    if (typeof entry.sha256 !== 'string' || !/^[0-9a-f]{64}$/i.test(entry.sha256)) throw fail(EVIDENCE, `entry "${screen}" sha256 is not 64 hex characters`, 'record the PNG sha256')
    if (!Number.isFinite(entry.width) || entry.width <= 0 || !Number.isFinite(entry.height) || entry.height <= 0) throw fail(EVIDENCE, `entry "${screen}" needs width and height greater than 0`, 'record the capture size in px')
    const png = join(OUT, `${screen}.png`)
    if (existsSync(png)) {
      const hash = createHash('sha256').update(readFileSync(png)).digest('hex')
      if (hash !== entry.sha256.toLowerCase()) throw fail(png, `sha256 ${hash} does not match the entry's ${entry.sha256}`, 're-capture the screen or update the evidence sha256')
      hashed++
    }
  }
  return `${entries.length} captures for 12 screens + the round HUD; ${hashed} local PNG(s) hash-verified`
}

function runBuild() {
  return new Promise((done) => {
    execFile('npm', ['run', 'web:build'], { cwd: ROOT, timeout: BUILD_TIMEOUT, maxBuffer: 64 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => done({ error, stdout, stderr }))
  })
}

function* filesUnder(dir) {
  let entries
  try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) yield* filesUnder(path)
    else yield path
  }
}

async function checkBuild() {
  const { error, stdout, stderr } = await runBuild()
  if (error) {
    const tail = (stderr || stdout).trim().split('\n').slice(-6).join(' | ')
    const why = error.killed || error.signal ? `timed out after ${BUILD_TIMEOUT / 1000}s` : `exit ${error.code ?? error.message}`
    throw fail(join(ROOT, 'package.json'), `\`npm run web:build\` ${why}${tail ? `: ${tail}` : ''}`, 'make the web build pass')
  }
  const html = join(WEB_DIST, 'game.html')
  if (!existsSync(html)) throw fail(html, 'is missing after the build', 'make the Vite build emit apps/web/dist/game.html')
  let bundle = null
  for (const file of filesUnder(WEB_DIST)) {
    if (!/\.(m?js)$/.test(file)) continue
    if (readFileSync(file, 'utf8').includes('GPU_UNAVAILABLE')) { bundle = file; break }
  }
  if (!bundle) throw fail(WEB_DIST, 'has no JS bundle containing the uaa WebGPU renderer string GPU_UNAVAILABLE', 'import and use @etcito/uaa/webgpu from the web app so uaa is bundled')
  return `npm run web:build exited 0; apps/web/dist/game.html present; ${rel(bundle)} contains GPU_UNAVAILABLE`
}

const CHECKS = { assets: checkAssets, screens: checkScreens, evidence: checkEvidence, build: checkBuild }
const FILES = {
  assets: 'ui/*.ui.json, ui/assets.json',
  screens: 'ui/screens.ui-doc.json, ui/fonts.json, packages/game/src/screens/nav.ts',
  evidence: 'proofs/ui/screens.json',
  build: 'apps/web/dist (npm run web:build)',
}
const FIXES = {
  assets: 'make every asset validate with uaa and list it once in ui/assets.json',
  screens: 'make the uaa.ui-doc load with one screen per SCREENS id and register every label font',
  evidence: 'capture 12 screens plus the round HUD with real inputs',
  build: 'make npm run web:build emit game.html with the uaa WebGPU bundle',
}

function selectedChecks() {
  const args = process.argv.slice(2)
  let only = null
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--only' && i + 1 < args.length) only = args[++i]
    else if (arg.startsWith('--only=')) only = arg.slice('--only='.length)
    else {
      console.error(`Unknown argument "${arg}" (usage: node scripts/proof/ui-screens.mjs [--only ${Object.keys(CHECKS).join('|')}])`)
      process.exit(2)
    }
  }
  if (only !== null && !Object.hasOwn(CHECKS, only)) {
    console.error(`Unknown check "${only}" (checks: ${Object.keys(CHECKS).join(', ')})`)
    process.exit(2)
  }
  return only === null ? Object.keys(CHECKS) : [only]
}

let failed = false
for (const name of selectedChecks()) {
  try {
    console.log(`PASS ${name}: ${await CHECKS[name]()}`)
  } catch (error) {
    failed = true
    const message = error instanceof Error ? error.message : String(error)
    const named = message.includes('(fix: ')
    console.log(`FAIL ${name}: ${named ? message : `${message} (file: ${FILES[name]}; fix: ${FIXES[name]})`}`)
  }
}
process.exitCode = failed ? 1 : 0
