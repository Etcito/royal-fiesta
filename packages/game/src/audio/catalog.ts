import { refuse } from '@royal-fiesta/sim/refusal'

export const BUSES = ['music', 'sfx', 'ui', 'ambience', 'crowd'] as const
export type Bus = typeof BUSES[number]
export const SOUND_GROUPS = ['movement', 'world', 'flow', 'music'] as const
export type SoundGroup = typeof SOUND_GROUPS[number]

export const BED_IDS = ['crowd'] as const
export type SoundBedId = typeof BED_IDS[number]

export interface SoundDef {
  /** Event keys use the expanded S16 names, such as move.jump or music.candy.lobby. */
  event: string
  id: string
  kind: 'family' | 'bed'
  group: SoundGroup
  bus: Bus
  mode: 'oneshot' | 'loop'
  variants: number
  spatial: boolean
  source: string
  input: string | null
}

export const WORLDS_AUDIO = ['candy', 'ice', 'jungle', 'neon'] as const
export const MUSIC_CUES = ['lobby', 'hub', 'race', 'survival', 'team', 'final', 'results', 'podium'] as const

function row(
  ids: readonly string[], group: SoundGroup, bus: Bus, mode: SoundDef['mode'],
  variants: number, spatial: boolean, input: string | null = null,
): SoundDef[] {
  return ids.map(id => ({
    event: id, id, kind: 'family', group, bus, mode, variants, spatial, input,
    source: `audio/${id}.${id.startsWith('music.') ? 'arr' : 'haa'}.json`,
  }))
}

/** The S16 event-to-sound table; instrument patches are not sound ids. */
export const SOUNDS: readonly SoundDef[] = [
  ...row([
    'move.step.candy', 'move.step.ice', 'move.step.jungle', 'move.step.neon',
    'move.step.stone', 'move.step.mud', 'move.jump', 'move.land.soft',
    'move.land.hard', 'move.dive',
  ], 'movement', 'sfx', 'oneshot', 8, true),
  ...row(['move.slide'], 'movement', 'sfx', 'loop', 1, true, 'speed'),
  ...row([
    'move.swim', 'move.hit', 'move.stun', 'move.wobble',
    'move.grab', 'move.release', 'move.carry',
  ], 'movement', 'sfx', 'oneshot', 8, true),
  ...row([
    'mech.switch', 'mech.lever', 'mech.door', 'mech.spring', 'mech.hammer',
    'mech.seesaw', 'mech.log', 'mech.tile-warn', 'mech.tile-fall',
    'mech.boost', 'mech.launch', 'mech.door-break',
  ], 'world', 'sfx', 'oneshot', 8, true),
  ...row([
    'mech.motor', 'mech.spinner', 'mech.conveyor', 'mech.laser', 'mech.slime',
  ], 'world', 'sfx', 'loop', 1, true, 'rate'),
  ...row([
    'obj.goal', 'obj.pickup', 'obj.bank', 'obj.capture', 'obj.steal', 'obj.tail', 'obj.crown',
  ], 'world', 'sfx', 'oneshot', 4, true),
  ...row([
    'ui.click', 'ui.hover', 'ui.back', 'ui.error', 'ui.buy', 'ui.ticket', 'ui.inbox',
  ], 'flow', 'ui', 'oneshot', 4, false),
  ...row([
    'flow.vote-tick', 'flow.vote-confirm', 'flow.count-tick', 'flow.count-go',
    'flow.round-start', 'flow.qualify', 'flow.eliminate',
  ], 'flow', 'ui', 'oneshot', 4, false),
  ...row(['flow.elim-drop'], 'flow', 'ui', 'oneshot', 8, false),
  ...row([
    'flow.win', 'flow.crown-gold', 'flow.crown-silver', 'flow.crown-bronze',
  ], 'flow', 'ui', 'oneshot', 4, false),
  ...WORLDS_AUDIO.flatMap(world => MUSIC_CUES.flatMap(cue => row(
    [`music.${world}.${cue}`], 'music', 'music',
    cue === 'results' || cue === 'podium' ? 'oneshot' : 'loop', 1, false,
  ))),
  ...row(WORLDS_AUDIO.map(world => `amb.${world}`), 'music', 'ambience', 'loop', 1, false),
  ...BED_IDS.map((id): SoundDef => ({
    event: id, id, kind: 'bed', group: 'music', bus: 'crowd', mode: 'loop',
    variants: 1, spatial: false, source: `audio/${id}.haa.json`, input: 'excitement',
  })),
]

const BY_ID = new Map(SOUNDS.map(sound => [sound.id, sound]))

export function soundDef(id: string): SoundDef {
  const sound = BY_ID.get(id)
  if (sound === undefined) refuse('audio', 'soundDef', `unknown sound id '${id}'; add it to SOUNDS (S16)`)
  return sound
}

function isWorld(world: string): boolean {
  return WORLDS_AUDIO.some(value => value === world)
}

export function stepSoundId(surface: string, world: string): string {
  if (world !== 'common' && !isWorld(world)) {
    refuse('audio', 'stepSoundId', `unknown world '${world}'`)
  }
  if (surface === 'ice' || surface === 'mud') return `move.step.${surface}`
  return `move.step.${world === 'common' ? 'stone' : world}`
}

export function musicId(world: string, cue: string): string {
  if (!isWorld(world)) refuse('audio', 'musicId', `unknown world '${world}'`)
  if (!MUSIC_CUES.some(value => value === cue)) refuse('audio', 'musicId', `unknown music cue '${cue}'`)
  return `music.${world}.${cue}`
}
