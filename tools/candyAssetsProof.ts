// Run on the programmatic card: dedicated views of this task's two assets, independent of m2's
// course capture. The normal web build already includes candy-assets.html (all HTML entries).
import { spawn } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot } from './bricks.ts'
import { pageRefOf } from './judgeCard.ts'
import { writeProofLog } from './proofLog.ts'

const root = repoRoot()
const page = join(root, 'out/candy-assets-page')
const proof = join(root, 'proofs/m2/candy-assets')
const shots = join(root, 'out/m2/candy-assets')
const inputDir = join(root, 'out/candy-assets-inputs')

// Each individual step is bounded. The card runner owns the longer, sequential workflow.
async function run(command: string, args: string[], label: string, timeout = 60000): Promise<string> {
  console.log(`[candy-assets] ${label}`)
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, timeout, stdio: ['ignore', 'pipe', 'pipe'] })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); process.stdout.write(b) })
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); process.stderr.write(b) })
    child.once('error', reject)
    child.once('close', code => {
      writeProofLog(join(proof, `${label}.txt`), stdout + stderr, root)
      if (code !== 0) reject(new Error(`${label} exited ${code}; see proofs/m2/candy-assets/${label}.txt`))
      else resolve(stdout)
    })
  })
}

async function main(): Promise<void> {
  const gpu = process.env.NMC_GPU_CLIENT
  const judge = process.env.NMC_JUDGE_CLIENT
  if (!gpu || !judge) throw new Error('Run on the programmatic card with NMC_GPU_CLIENT and NMC_JUDGE_CLIENT')
  mkdirSync(proof, { recursive: true })
  mkdirSync(shots, { recursive: true })
  // A re-run of this one command (programmatic retry, fix-card quick check) does not run sdf-port-build first.
  if (!existsSync(join(root, 'apps/web/dist/candy-assets.html'))) await run('npm', ['run', 'build'], 'web-build', 600000)
  if (!existsSync(join(root, 'apps/web/dist/candy-assets.html'))) {
    throw new Error('npm run build did not produce apps/web/dist/candy-assets.html')
  }
  mkdirSync(inputDir, { recursive: true })
  // Keep the retained course pack check unchanged and publish those exact validated content inputs.
  await run('npm', ['run', 'content:pack', '--', '/tmp/rf-pack-mechlab'], 'mechlab-content-pack')
  cpSync(join(root, 'apps/web/dist'), page, { recursive: true })
  cpSync('/tmp/rf-pack-mechlab', join(page, 'content'), { recursive: true })
  writeFileSync(join(page, 'nmc.gpu.json'), JSON.stringify({ page: 'candy-assets.html', ops: ['candyAssets'] }) + '\n')
  const ref = pageRefOf(await run('node', [gpu, 'publish', page], 'publish'))
  const captures = [
    { label: 'blank-probe', input: { probe: true }, dir: join(root, 'out/candy-assets-probe') },
    { label: 'one-asset-probe', input: { firstAsset: true, width: 320, height: 240 }, dir: join(root, 'out/candy-assets-one') },
    { label: 'asset-views', input: { width: 1280, height: 960 }, dir: shots },
  ]
  for (const c of captures) {
    const inputPath = join(inputDir, `${c.label}.json`)
    writeFileSync(inputPath, JSON.stringify(c.input) + '\n')
    await run('node', [gpu, 'candyAssets', inputPath, '--page-ref', ref, '-o', c.dir], c.label)
  }
  const descriptions = [
    ['candy.mech-seesaw-rest', 'An isolated bright candy seesaw: a long rounded pink plank with a lemon yellow top and mint stripes, supported by a mint pivot block on a sky blue foot with yellow axle caps. The whole six metre plank and its base are visible, with no missing or black geometry.'],
    ['candy.mech-seesaw-limit', 'An isolated bright candy seesaw with its long rounded pink, lemon yellow and mint striped plank visibly tilted about its centre, while its mint pivot block and sky blue foot remain upright. The whole plank and base are visible, with no missing or black geometry.'],
    ['candy.mech-plate-rest', 'An isolated square candy pressure plate: a rounded pink inset platform with two mint panels and a lemon yellow centre stripe, inside a square frame with sky blue sides and pink ends. The inset and frame have a flush top at rest. All parts are visible and brightly coloured, with no missing or black geometry.'],
    ['candy.mech-plate-limit', 'An isolated square candy pressure plate with its pink platform, mint panels and lemon yellow centre stripe pressed slightly below its surrounding sky blue and pink fixed frame. The square platform and frame remain intact, with no missing or black geometry.'],
  ]
  for (const [name, description] of descriptions) {
    await run('python3', [judge, join(shots, `${name}.png`), '--description', description, '--min-score', '6'], `judge-${name}`)
  }
  console.log('[candy-assets] four dedicated asset views passed; PNGs and result.json in out/m2/candy-assets/, text logs in proofs/m2/candy-assets/')
}

await main()
