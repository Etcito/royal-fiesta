// WGSL reserved words: naga (the WGSL parser behind RAA's material functions, raa Cargo.lock naga 30.0.1,
// src/keywords/wgsl.rs RESERVED after its keywords) refuses each as an identifier with "name `x` is a reserved keyword",
// which RAA reports as material.fn_invalid. Generated material WGSL is checked here, in node, before it reaches the GPU.
export const WGSL_RESERVED: ReadonlySet<string> = new Set([
  'NULL', 'Self', 'abstract', 'active', 'alignas', 'alignof', 'as', 'asm', 'asm_fragment', 'async', 'attribute',
  'auto', 'await', 'become', 'cast', 'catch', 'class', 'co_await', 'co_return', 'co_yield', 'coherent',
  'column_major', 'common', 'compile', 'compile_fragment', 'concept', 'const_cast', 'consteval', 'constexpr',
  'constinit', 'crate', 'debugger', 'decltype', 'delete', 'demote', 'demote_to_helper', 'do', 'dynamic_cast', 'enum',
  'explicit', 'export', 'extends', 'extern', 'external', 'fallthrough', 'filter', 'final', 'finally', 'friend',
  'from', 'fxgroup', 'get', 'goto', 'groupshared', 'highp', 'impl', 'implements', 'import', 'inline', 'instanceof',
  'interface', 'layout', 'lowp', 'macro', 'macro_rules', 'match', 'mediump', 'meta', 'mod', 'module', 'move', 'mut',
  'mutable', 'namespace', 'new', 'nil', 'noexcept', 'noinline', 'nointerpolation', 'non_coherent', 'noncoherent',
  'noperspective', 'null', 'nullptr', 'of', 'operator', 'package', 'packoffset', 'partition', 'pass', 'patch',
  'pixelfragment', 'precise', 'precision', 'premerge', 'priv', 'protected', 'pub', 'public', 'readonly', 'ref',
  'regardless', 'register', 'reinterpret_cast', 'require', 'resource', 'restrict', 'self', 'set', 'shared', 'sizeof',
  'smooth', 'snorm', 'static', 'static_assert', 'static_cast', 'std', 'subroutine', 'super', 'target', 'template',
  'this', 'thread_local', 'throw', 'trait', 'try', 'type', 'typedef', 'typeid', 'typename', 'typeof', 'union',
  'unless', 'unorm', 'unsafe', 'unsized', 'use', 'using', 'varying', 'virtual', 'volatile', 'wgsl', 'where', 'with',
  'writeonly', 'yield',
])

/** Every reserved word used as a name in `wgsl` (comments skipped), as 'line:column name'. */
export function wgslReservedNames(wgsl: string): string[] {
  const found: string[] = []
  const code = wgsl.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, c => c.replace(/[^\n]/g, ' '))
  const lines = code.split('\n')
  lines.forEach((line, i) => {
    for (const m of line.matchAll(/(?<![A-Za-z0-9_])[A-Za-z_][A-Za-z0-9_]*/g)) {
      if (WGSL_RESERVED.has(m[0])) found.push(`${i + 1}:${m.index + 1} ${m[0]}`)
    }
  })
  return found
}
