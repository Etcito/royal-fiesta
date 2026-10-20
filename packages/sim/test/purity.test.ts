import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, relative, sep } from 'node:path'
import test from 'node:test'

const forbidden = /Math\.(?:sin|cos|tan|asin|acos|atan|atan2|sinh|cosh|tanh|pow|exp|expm1|log|log2|log10|log1p|hypot|cbrt|fround|random)\b|\b(?:Date|performance|setTimeout|setInterval|crypto)\b|for\s*\(\s*(?:const|let|var)\s+\w+\s+in\s/g

export interface PurityHit {
  line: number
  token: string
}

export function scanSource(source: string): PurityHit[] {
  const uncommented = source
    .replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '))
    .replace(/\/\/[^\n]*/g, (comment) => comment.replace(/[^\n]/g, ' '))
  const hits: PurityHit[] = []
  forbidden.lastIndex = 0
  for (let match = forbidden.exec(uncommented); match; match = forbidden.exec(uncommented)) {
    const line = uncommented.slice(0, match.index).split('\n').length
    hits.push({ line, token: match[0] })
  }
  return hits
}

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true })
  const nested = await Promise.all(entries.map(async (entry) => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return sourceFiles(path)
    return entry.isFile() && entry.name.endsWith('.ts') ? [path] : []
  }))
  return nested.flat()
}

test('sim source contains no nondeterministic operations', async () => {
  const testDir = dirname(fileURLToPath(import.meta.url))
  const srcDir = `${testDir}/../src`
  const files = await sourceFiles(srcDir)
  const failures: string[] = []
  for (const file of files) {
    const contents = await readFile(file, 'utf8')
    for (const hit of scanSource(contents)) {
      const path = relative(dirname(testDir), file).split(sep).join('/')
      failures.push(`${path}:${hit.line}: ${hit.token}`)
    }
  }
  assert.deepEqual(failures, [], `Forbidden tokens found:\n${failures.join('\n')}`)
})

test('scanner reports forbidden code and ignores comments', () => {
  const hits = scanSource('// Math.sin is only mentioned here\nMath.sin(x)\nfor (const k in o) {}')
  assert.deepEqual(hits.map((hit) => hit.token), ['Math.sin', 'for (const k in '])
})
