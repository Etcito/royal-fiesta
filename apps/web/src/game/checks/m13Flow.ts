// The whole M13 flow in one GPU job: each flow runs after the previous one, a failure is recorded and the
// next flow still runs, so a single pass lists every failure. The copied page adds page errors, console
// errors and failed requests of the whole pass to this json.
import type { TourDeps } from '../uiTour.ts'
import * as countdowns from './countdowns.ts'
import * as lobbyUnload from './lobbyUnload.ts'
import * as vote from './vote.ts'
import * as wardrobe from './wardrobe.ts'

export const name = 'm13Flow'
type Outcome = { json: unknown; files: { name: string; blob: Blob }[] }
const FLOWS: { name: string; run: (input: unknown, deps: TourDeps) => Promise<Outcome> }[] = [lobbyUnload, wardrobe, countdowns, vote]

export async function run(input: unknown, deps: TourDeps): Promise<{ json: { ok: boolean; flows: Record<string, unknown>; failures: string[] }; files: { name: string; blob: Blob }[] }> {
  const flows: Record<string, unknown> = {}
  const failures: string[] = []
  const files: { name: string; blob: Blob }[] = []
  for (const flow of FLOWS) {
    try {
      const result = await flow.run(input, deps)
      flows[flow.name] = result.json
      for (const file of result.files) files.push({ name: `${flow.name}/${file.name}`, blob: file.blob })
      const ok = (result.json as { ok?: unknown } | null)?.ok
      if (ok === false) failures.push(`${flow.name}: reported ok=false`)
    } catch (error) {
      const message = error instanceof Error ? error.stack ?? error.message : String(error)
      flows[flow.name] = { ok: false, error: message }
      failures.push(`${flow.name}: ${message}`)
    }
  }
  return { json: { ok: failures.length === 0, flows, failures }, files }
}
