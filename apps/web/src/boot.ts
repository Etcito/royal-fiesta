import { initRapier } from '@gamesaloon/rollback-rapier'
import { createFlatFloorWorld, flatFloorScript } from '@royal-fiesta/sim/scenarios/flatFloor'

declare global {
  interface Window {
    rfBoot?: { ticks: number; hash: number }
  }
}

export {}

function hex8(value: number): string {
  return (value >>> 0).toString(16).padStart(8, '0')
}

async function boot(): Promise<void> {
  const output = document.querySelector<HTMLPreElement>('#boot')
  try {
    const R = await initRapier()
    const world = createFlatFloorWorld(R, { players: 8, seed: 7 })
    for (let tick = 0; tick < 600; tick++) {
      const inputs = new Array<number>(8)
      for (let player = 0; player < 8; player++) inputs[player] = flatFloorScript(7, player, world.tick)
      world.step(inputs)
    }
    const hash = world.stateHash() >>> 0
    if (output !== null) output.textContent = `royal-fiesta boot ticks=600 hash=${hex8(hash)}`
    window.rfBoot = { ticks: 600, hash }
    world.free()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (output !== null) output.textContent = `royal-fiesta boot FAIL ${message}`
  }
}

void boot()
