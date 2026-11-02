// Register the checks before loading the game and its potentially failing dependencies.
// Calls wait for the real implementation, so failures surface through the GPU client.
const names = ['countdowns', 'lobbyUnload', 'wardrobe', 'vote'] as const
const ops: Record<string, (input: unknown) => Promise<unknown>> = {}
let game: Promise<unknown>
for (const name of names) {
  ops[name] = async input => {
    await game
    const implementation = (window.nmcGpu!.ops as unknown as typeof ops)[name]
    if (implementation === ops[name]) throw new Error(`Game did not register ${name}`)
    return implementation(input)
  }
}
window.nmcGpu = { ops } as unknown as NonNullable<Window['nmcGpu']>
game = import('./main.ts')
void game.catch(error => console.error('[game entry] failed to load:', error))
