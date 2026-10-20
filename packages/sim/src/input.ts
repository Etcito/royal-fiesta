import type { InputCodec } from '@gamesaloon/rollback'
import { refuse } from './refusal.ts'

// S1 wire layout: moveX bits 0-7, moveZ bits 8-15, buttons 16-18, bits 19-31 zero.
export interface PlayerInput {
  moveX: number
  moveZ: number
  jump: boolean
  dive: boolean
  grab: boolean
}

export const NEUTRAL_CODE = 32639

export const BTN: { readonly JUMP: 65536; readonly DIVE: 131072; readonly GRAB: 262144 } = {
  JUMP: 65536,
  DIVE: 131072,
  GRAB: 262144,
}

export function neutralInput(): PlayerInput {
  return { moveX: 0, moveZ: 0, jump: false, dive: false, grab: false }
}

function quantise(axis: string, value: number): number {
  if (!Number.isFinite(value)) refuse('input', axis, 'got NaN; pass a finite number in -1..1')
  return Math.round(Math.max(-1, Math.min(1, value)) * 127) + 127
}

export function encodeInput(i: PlayerInput): number {
  let code = quantise('moveX', i.moveX) | (quantise('moveZ', i.moveZ) << 8)
  if (i.jump) code |= BTN.JUMP
  if (i.dive) code |= BTN.DIVE
  if (i.grab) code |= BTN.GRAB
  return code >>> 0
}

export function decodeInput(code: number, out: PlayerInput): PlayerInput {
  out.moveX = (Math.min(code & 0xff, 254) - 127) / 127
  out.moveZ = (Math.min((code >>> 8) & 0xff, 254) - 127) / 127
  out.jump = (code & BTN.JUMP) !== 0
  out.dive = (code & BTN.DIVE) !== 0
  out.grab = (code & BTN.GRAB) !== 0
  return out
}

// May allocate: only for scripts and tests, never on the hot path.
export function inputCode(partial: Partial<PlayerInput>): number {
  return encodeInput({ ...neutralInput(), ...partial })
}

export const inputCodec: InputCodec<PlayerInput> = {
  create: neutralInput,
  encode: encodeInput,
  decode: decodeInput,
  neutral: NEUTRAL_CODE,
}
