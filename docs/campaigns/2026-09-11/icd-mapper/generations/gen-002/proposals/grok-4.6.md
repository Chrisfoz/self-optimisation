# Generation 002 — proposal from `grok-4.6` (xai)

Every model asked this generation, not only the one whose proposal was chosen. See attempts.json's fanOut for which one was.

```
PILLAR: edge-case row recovery (short rows / missing trailing columns)
PROBLEM: After gen-001, `ICDMapper.read_mapping_file` in icd_mapper.py still drops every non-empty row with fewer than 8 fields. Real quoted-CSV exports often omit trailing empty columns, so a legitimate mapping such as five or six fields is warned about and then `continue`d away. That is the remaining 1-of-8 miss ("row missing trailing empty columns: row silently dropped"): the row is not recovered, and a mapping the tool could have kept is lost.
CHANGE: In `ICDMapper.read_mapping_file` (icd_mapper.py), keep the existing blank-line skip. When `len(row) < 8` on a non-blank row, still print a warning that names the file and `reader.line_num`, but pad the row on the right with empty strings up to 8 fields and process it through the unchanged field extraction / `mapping_entry` / append path. Do not invent or rewrite any field that was present; optional blanks still become `None` via the existing `who_update if who_update else None` (and siblings) logic. Rows with 8+ fields are untouched.
WHY THIS ONE: It is the only remaining measured recovery gap, it matches the non-negotiable "never silently lose a mapping", and it is a few-line local edit on the already-hardened reader. Encoding/BOM/CRLF are done; deduplicating the four scripts would be a rewrite; hardening the untested list/unique readers would not move the gated suite or the 7/8 score.
RISK: Previously dropped short rows will now appear in the report and Excel export. Clean 8-column inputs (the characterisation fixture) take the same path as today, so public names, strip behaviour, keying, report text, and spreadsheet columns stay identical. Severely truncated rows can be ingested with blank codes/descriptors; the warning still flags them. No dependency or output-format change.
ALSO UPDATE: nothing
VERIFICATION: `python -m pytest -q tests` must still pass. Confirm a non-blank row with fewer than 8 fields is appended (not skipped), that present codes/descriptors are unchanged, that missing trailing fields become empty/`None` like other blanks, and that a well-formed 8-field file still produces the same mappings, report, and Excel columns as before.
BRIEF FEEDBACK: The 7/8 edge-case score plus gen-001's skip-with-warning made the next change obvious; "never silently drop" and frozen test names kept the edit small. Conflicting required output shapes (SUMMARY-first vs PILLAR-first) and "create-only pattern" with no pattern were noise. The no-shared-module rule blocks the obvious DRY of one reader used by all four scripts — that constraint is real, but it pushes copy-paste fixes. I would delete the duplicate format contracts and the html-fenced source dump.
ESCALATION: Characterisation tests never assert that a short row is kept, so this recovery can regress without a red build.
ESCALATION TARGET: pipeline
ESCALATION CASE: tests/test_icd_mapper.py has no case for a non-blank row with omitted trailing columns. Add one fixture row with <8 fields and assert the ICD-10 code is present via get_mapping. That would lock 8/8 recovery. Risk is low if the fixture only omits trailing empties and expects the same None-for-blank behaviour as test_optional_columns_become_none_when_blank.
ESCALATION SUPPORT: none
ESCALATION DISSENT: none

SUMMARY: Recover short mapping rows by padding missing trailing fields
RATIONALE: The reader already detects rows with fewer than 8 fields but then drops them, which is the last unrecovered messy-export case and silently loses mappings. Padding on the right with empty strings keeps every field that was present byte-identical and reuses the existing blank-to-None logic, so fixture files and downstream report/Excel shape are unchanged. Safe to ship unattended: tests only cover complete 8-column rows, and those rows do not hit the new branch.

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
                      f"expected 8 fields, found {len(row)} - missing fields treated as blank")
                row = list(row) + [''] * (8 - len(row))
<<<END>>>
```
