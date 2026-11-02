import { loadCorePlugins } from '../../../MAMA/src/node/load-plugins.ts';
await loadCorePlugins();
let failed = 0, passed = 0;
for (const name of process.argv.slice(2)) {
    const { checks } = await import(`../../../MAMA/src/core/game/${name}.test.ts`);
    for (const c of checks)
        try {
            for (const m of await c.run()) {
                if (!m.pass) {
                    console.error(m);
                    failed++;
                }
                else
                    passed++;
            }
        }
        catch (e) {
            console.error(c.label, e);
            failed++;
        }
}
console.log({ passed, failed });
process.exit(failed ? 1 : 0);
