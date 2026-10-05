import re
import subprocess
import sys
from pathlib import Path

import yaml

failures = 0

for path in sorted(Path('.github/workflows').glob('*.yml')):
    text = path.read_text(encoding='utf-8')
    try:
        doc = yaml.safe_load(text)
    except Exception as err:
        print(f'FAIL {path}: YAML does not parse\n     {err}')
        failures += 1
        continue

    on = doc.get(True, doc.get('on'))
    print(f'ok   {path}  triggers={list(on)}')

    # A `run:` line holding a quoted string with ": " needs to be a block scalar, otherwise YAML
    # silently reads it as a nested mapping. This exact mistake has been made twice here.
    # This has to be checked on the raw text, because PyYAML resolves `run: |` to a plain string
    # and the block form would otherwise be indistinguishable from the broken inline form.
    for raw in text.splitlines():
        stripped = raw.strip()
        if not stripped.startswith('run:'):
            continue
        value = stripped[len('run:'):].strip()
        if value.startswith(('|', '>')):
            continue
        if re.search(r'"[^"]*:\s[^"]*"', value):
            print(f'FAIL {path}: inline run with ": " inside quotes -> {stripped}')
            print('     convert it to a block scalar:  run: |')
            failures += 1
        if value.count('"') % 2 != 0:
            print(f'FAIL {path}: unbalanced quotes in run -> {stripped}')
            failures += 1

# Render the hand-off command the way Actions would and syntax check it.
for path in sorted(Path('.github/workflows').glob('*.yml')):
    doc = yaml.safe_load(path.read_text(encoding='utf-8'))
    for job in doc['jobs'].values():
        for step in job.get('steps', []):
            if not str(step.get('name', '')).startswith('Hand off'):
                continue
            script = step['run']
            for expr, value in {
                'steps.publish.outputs.remaining': '1930',
                'github.ref_name': 'main',
                'inputs.book_id': '',
                'inputs.end_chapter': '0',
                'inputs.max_chapters': '50',
                'inputs.delay_seconds': '45',
            }.items():
                script = script.replace('${{ ' + expr + ' }}', value)
            Path('_handoff.sh').write_text(script, newline='\n')
            result = subprocess.run(['bash', '-n', '_handoff.sh'], capture_output=True, text=True)
            Path('_handoff.sh').unlink(missing_ok=True)
            if result.returncode == 0:
                print(f'ok   {path}  hand-off command is valid bash')
                continue
            # On Windows `bash` is WSL, and WSL refuses to start when its virtual disk is locked. It
            # reports that on stdout, in UTF-16, and exits non-zero, which looks exactly like invalid
            # bash unless it is filtered out. Say the environment was the problem instead of
            # blaming the workflow.
            combined = f'{result.stdout}\n{result.stderr}'.lower()
            if any(hint in combined for hint in ('wsl', 'translate', 'vhd', 'intellijeno')):
                print(f'skip {path}  could not run bash, so the hand-off was not syntax checked')
                print('     (this machine has no usable bash right now; the workflow was left alone)')
                continue
            noise = [l for l in result.stderr.splitlines() if 'wsl' not in l and 'translate' not in l]
            print(f'FAIL {path}  hand-off command is not valid bash: {noise}')
                failures += 1

print()
print('all workflow checks passed' if not failures else f'{failures} problem(s) found')
sys.exit(1 if failures else 0)
