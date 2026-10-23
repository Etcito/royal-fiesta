import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// Runs the judge client on every view of one subject; one command per subject keeps the card list within its 10-command cap.
function main(argv: string[]): number {
  const [judge, inputPath, subject] = argv
  if (!judge || !inputPath || !subject) {
    console.error('usage: judgeViews.ts <judge client> <judge.input.json> <subject>')
    return 1
  }
  const input = JSON.parse(readFileSync(inputPath, 'utf8'))
  const s = input.subjects.find((x: { name: string }) => x.name === subject)
  if (!s) {
    console.error(`[judge] ${inputPath}: no subject '${subject}'; use a name listed in the file`)
    return 1
  }
  let failed = 0
  for (const v of s.views as { png: string; description: string }[]) {
    if (!existsSync(v.png)) {
      console.error(`[judge] ${v.png}: missing; render the views with SDF Modeler and re-run tools/viewsRecord.ts`)
      failed++
      continue
    }
    const r = spawnSync('python3', [judge, v.png, '--description', v.description, '--reference', input.reference, '--min-score', String(input.minScore)], { stdio: 'inherit' })
    console.log(`[judge] ${v.png} exit=${r.status}`)
    if (r.status !== 0) failed++
  }
  return failed === 0 ? 0 : 1
}

process.exit(main(process.argv.slice(2)))
