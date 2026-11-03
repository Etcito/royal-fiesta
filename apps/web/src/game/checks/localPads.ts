import type { TourDeps, TourGame } from '../uiTour.ts'
import { yieldTask } from './boot.ts'
import { capture, pipelinesReady } from './wardrobe.ts'

export const name = 'localPads'
type Character = { pos: { x: number; y: number; z: number }; vel: { y: number }; mode: number }
type Local = { seats: { device: string }[]; characters: Character[]; cameras: { target: number[] }[] }
export async function run(_input: unknown, deps: TourDeps) {
  const files: { name: string; blob: Blob }[] = []
  const cases: unknown[] = []
  const original = Object.getOwnPropertyDescriptor(navigator, 'getGamepads')
  let pads: Gamepad[] = []
  Object.defineProperty(navigator, 'getGamepads', { configurable: true, value: () => pads })
  const pad = (index: number) => ({ index, id: `test-standard-${index}`, connected: true, mapping: 'standard', axes: [0, 0, 0, 0], buttons: Array.from({ length: 17 }, () => ({ pressed: false, touched: false, value: 0 })), timestamp: 0 }) as unknown as Gamepad
  const axis = (p: Gamepad, x: number) => { (p.axes as number[])[0] = x }
  const button = (p: Gamepad, i: number, pressed: boolean) => Object.assign(p.buttons[i], { pressed, touched: pressed, value: pressed ? 1 : 0 })
  let game: TourGame | undefined
  try {
    for (const { count, bots } of [{ count: 1, bots: false }, { count: 2, bots: false }, { count: 4, bots: false }, { count: 2, bots: true }]) {
      pads = []
      const search = `?course=s1-c1-diamond-citadel${count === 1 ? '' : `&players=${count}`}${bots ? '&bots=8&test=1' : ''}`
      game = await deps.boot(() => {}, { search })
      const live = game
      const step = async (n = 1) => { for (let k = 0; k < n; k++) { live.step(1 / 60); await yieldTask(live.host.currentScreen()) } }
      const end = Date.now() + 180000
      while (live.host.currentScreen() !== 'round') {
        if (live.host.currentScreen() === 'error' || Date.now() > end) throw new Error(`course boot ${count}: ${live.host.currentScreen()}`)
        await step()
      }
      await pipelinesReady(live, `players-${count}`)
      const local = () => (live.inventory() as { local: Local }).local
      const beforeDevices = local()
      if (count === 1 && beforeDevices.seats.length !== 0) throw new Error('P1 was forced before activity')
      if (count > 1 && beforeDevices.seats.length !== count) throw new Error('URL seats not reserved')
      pads = Array.from({ length: count }, (_, i) => pad(i))
      for (let i = 0; i < count; i++) axis(pads[i], i % 2 === 0 ? -0.9 : 0.9)
      await step(5)
      const before = local()
      if (before.seats.length !== count || before.seats.some((s, k) => s.device !== `pad:${k}`)) throw new Error('pad seats incorrect')
      await step(30)
      const moved = local()
      if (moved.cameras.length !== count) throw new Error('wrong viewport count')
      for (let k = 0; k < count; k++) {
        const target = moved.cameras[k].target, focus = moved.characters[k].pos
        if (Math.hypot(target[0] - focus.x, target[2] - focus.z) > 2.5) throw new Error(`camera ${k} does not follow player ${k}`)
        const a = before.characters[k].pos, b = moved.characters[k].pos
        if (Math.hypot(a.x - b.x, a.z - b.z) < 0.1) throw new Error(`pad ${k} did not move player ${k}`)
        axis(pads[k], 0)
      }
      button(pads[0], 0, true)
      await step(2)
      const jumped = local()
      if (jumped.characters[0].vel.y <= 0) throw new Error('A did not jump')
      button(pads[0], 0, false)
      button(pads[0], 1, true)
      await step(2)
      const dived = local()
      if (dived.characters[0].mode === jumped.characters[0].mode) throw new Error('B did not dive')
      button(pads[0], 1, false)
      live.step(0)
      files.push({ name: `players-${count}${bots ? '-bots' : ''}.png`, blob: (await capture(live)).composite })
      cases.push({ count, bots, search, beforeDevices, before, moved, jumped, dived })
      live.dispose(); game = undefined
    }
    return { json: { ok: true, cases, adapter: await deps.adapter() }, files }
  } catch (error) {
    return { json: { ok: false, error: String(error), cases, inventory: game?.inventory(), adapter: await deps.adapter() }, files }
  } finally {
    game?.dispose()
    if (original) Object.defineProperty(navigator, 'getGamepads', original)
    else Reflect.deleteProperty(navigator, 'getGamepads')
  }
}
