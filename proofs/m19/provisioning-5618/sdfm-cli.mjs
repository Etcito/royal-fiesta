// dispatcher shim: runs build-node/node/cli.js main() without recompiling (tsc exits 2 on the two known diagnostics)
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const { main } = await import(pathToFileURL('/tmp/env/sdfm/build-node/node/cli.js').href)
const code = await main(process.argv.slice(2))
const flush = (s) => new Promise((res) => (s.writableLength === 0 ? res() : s.write('', () => res())))
await Promise.all([flush(process.stdout), flush(process.stderr)])
process.exit(code)
