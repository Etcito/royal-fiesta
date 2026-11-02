// Register every page op (public/nmc.gpu.json plus the checks) before loading the game and its potentially
// failing dependencies: scripts that run at DOMContentLoaded (animBrick, a render transport) find them, and
// calls wait for the real implementation, so failures surface through the GPU client.
const names = [
  'controlsProbe', 'gameCapture', 'roundCapture', 'uiTour', 'flowTour', 'zoneCapture', 'zoneLobbyCapture',
  'zoneLobbyPair', 'zoneSplitPair', 'countdowns', 'lobbyUnload', 'wardrobe', 'vote', 'm13Flow', 'shopEconomy', 'startPlain', 'cameraLook',
] as const
const ops: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
let game: Promise<unknown>
for (const name of names) {
  ops[name] = async (...args) => {
    const page = window as Window & { __nmcCheck?: Record<string, unknown>; __nmcGpuProgress?: string }
    const check = page.__nmcCheck ??= {}
    check.phase = `${name}: entry`
    check.lastAwaitedStep = 'game module import'
    page.__nmcGpuProgress = `${check.phase}; awaiting: game module import`
    await game
    const implementation = (window.nmcGpu!.ops as unknown as typeof ops)[name]
    if (implementation === ops[name]) throw new Error(`Game did not register ${name}`)
    return implementation(...args)
  }
  // Marked so the game's installs replace it instead of seeing a duplicate op.
  Object.assign(ops[name], { pending: true })
}
window.nmcGpu = { ops } as unknown as NonNullable<Window['nmcGpu']>
game = import('./main.ts')
void game.catch(error => console.error('[game entry] failed to load:', error))
