import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'

function files(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const file = join(dir, name)
    return statSync(file).isDirectory() ? files(file) : [file]
  })
}

// Run against the actual artifacts, including when RF_PLAY_DEV=1 is in the build
// environment. A dev URL or externalized brick must never reach a static upload.
export function checkWebBuild(directory: string, upload = false): { files: number; wasm: string[] } {
  const root = resolve(directory)
  for (const page of ['index.html', 'game.html']) assert.ok(existsSync(join(root, page)), `missing ${page} in ${directory}`)
  const all = files(root)
  const wasm = all.filter(file => file.endsWith('.wasm')).map(file => relative(root, file)).sort()
  for (const name of ['raa_js_bg', 'raa_anim_js_bg', 'manifold', 'highs']) {
    assert.ok(wasm.some(file => file.split('/').at(-1)?.startsWith(name + '-') && statSync(join(root, file)).size > 0), `missing ${name} wasm in ${directory}`)
  }
  if (upload) {
    const stamp = JSON.parse(readFileSync(join(root, 'rf-build.json'), 'utf8'))
    assert.equal(stamp.format, 'royal-fiesta.build')
    assert.equal(stamp.version, 1)
    assert.equal(stamp.entry, 'game.html')
    assert.equal(typeof stamp.builtAt, 'string')
    assert.notEqual(stamp.builtAt, 'dev')
  }
  const imports = new Map<string, string[]>()
  const entryModules: string[] = []
  const checkReference = (from: string, spec: string, mustExist: boolean): string | undefined => {
    assert.ok(!/^(?:file:|\/@(?:fs|id|vite)\/)|node_modules\/\.vite\//.test(spec), `${from}: dev reference ${spec}`)
    if (/^(?:https?:|data:|blob:)/.test(spec)) return
    const target = resolve(dirname(from), decodeURIComponent(spec.split(/[?#]/)[0]))
    assert.ok(target.startsWith(root + sep), `${from}: reference outside dist: ${spec}`)
    if (mustExist) assert.ok(existsSync(target), `${from}: missing bundled import ${spec}`)
    return target
  }
  for (const file of all) {
    if (file.endsWith('.html')) {
      const html = readFileSync(file, 'utf8')
      assert.doesNotMatch(html, /\/@(?:fs|id|vite)\//, `${file}: dev HTML`)
      for (const tag of html.matchAll(/<(?:script|link)\b[^>]*>/g)) {
        const src = /\b(?:src|href)=["']([^"']+)["']/.exec(tag[0])
        if (src) {
          const target = checkReference(file, src[1], true)
          if (target) entryModules.push(target)
        }
      }
    }
    if (!/\.(?:m?js)$/.test(file)) continue
    const references: string[] = []
    imports.set(file, references)
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, false, ts.ScriptKind.JS)
    const visit = (node: ts.Node): void => {
      if (ts.isStringLiteralLike(node)) {
        assert.ok(!/^(?:\/@(?:fs|id|vite)\/|file:\/+[^/])|node_modules\/\.vite\//.test(node.text), `${file}: dev module URL ${node.text}`)
      }
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteralLike(node.moduleSpecifier)) {
        assert.match(node.moduleSpecifier.text, /^\.?\.?\//, `${file}: externalized import ${node.moduleSpecifier.text}`)
        checkReference(file, node.moduleSpecifier.text, false)
        references.push(node.moduleSpecifier.text)
      }
      if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) {
        const spec = node.arguments[0].text
        // Emscripten retains a Node-only branch in its browser glue.
        if (!spec.startsWith('node:')) {
          assert.match(spec, /^(?:\.?\.?\/|https?:)/, `${file}: externalized dynamic import ${spec}`)
          checkReference(file, spec, false)
          references.push(spec)
        }
      }
      if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'URL' && node.arguments?.[0] && ts.isStringLiteralLike(node.arguments[0]) && node.arguments[1]?.getText(source) === 'import.meta.url') {
        // Some wasm glue keeps an unused default filename; validate containment,
        // while the named wasm inventory above checks the shipped binaries.
        checkReference(file, node.arguments[0].text, false)
      }
      ts.forEachChild(node, visit)
    }
    visit(source)
  }
  // Asset globs also copy unused upstream worker templates. Require existing
  // targets for the module graph reached from HTML; check containment everywhere.
  const visited = new Set<string>()
  for (const file of entryModules) {
    if (visited.has(file)) continue
    visited.add(file)
    for (const spec of imports.get(file) ?? []) {
      const target = checkReference(file, spec, true)
      if (target) entryModules.push(target)
    }
  }
  return { files: all.length, wasm }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  for (const [dir, upload] of [['apps/web/dist', false], ['out/wavedash-build/upload', true]] as const) {
    console.log(`${dir}: ${JSON.stringify(checkWebBuild(dir, upload))}`)
  }
}
