# Generation 002 — proposal

- **Date:** 2026-09-11
- **Scope:** focused — context.ambition is "focused": every generation is a small, localised change
- **Suggested by:** `muse-spark-1.3` (meta)
- **Implemented by:** `claude-opus-5`
- **Reviewed by:** `gpt-5.5`
- **Attempts:** 4
- **Summary:** Recover short mapping rows whose omitted trailing columns are optional
- **Pillar:** 

## Rationale

Some exports drop trailing empty columns, so a valid mapping row can arrive with fewer than 8 fields and was being warned about and then dropped. Only the ICD-10-AM target columns can legitimately trail off (an ICD-10 code with no mapped target), so those rows are now padded back out to 8 fields and kept; rows that have lost a mandatory field — including a present target code with a missing descriptor — still warn and skip exactly as before. Clean 8-column and extra-column files take the identical code path, so output for well-formed data is byte-identical.

## What the suggesting model said about its own brief

The frozen test list + measured 7/8 table genuinely helped — it pinpointed the single failing edge case without reading the harness. The exact-once SEARCH rule and 32k budget note helped keep the edit small. What constrained for no good reason: demanding PILLAR-format analysis and SUMMARY-format commit in different places with "EXACTLY / no other structure" on both — I had to guess which parser wins. I would delete one of the two response templates.

## Files changed

- `icd_mapper.py` (−4/+14 lines)

## The suggestion, verbatim

```
PILLAR: edge-case recovery (never silently lose a mapping)
PROBLEM: In `icd_mapper.py` `ICDMapper.read_mapping_file`, any non-blank row with fewer than 8 CSV fields is warned about and then `continue`-skipped. Real exports legitimately omit trailing empty columns, so that row is a valid mapping whose trailing optionals are blank. This is the one remaining measured failure: 7 of 8 awkward files recovered, `row missing trailing empty columns: row silently dropped`.
CHANGE: In `ICDMapper.read_mapping_file` (`icd_mapper.py`), keep the warning naming file and data-row number but recover the row instead of dropping it: if `len(row) < 8`, pad with `''` to length 8 (`row += [''] * (8 - len(row))`) and continue normal extraction. Missing trailing fields thus become `''` -> `None` for `who_update`/`aus_update`/`additive_map`, identical to a fully-quoted row with blank optionals. Rows with >=8 fields and blank-line handling are untouched.
WHY THIS ONE: BOM/latin-1 hardening already merged in gen-001; deduplicating the four readers would be a rewrite, forbidden as ONE focused change. Padding is a 3-line localised edit that moves recovery 7/8 -> 8/8, directly enforces the non-negotiable "reported, not dropped" constraint, and is a no-op for clean 8-column files.
RISK: A truly truncated malformed row (e.g. 2 fields) would now create an entry with empty optionals instead of being skipped. This is backwards compatible because: short length can only mean omitted trailing empties (a missing middle field still leaves its commas, so length stays 8); clean and extra-column files take the identical code path as before; codes/descriptors are still taken verbatim with the existing strip behaviour; report/Excel output unchanged for clean files.
ALSO UPDATE: nothing — `icd_mapper_list.py` and `icd_mapper_unique.py` duplicate len>=8 skip logic but touching them would exceed ONE improvement; left for a later generation.
VERIFICATION: Reviewer should check: (1) `python -m pytest -q tests` still passes; (2) a fixture row with trailing `,,` removed is now present in `mappings` with `None` optionals instead of skipped; (3) warning still prints basename + `reader.line_num`; (4) full 8-col and extra-col files produce byte-identical mappings.
BRIEF FEEDBACK: The frozen test list + measured 7/8 table genuinely helped — it pinpointed the single failing edge case without reading the harness. The exact-once SEARCH rule and 32k budget note helped keep the edit small. What constrained for no good reason: demanding PILLAR-format analysis and SUMMARY-format commit in different places with "EXACTLY / no other structure" on both — I had to guess which parser wins. I would delete one of the two response templates.
ESCALATION: none
ESCALATION TARGET: none
ESCALATION CASE: none
ESCALATION SUPPORT: none
ESCALATION DISSENT: none

<<<EDIT>>>
FILE: icd_mapper.py
<<<SEARCH>>>
            if len(row) < 8:
                print(f"Warning: {os.path.basename(file_path)} data row {reader.line_num}: "
                      f"expected 8 fields, found {len(row)} - row skipped")
                continue
<<<REPLACE>>>
            if len(row) < 8:
                print(f"Warning: {os.path.basename(file_path)} data row {reader.line_num}: "
                      f"expected 8 fields, found {len(row)} - missing trailing fields treated as blank")
                row += [''] * (8 - len(row))
<<<END>>>
```

## Review

VERDICT: APPROVED

REASON: The focused change preserves existing handling for well-formed and invalid short rows while recovering legitimate rows with omitted trailing optional target columns without changing report or spreadsheet structure.

END OF REVIEW
