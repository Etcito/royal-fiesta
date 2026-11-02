// Keep workspace imports in this clone when node_modules is shared with another checkout.
import { registerHooks } from 'node:module'
registerHooks({ resolve(specifier, context, next) {
  const match = /^@royal-fiesta\/(game|sim)\/(.+)$/.exec(specifier)
  if (match) return next(new URL(`../packages/${match[1]}/src/${match[2]}.ts`, import.meta.url).href, context)
  return next(specifier, context)
} })
