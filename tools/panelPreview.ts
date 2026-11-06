import { rmSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { repoRoot } from './bricks.ts'
import { main, previewFile } from './uiPreview.ts'

const path = previewFile(repoRoot(), 'panel.card', 'normal')

try {
  if (process.argv.length !== 3 || resolve(process.argv[2]!) !== path) {
    throw new Error('usage: node --experimental-strip-types tools/panelPreview.ts out/ui-preview/panel.card.normal.png')
  }
  rmSync(path, { force: true })
  const status = await main(['panel.card', 'normal'])
  if (status !== 0) process.exitCode = status
  else if (!statSync(path).isFile() || statSync(path).size === 0) {
    throw new Error(`preview is missing or empty: ${path}`)
  }
} catch (error) {
  console.error(`panelPreview: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
}
