import { refuse } from '@royal-fiesta/sim/refusal'

export const RAA_ABSENT = true
export const RAA_API_VERSION = null

function absent(symbol: string): (...args: unknown[]) => never {
  return () => refuse('render', 'raa', `RAA API v0 not found (no RAA checkout: set RAA_DIR); ${symbol} is unavailable, see docs/brick-gaps.md`)
}

export const createEngine = absent('createEngine')
export const loadMeshFromPrims = absent('loadMeshFromPrims')
export const setInstanceColor = absent('setInstanceColor')
export const setCamera = absent('setCamera')
export const setViewport = absent('setViewport')
export const renderFrame = absent('renderFrame')
export const readback = absent('readback')
