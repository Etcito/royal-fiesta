import type { MechanismSpec } from '../mechanismSpec.ts'

export interface LogicState {
  value: Uint8Array
  timer: Int32Array
  count: Int32Array
  prev: Uint8Array
  // Delay buffers concatenated in node order; timer holds each delay's head.
  ring: Uint8Array
}

export function newLogicState(m: MechanismSpec): LogicState {
  const n = m.logic.length
  let bytes = 0
  for (let k = 0; k < n; k++) {
    if (m.logic[k].op === 'delay') bytes += m.logic[k].ticks
  }
  return {
    value: new Uint8Array(n),
    timer: new Int32Array(n),
    count: new Int32Array(n),
    prev: new Uint8Array(n),
    ring: new Uint8Array(bytes),
  }
}

export function evalLogic(m: MechanismSpec, inputs: Uint8Array, s: LogicState): void {
  const external = m.switches.length + m.levers.length
  let offset = 0
  for (let k = 0; k < m.logic.length; k++) {
    const node = m.logic[k]
    let x = false
    let all = true
    let first = false
    for (let j = 0; j < node.inputs.length; j++) {
      const i = node.inputs[j]
      const on = (i < external ? inputs[i] : s.value[i - external]) !== 0
      x = x || on
      all = all && on
      if (j === 0) first = on
    }
    const rising = x && s.prev[k] === 0
    switch (node.op) {
      case 'and':
        s.value[k] = all ? 1 : 0
        break
      case 'or':
        s.value[k] = x ? 1 : 0
        break
      case 'not':
        s.value[k] = first ? 0 : 1
        break
      case 'toggle':
        if (rising) s.value[k] ^= 1
        break
      case 'timer':
        if (rising) s.timer[k] = node.ticks
        s.value[k] = s.timer[k] > 0 ? 1 : 0
        if (s.timer[k] > 0) s.timer[k]--
        break
      case 'delay': {
        const head = s.timer[k]
        s.value[k] = s.ring[offset + head]
        s.ring[offset + head] = x ? 1 : 0
        s.timer[k] = (head + 1) % node.ticks
        offset += node.ticks
        break
      }
      case 'counter':
        if (rising) s.count[k]++
        s.value[k] = s.count[k] >= node.count ? 1 : 0
        break
    }
    s.prev[k] = x ? 1 : 0
  }
}
