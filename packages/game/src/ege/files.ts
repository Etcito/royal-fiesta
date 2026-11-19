import { MAX_PLAYERS } from '@royal-fiesta/sim/world'

// E1: fixed values of the engine round, shared by the emitter, the round runtime and the page.
export const RF_EGE_SCHEMA = 'ege.schema.json'
export const RF_EGE_SCRIPTS = 'scripts/ege'
export const RF_EGE_WORLD_KIND = 'round'
// Seats of the engine round: the sim's player cap, so both sides agree on the count.
export const RF_EGE_SEATS = MAX_PLAYERS
// Compiled script module, relative to the page.
export const RF_EGE_SCRIPTS_URL = 'ege/rf-scripts.wasm'
