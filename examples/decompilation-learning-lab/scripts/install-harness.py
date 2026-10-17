#!/usr/bin/env python3
"""Copy the locked existing harness; never silently fetch a floating version."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--source', type=Path, help='path to a checkout containing harness/')
parser.add_argument('--verify', action='store_true', help='check the installed copy only')
args = parser.parse_args()
lock = json.loads((root / 'harness.lock.json').read_text())
source = args.source or root.parents[1]
target = root / 'harness'
if not args.verify:
    if target.exists():
        print('harness/ already exists; verifying without overwriting it.')
    else:
        src = source / 'harness'
        if not src.is_dir():
            raise SystemExit('Pass --source /path/to/self-optimisation at commit ' + lock['commit'])
        for rel, expected in lock['files'].items():
            p = source / rel
            if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != expected:
                raise SystemExit('Source differs from the pinned harness at ' + rel)
        shutil.copytree(src, target, ignore=shutil.ignore_patterns('node_modules', '.env.harness.local'))
for rel, expected in lock['files'].items():
    p = root / rel
    if not p.is_file() or hashlib.sha256(p.read_bytes()).hexdigest() != expected:
        raise SystemExit('Installed harness differs from the pin at ' + rel)
print(f"Verified {len(lock['files'])} harness files at {lock['commit']}.")
