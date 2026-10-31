export const ROUND_KINDS = ['race', 'survival', 'team', 'collection', 'hunt', 'logic', 'final'] as const
export type RoundKind = typeof ROUND_KINDS[number]
export const STAGE_IDS = ['R1', 'R2', 'R3', 'R4', 'final'] as const
export type StageId = typeof STAGE_IDS[number]
export type FinalRule = 'crown' | 'lastStanding'
export const SEASON_SEATS = 60
