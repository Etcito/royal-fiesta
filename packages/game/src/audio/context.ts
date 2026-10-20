// The only module of the game that touches the Web Audio API. tools/test/audio-boundary.test.ts
// fails if AudioContext or `new Audio(` appears anywhere else in the sources.
import { createAudio, type HaaAudio } from '@etcito/haa'
import { registerRoyalFiesta } from './pack/index.ts'
import { FIESTA_MIX_ID } from './ids.ts'

export interface BrowserAudioOptions {
  /** HAA's bake manifest (audio/manifest.json, written by the HAA bake) or the URL of the same. */
  manifestUrl: string
  /** The prebuilt HAA worklet bundle (@etcito/haa/worklet, served as a static file). */
  processorUrl: string
  /** Listener count of the spatial model: 1 for the local player's view. */
  maxListeners?: 1 | 2 | 3 | 4
}

/**
 * Creates the HAA engine on a fresh AudioContext with the Royal Fiesta pack and mix. Call it from
 * a user gesture: browsers start an AudioContext suspended otherwise.
 */
export async function openBrowserAudio(o: BrowserAudioOptions): Promise<HaaAudio> {
  registerRoyalFiesta()
  const ctx = new AudioContext()
  const audio = await createAudio(ctx, {
    manifestUrl: o.manifestUrl,
    processorUrl: o.processorUrl,
    mix: FIESTA_MIX_ID,
    maxListeners: o.maxListeners ?? 1,
  })
  await audio.ready()
  return audio
}
