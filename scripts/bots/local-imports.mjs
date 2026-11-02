import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  const match = /^@royal-fiesta\/(sim|game)\/(.+)$/.exec(specifier)
  if (match) return next(new URL(`../../packages/${match[1]}/src/${match[2]}.ts`, import.meta.url).href, context)
  return next(specifier, context)
} })
// Baseline source is captured from HEAD by the measurement command, never imported
// through the node_modules symlink (which points at the live repository).
if (process.env.BOT_BASELINE) {
  const { readFileSync } = await import('node:fs')
  registerHooks({ load(url, context, next) {
    const match = /\/packages\/(?:game\/src\/net\/(modeBots|takeoverBot)|sim\/src\/bots\/(brain|courseRead|routes))\.ts$/.exec(url)
    if (match) return { format: 'module-typescript', source: readFileSync(`${process.env.BOT_BASELINE}/${match[1] ?? match[2]}.ts`, 'utf8'), shortCircuit: true }
    return next(url, context)
  } })
}
