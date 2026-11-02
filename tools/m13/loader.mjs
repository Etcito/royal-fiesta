import { existsSync } from 'node:fs';
import { pathToFileURL, fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../../', import.meta.url));
export async function resolve(specifier, context, next) {
    if (specifier === 'mama/package.json')
        return { url: pathToFileURL(root + 'MAMA/package.json').href, shortCircuit: true };
    if (specifier.startsWith('mama/'))
        return { url: pathToFileURL(root + 'MAMA/src/' + specifier.slice(5).replace(/\.js$/, '.ts')).href, shortCircuit: true };
    if (specifier.endsWith('.js') && specifier.startsWith('.') && context.parentURL?.startsWith('file:')) {
        const u = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
        if (existsSync(fileURLToPath(u)))
            return { url: u.href, shortCircuit: true };
    }
    return next(specifier, context);
}
export async function load(url, context, next) {
    if (url.endsWith('.ts') && url.startsWith('file:')) {
        const { readFileSync } = await import('node:fs');
        const ts = await import('../../../MAMA/node_modules/typescript/lib/typescript.js');
        return { format: 'module', shortCircuit: true, source: ts.default.transpileModule(readFileSync(fileURLToPath(url), 'utf8'), { compilerOptions: { module: ts.default.ModuleKind.ESNext, target: ts.default.ScriptTarget.ES2022 } }).outputText };
    }
    return next(url, context);
}
