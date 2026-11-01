# Sequential functional verification: one simulation/build process at a time.
import os, subprocess, sys
from pathlib import Path

cpus = max(1, int(os.environ.get('NMC_CPUS', '1')))
root = Path('out/c1-fix')
node = ['node', '--experimental-strip-types']
round_run = ['npm', 'run', 'round:run', '--']
checks = [
    ('tile-remap', node + ['--test', '--test-name-pattern=tile keys remap', 'packages/sim/test/featureTiles.test.ts']),
    ('first-wasm', node + ['--test', '--test-name-pattern=reports the first wasm', 'apps/headless/test/roundRun.test.ts']),
    ('regressions', node + ['--test', '--test-concurrency=1', 'packages/sim/test/featureTiles.test.ts', 'packages/sim/test/featureMovers.test.ts', 'packages/sim/test/fiestaDomain.test.ts', 'packages/game/test/zoneMatch.test.ts', 'apps/headless/test/roundRun.test.ts']),
]
for seats in [2, 4, 8]:
    checks.append((f'c1-sprint-{seats}', round_run + ['--course', 's1-c1-diamond-citadel', '--dir', 'courses', '--seats', str(seats), '--peers', '2', '--profile', 'sprint']))
checks += [
    ('c1-season-60', round_run + ['--course', 's1-c1-diamond-citadel', '--dir', 'courses', '--seats', '60', '--peers', '2', '--profile', 'season', '--progress']),
    ('g-season-60', round_run + ['--course', 's1-g-cloudstack-tower', '--dir', 'courses', '--seats', '60', '--peers', '2', '--profile', 'season', '--progress']),
    ('typecheck', ['npm', 'run', 'typecheck']),
    ('build', ['npm', 'run', 'build']),
    ('guard', ['npm', 'run', 'guard']),
]
start = sys.argv[1] if len(sys.argv) > 1 else checks[0][0]
started = False
for name, command in checks:
    started = started or name == start
    if not started:
        continue
    print(f'RUN {name}: {command}', flush=True)
    result = subprocess.run(['python3', str(root/'run-check.py'), name, *command])
    code = int(root.joinpath(name+'.exit').read_text())
    print(f'EXIT {name}: {code}', flush=True)
    if code != 0:
        sys.exit(code)
