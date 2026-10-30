// Run one full 60-seat zone match (15 peers x 4 local seats) against the local relay.
// The programmatic card owns the real run; this tool only launches and logs it.
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createInterface } from 'node:readline'
import { isRefusal } from '@royal-fiesta/sim/refusal'
import { repoRoot } from './bricks.ts'
import { startZoneGateRelay } from './zoneGateRelay.ts'
import type { ZoneGateRelay } from './zoneGateRelay.ts'

// A small helper reads NMC_CPUS, but this is not a sweep: all 15 peers belong to ONE match and
// must run concurrently, so the sandbox CPU cap does not apply here.
async function main(): Promise<number> {
  // The gate checks netcode and domains only: it plays the dedicated flat test courses, never the shipped levels.
  process.env.ZONE_COURSES_DIR ??= 'fixtures/test-courses'
  const root = repoRoot()
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const lines: string[] = []
  let relay: ZoneGateRelay | undefined
  let code = 1
  try {
    relay = await startZoneGateRelay()
    // Only the loopback URL: the relay's expose() route belongs to the GPU cards.
    const args = [
      'run', 'zone:bots', '--',
      '--relay', relay.localUrl,
      '--match', 'full',
      '--peers', '15',
      '--seats', '4',
      '--players', '15',
      '--course', 'test-flat-race',
      '--seconds', '1800',
    ]
    code = await new Promise<number>((resolveExit, reject) => {
      const child = spawn(npm, args, { cwd: root, shell: false, stdio: ['ignore', 'pipe', 'pipe'] })
      const collect = (write: (text: string) => void) => (line: string): void => {
        lines.push(line)
        write(`${line}\n`)
      }
      createInterface({ input: child.stdout!, crlfDelay: Infinity })
        .on('line', collect(text => process.stdout.write(text)))
      createInterface({ input: child.stderr!, crlfDelay: Infinity })
        .on('line', collect(text => process.stderr.write(text)))
      child.once('error', reject)
      child.once('close', exit => resolveExit(exit ?? 1))
    })
  } catch (error) {
    console.error(isRefusal(error) ? error.message : String(error))
    code = 1
  } finally {
    try { await relay?.stop() } catch (error) {
      console.error(`zone-60-run: relay stop failed: ${error instanceof Error ? error.message : String(error)}`)
      if (code === 0) code = 1
    }
    try {
      mkdirSync(join(root, 'out', 'm7'), { recursive: true })
      const body = [...(relay?.logs ?? []), ...lines]
      writeFileSync(join(root, 'out', 'm7', 'zone-60.log'), body.map(line => `${line}\n`).join(''))
    } catch (error) {
      console.error(`zone-60-run: cannot write out/m7/zone-60.log: ${error instanceof Error ? error.message : String(error)}`)
      if (code === 0) code = 1
    }
  }
  // The launcher's own report is the gate: exit 0 only when it saw the full match pass.
  const ok = lines.some(line => line.startsWith('[zone-launch] full match OK'))
  if (code !== 0) return code
  return ok ? 0 : 1
}

process.exitCode = await main()
