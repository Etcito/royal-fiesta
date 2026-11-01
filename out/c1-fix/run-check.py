import subprocess, sys
from pathlib import Path
name, *command = sys.argv[1:]
root = Path('out/c1-fix')
with root.joinpath(name + '.log').open('w') as log:
    result = subprocess.run(command, stdout=log, stderr=subprocess.STDOUT)
root.joinpath(name + '.exit').write_text(str(result.returncode) + '\n')
