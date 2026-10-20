// Sound ids the game plays. Each one is a family of the Royal Fiesta pack (audio/pack), registered
// by registerRoyalFiesta(); the headless test checks every id here against the registry.
export const FIESTA_SOUNDS = {
  jump: 'fiesta.jump',
  dive: 'fiesta.dive',
  grab: 'fiesta.grab',
  eliminate: 'fiesta.eliminate',
  wobble: 'fiesta.wobble',
} as const

export type FiestaSoundId = typeof FIESTA_SOUNDS[keyof typeof FIESTA_SOUNDS]

/** The continuous crowd bed (a registered bed of the pack). */
export const CROWD_BED_ID = 'crowd'

/** The mix preset the game selects (a registered mix of the pack). */
export const FIESTA_MIX_ID = 'fiesta'
