#!/usr/bin/env python3
"""A finite-domain binary reconstruction lesson. Python standard library only."""
import argparse
import hashlib
import html
import itertools
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parent
DOMAIN = list(itertools.product(range(8), range(8), range(2)))
PROBES = DOMAIN[::8]  # 16 public cases; the other 112 are assessment cases.
ASSESSMENT = [x for x in DOMAIN if x not in PROBES]
FLAGS = ['-std=c11', '-O2', '-fno-stack-protector', '-fno-asynchronous-unwind-tables']


def run(argv, **kwargs):
    """No shell; a timeout and credential-free environment, not a sandbox."""
    env = {'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'LC_ALL': 'C'}
    return subprocess.run([str(x) for x in argv], text=True, capture_output=True,
                          timeout=10, check=True, env=env, **kwargs)


def digest(data):
    return hashlib.sha256(data).hexdigest()


def build(source, target):
    target = Path(target)
    target.mkdir(parents=True, exist_ok=True)
    obj = target / 'score.o'
    exe = target / 'score'
    run(['gcc', *FLAGS, '-c', Path(source).resolve(), '-o', obj])
    run(['gcc', *FLAGS, '-s', ROOT / 'oracle/driver.c', obj, '-o', exe])
    run(['objcopy', '-O', 'binary', '--only-section=.text', obj, target / 'text.bin'])
    return exe, obj, (target / 'text.bin').read_bytes()


def execute(exe, inputs=DOMAIN):
    payload = ''.join(f'{a} {b} {c}\n' for a, b, c in inputs)
    output = run([exe], input=payload).stdout.splitlines()
    if len(output) != len(inputs):
        raise ValueError(f'Expected {len(inputs)} results, received {len(output)}')
    return [int(x) for x in output]


def evaluate(candidate):
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix='decomp-lab-') as tmp:
        tmp = Path(tmp)
        ref_exe, _, ref_text = build(ROOT / 'reference/score.c', tmp / 'ref')
        cand_exe, _, cand_text = build(candidate, tmp / 'cand')
        expected, actual = execute(ref_exe), execute(cand_exe)
    correct = [e == a for e, a in zip(expected, actual)]
    matches = sum(correct)
    failures = [{'input': list(x), 'expected': e, 'actual': a}
                for x, e, a in zip(DOMAIN, expected, actual) if e != a]
    return {
        'schema_version': 1, 'candidate_sha256': digest(Path(candidate).read_bytes()),
        'compiler': run(['gcc', '--version']).stdout.splitlines()[0],
        'compiler_flags': FLAGS,
        'domain': {'coins': [0, 7], 'streak': [0, 7], 'hazard': [0, 1]},
        'matches': matches, 'total': len(DOMAIN),
        'public_matches': sum(correct[DOMAIN.index(x)] for x in PROBES),
        'public_total': len(PROBES),
        'assessment_matches': sum(correct[DOMAIN.index(x)] for x in ASSESSMENT),
        'assessment_total': len(ASSESSMENT),
        'behavioral_match_in_declared_domain': matches == len(DOMAIN),
        'function_text_byte_match': ref_text == cand_text,
        'reference_text_sha256': digest(ref_text), 'candidate_text_sha256': digest(cand_text),
        'counterexamples': failures[:8], 'elapsed_seconds': round(time.monotonic() - started, 3),
        'limitation': 'Only this pure function and the 128 declared inputs are assessed. '
                      'This does not recover original names/comments, verify a whole game, '
                      'or prove equivalence outside the declared domain.'
    }


def prepare():
    out = ROOT / 'build'
    exe, obj, _ = build(ROOT / 'reference/score.c', out / 'reference')
    assembly = run(['objdump', '-d', '-M', 'intel', obj]).stdout
    # Remove the local build path; the actual instructions remain unchanged.
    assembly = re.sub(r'^.*: +file format', 'score.o: file format', assembly, flags=re.M)
    cases = [{'input': list(x), 'output': y} for x, y in zip(PROBES, execute(exe, PROBES))]
    evidence = ('# Learner evidence\n\nGenerated from the compiled teaching binary. '
                'The source is retained separately for audit and reproducibility.\n\n'
                'Recover `int score_tick(int coins, int streak, int hazard)`. '
                'Only coins/streak 0..7 and hazard 0..1 are valid. '
                'The function has no state, external calls or side effects.\n\n'
                'Compiler: ' + run(['gcc', '--version']).stdout.splitlines()[0] + '\n\n'
                'Flags: `' + ' '.join(FLAGS) + '`\n\n```asm\n' + assembly + '\n```\n\n'
                '## Public input/output probes\n\n```json\n' + json.dumps(cases, indent=2) + '\n```\n')
    (out / 'evidence.md').write_text(evidence)
    (out / 'public-probes.json').write_text(json.dumps(cases, indent=2) + '\n')
    return out


def gate(candidate, baseline=None):
    # Green baseline permits incremental repair. Never trade a previously
    # correct input for a different one simply to improve the aggregate score.
    with tempfile.TemporaryDirectory(prefix='decomp-gate-') as tmp:
        tmp = Path(tmp)
        baseline_label = str(baseline) if baseline else 'frozen starter (no committed candidate found)'
        if baseline is None:
            baseline = ROOT / 'fixtures/starter.c'
            # In a harness attempt HEAD is the pre-edit tree. This prevents a
            # later generation from losing correctness gained in an earlier one.
            try:
                git_root = Path(run(['git', '-C', ROOT, 'rev-parse', '--show-toplevel']).stdout.strip())
                relative = (ROOT / 'candidate/score.c').relative_to(git_root).as_posix()
                committed = run(['git', '-C', git_root, 'show', 'HEAD:' + relative]).stdout
                baseline = tmp / 'baseline.c'
                baseline.write_text(committed)
                baseline_label = 'git HEAD:' + relative
            except (subprocess.SubprocessError, ValueError, OSError):
                pass
        ref, _, _ = build(ROOT / 'reference/score.c', tmp / 'ref')
        baseline, _, _ = build(baseline, tmp / 'base')
        proposed, _, _ = build(candidate, tmp / 'cand')
        expected, before, after = execute(ref), execute(baseline), execute(proposed)
    regressions = [list(x) for x, e, b, a in zip(DOMAIN, expected, before, after) if b == e and a != e]
    print(json.dumps({'baseline': baseline_label, 'regressions': regressions,
                      'matches': sum(a == e for a, e in zip(after, expected)), 'total': len(DOMAIN)}))
    return not regressions


def report_html(record):
    rows = ''.join('<tr><td>' + '</td><td>'.join(html.escape(str(x)) for x in
                   [r['attempt'], r['label'], f"{r.get('matches', 0)}/128",
                    r.get('function_text_byte_match', False), r['decision']]) + '</td></tr>'
                   for r in record['attempts'])
    details = html.escape(json.dumps(record, indent=2))
    return f'''<!doctype html><html lang="en"><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Binary reconstruction lab</title>
<style>body{{font:17px system-ui;background:#101827;color:#e8edf7;max-width:1050px;margin:50px auto;padding:24px}}
h1{{font-size:42px;letter-spacing:-1.5px}}p{{line-height:1.7;color:#c3cfe0}}strong{{color:#75e2b8}}
table{{border-collapse:collapse;width:100%;margin:30px 0}}th,td{{padding:16px;text-align:left;border-bottom:1px solid #364154}}
@media(max-width:600px){{body{{margin:10px auto;padding:14px;font-size:15px}}h1{{font-size:32px}}th,td{{padding:8px;font-size:12px}}}}
pre{{white-space:pre-wrap;font-size:13px}}a{{color:#75e2b8}}.tag{{color:#75e2b8;text-transform:uppercase;letter-spacing:2px}}</style>
<p class="tag">Learning lab / scripted replay</p><h1>Can we reconstruct a binary and check the result?</h1>
<p>This is a deterministic replay of supplied C candidates. <strong>No AI model was called.</strong>
Each candidate is really compiled and run against the original teaching binary.</p>
<table><thead><tr><th>Attempt</th><th>Proposal</th><th>Inputs matched</th><th>Function bytes match</th><th>Decision</th></tr></thead><tbody>{rows}</tbody></table>
<p>All 128 inputs in the declared domain are checked. The byte check compares only the scoring function's
object-code .text section with the same compiler and flags. It is separate from behaviour and whole-executable identity.</p>
<p>The deployed portable harness can propose real candidates later. Its model runs are separate from this replay.
Original comments, names, assets and a whole commercial application are outside this lesson.</p>
<details><summary>Inspect the measured evidence</summary><pre>{details}</pre></details></html>'''


def replay():
    out = prepare()
    best_source = ROOT / 'fixtures/starter.c'
    best = evaluate(best_source)
    attempts = [{'attempt': 0, 'label': 'Starter reconstruction', 'decision': 'baseline', **best}]
    for number, (label, source) in enumerate([
        ('Repair combo rule', ROOT / 'fixtures/partial.c'),
        ('Simplify too aggressively', ROOT / 'fixtures/regression.c'),
        ('Repair hazard rule', ROOT / 'reference/score.c')], start=1):
        measured = evaluate(source)
        # Check per-input non-regression against the CURRENT best, not only
        # the starter floor used for preflight in a fresh harness generation.
        with tempfile.TemporaryDirectory() as tmp:
            ref, _, _ = build(ROOT / 'reference/score.c', Path(tmp) / 'ref')
            old, _, _ = build(best_source, Path(tmp) / 'old')
            new, _, _ = build(source, Path(tmp) / 'new')
            expected, before, after = execute(ref), execute(old), execute(new)
        regression = any(b == e and a != e for e, b, a in zip(expected, before, after))
        accept = not regression and measured['matches'] > best['matches']
        attempts.append({'attempt': number, 'label': label,
                         'decision': 'accepted' if accept else 'rejected', **measured})
        if accept:
            best, best_source = measured, source
    record = {'mode': 'scripted-replay', 'model_calls': 0,
              'final_proposal_is_supplied_ground_truth': True, 'attempts': attempts}
    (out / 'replay.json').write_text(json.dumps(record, indent=2) + '\n')
    (out / 'report.html').write_text(report_html(record))
    print('\n'.join(f"{r['attempt']}: {r['label']}: {r['matches']}/128 — {r['decision']}" for r in attempts))
    print(f'\nOpen {out / "report.html"}. Candidate file was left for you to edit.')
    return record


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'evaluate', 'gate', 'replay'])
    parser.add_argument('--candidate', type=Path, default=ROOT / 'candidate/score.c')
    parser.add_argument('--strict', action='store_true', help='evaluation exits 1 unless all 128 inputs match')
    parser.add_argument('--baseline', type=Path, help='explicit gate baseline; otherwise uses committed candidate')
    args = parser.parse_args()
    try:
        if args.command == 'prepare':
            print(f'Prepared binary, assembly and probes in {prepare()}')
        elif args.command == 'replay':
            replay()
        elif args.command == 'gate':
            return 0 if gate(args.candidate, args.baseline) else 1
        else:
            result = evaluate(args.candidate)
            print(json.dumps(result, indent=2))
            return 1 if args.strict and not result['behavioral_match_in_declared_domain'] else 0
    except (subprocess.SubprocessError, OSError, ValueError) as error:
        if isinstance(error, subprocess.CalledProcessError):
            print(error.stderr[-6000:])
        else:
            print(str(error))
        return 2
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
