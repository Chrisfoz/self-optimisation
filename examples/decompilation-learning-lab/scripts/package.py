#!/usr/bin/env python3
"""Produce a standalone ZIP from this example plus the exact locked harness."""
from pathlib import Path
import argparse
import subprocess
import zipfile

root = Path(__file__).resolve().parents[1]
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--output', type=Path, default=root / 'build/decompilation-learning-lab.zip')
args = parser.parse_args()
subprocess.run(['python3', str(root / 'scripts/install-harness.py'), '--verify'], check=True)
args.output.parent.mkdir(parents=True, exist_ok=True)
with zipfile.ZipFile(args.output, 'w', zipfile.ZIP_DEFLATED) as archive:
    for p in sorted(root.rglob('*')):
        rel = p.relative_to(root)
        if not p.is_file() or any(x in {'.git', 'node_modules', '__pycache__', 'build'} for x in rel.parts):
            continue
        if p.name.startswith('.env') and p.name not in {'.env.example', '.env.harness.example'}:
            continue
        archive.write(p, Path(root.name) / rel)
print(args.output.resolve())
