import { tick } from 'ege'
import { characterColumn } from '../lib/seats.as'
import { MODE_GRABBING } from './constants.as'
import { bumpFromContacts } from './bump.as'
import { holdLever, releaseGrab } from './grab.as'

export function rf_character_post(): void {
  const characters = characterColumn()
  for (let i: u32 = 0; i < characters.count; i++) {
    const entity = characters.entity(i)
    const ch = characters.at(i)
    if (ch.parked != 0) continue
    bumpFromContacts(entity, ch)
    if (ch.grab_lever >= 0) {
      if (ch.mode == MODE_GRABBING) holdLever(entity, ch)
      else releaseGrab(entity, ch)
    }
  }
  characters.write()
}
