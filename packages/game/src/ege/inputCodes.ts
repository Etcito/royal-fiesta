// E2: conversion between the S1 wire code (sim/input) and the engine input code.
// Engine layout: move_x bits 0-7, move_z bits 8-15, buttons jump 16, dive 17, grab 18; m = 127.
// Both directions are bit glue, so the decoded axis values stay equal on both sides.

export const ENGINE_NEUTRAL_CODE = 0

const AXIS_CENTRE = 127
const BUTTON_BITS = 0x70000

function clampAxis(q: number): number {
  return Math.max(-127, Math.min(127, q))
}

export function engineCodeOfS1(code: number): number {
  // S1 bytes above 254 act as 254, as in sim/input decodeInput.
  const qx = Math.min(code & 0xff, 254) - AXIS_CENTRE
  const qz = Math.min((code >>> 8) & 0xff, 254) - AXIS_CENTRE
  return ((qx & 0xff) | ((qz & 0xff) << 8) | (code & BUTTON_BITS)) >>> 0
}

export function s1CodeOfEngine(code: number): number {
  // Sign-extended axis bytes, clamped to the symmetric range -127..127.
  const qx = clampAxis((code << 24) >> 24)
  const qz = clampAxis((code << 16) >> 24)
  return ((qx + AXIS_CENTRE) | ((qz + AXIS_CENTRE) << 8) | (code & BUTTON_BITS)) >>> 0
}
