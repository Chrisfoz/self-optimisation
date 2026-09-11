# Generation 001 — proposal from `deepseek-v4-pro` (deepseek)

Every model asked this generation, not only the one whose proposal was chosen. See attempts.json's fanOut for which one was.

```
SUMMARY: Pad short mapping rows instead of silently dropping them
RATIONALE: Trailing blank fields are often omitted by CSV exporters, so a 7-column mapping row is currently skipped by the `len(row) >= 8` guard. This silently loses mappings and violates the core data-integrity constraint. Padding to the fixed 8-column schema is a small, local change that preserves every existing output format.

PILLAR: Data integrity
PROBLEM: In `icd_mapper.py` (and duplicated in `icd_mapper_list.py` and `icd_mapper_unique.py`), `read_mapping_file` only processes rows where `len(row) >= 8`. Real exports frequently omit trailing blank columns, so a legitimate mapping with a blank optional field arrives as 7 columns and is silently skipped. That directly violates the requirement that no mapping be lost without a word.
CHANGE: In all three `ICDMapper.read_mapping_file` implementations, before the existing length check:
1. Skip fully blank rows.
2. Pad any non-blank row shorter than 8 columns with empty strings up to the fixed schema length.
3. Let the existing extraction logic run unchanged.
WHY THIS ONE: Short rows cause silent mapping loss, which is the most serious correctness failure. Latin-1 failure is noisy rather than silent, and CRLF/BOM/extra-column inputs already behave acceptably in the primary reader. Padding fixes the loss with minimal risk.
RISK: Existing well-formed rows are untouched. Rows previously skipped due to omitted trailing blanks now appear in the output as intended. The only theoretical risk is a malformed row missing essential fields; it would behave like an already-present blank-code row, not a new failure mode.
ALSO UPDATE: Apply the same short-row padding in `icd_mapper_list.py` and `icd_mapper_unique.py`. `excel_to_txt.py` does not read mapping files and needs no change.
VERIFICATION: Run `python -m pytest -q tests`; all frozen tests should pass. Manually read a 7-column CSV row and confirm `get_mapping` returns the expected mapping; feed a blank line and confirm it is skipped without crashing.
BRIEF FEEDBACK: The frozen-invariant summary and the explicit editable-file list made it easy to pick a change that cannot weaken the test suite. The hints about messy exports were useful context, not a ceiling.
ESCALATION: none
ESCALATION TARGET: none
ESCALATION CASE: none
ESCALATION SUPPORT: none
ESCALATION DISSENT: none

<<<EDIT>>>
FILE: icd_mapper.py
<<<SEARCH>>>
            for row in reader:
                if len(row) >= 8:
                    counter = row[0].strip()
<<<REPLACE>>>
            for row in reader:
                # Blank lines are not mapping rows; ignore them without loss.
                if not row or all(not cell.strip() for cell in row):
                    continue
                # Some exports omit trailing blank fields. Pad the row back
                # to the fixed 8-column schema instead of dropping the mapping.
                if len(row) < 8:
                    row = row + [''] * (8 - len(row))
                if len(row) >= 8:
                    counter = row[0].strip()
<<<END>>>

<<<EDIT>>>
FILE: icd_mapper_list.py
<<<SEARCH>>>
                    for row in reader:
                        if len(row) >= 8:
                            icd10am_code = row[4].strip(' "')
<<<REPLACE>>>
                    for row in reader:
                        if not row or all(not cell.strip() for cell in row):
                            continue
                        if len(row) < 8:
                            row = row + [''] * (8 - len(row))
                        if len(row) >= 8:
                            icd10am_code = row[4].strip(' "')
<<<END>>>

<<<EDIT>>>
FILE: icd_mapper_unique.py
<<<SEARCH>>>
            for row in reader:
                if len(row) >= 8:
                    icd10am_code = row[4].strip(' "')
<<<REPLACE>>>
            for row in reader:
                if not row or all(not cell.strip() for cell in row):
                    continue
                if len(row) < 8:
                    row = row + [''] * (8 - len(row))
                if len(row) >= 8:
                    icd10am_code = row[4].strip(' "')
<<<END>>>
```
