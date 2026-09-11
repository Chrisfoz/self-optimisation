# Generation 001 — proposal from `glm-5.3` (zai)

Every model asked this generation, not only the one whose proposal was chosen. See attempts.json's fanOut for which one was.

```
PILLAR: Correctness/robustness of input reading.

PROBLEM: `ICDMapper.read_mapping_file` in icd_mapper.py opens with `encoding='utf-8'`, so a BOM corrupts the first data field and a latin-1 export crashes the whole file (and `process_directory` then prints an error and silently loses every mapping in it). Short rows (`len(row) < 8`) and blank lines are dropped without a word — the exact "silent loss" the constraints forbid.

CHANGE: In `icd_mapper.py` only, harden `read_mapping_file`:
1. Open with `encoding='utf-8-sig'` first; on `UnicodeDecodeError`, reopen with `encoding='latin-1'` (mirroring the fallback already used in icd_mapper_list.py).
2. Track a 1-based data-row counter (`reader.line_num`); when a row is non-empty but has fewer than 8 fields, print a warning naming the file and line number and continue. Empty rows are skipped silently.
3. Row field extraction, strip behaviour, mapping_entry keys, and every downstream format stay byte-identical.

WHY THIS ONE: Encoding/BOM failures lose entire files — the largest possible silent data loss — while short rows lose individual mappings with no trace. One localised function fixes both, touches no output format, and matches hints in the brief.

RISK: utf-8-sig decodes plain UTF-8 identically, so the fixture test results are unchanged. Latin-1 never raises, so it can only rescue files, never break previously-working ones. The warning goes to stdout, not the report, so output formats are untouched.

ALSO UPDATE: Nothing mandatory; icd_mapper_unique.py has the same utf-8 weakness but fixing it is a second change for a later generation.

VERIFICATION: Run `python -m pytest -q tests` (all 8 invariants). Manually: feed a BOM-prefixed file, a latin-1 file, and a file with a short row; confirm rows still map, warning names file and line, and report/xlsx output is unchanged for a clean file.

BRIEF FEEDBACK: The frozen-names list and "one improvement" rule genuinely helped focus the change. The parser's exact-once SEARCH requirement forced care but is fine. The hint "the four scripts duplicate reading logic" tempts toward refactoring into a shared helper, which the one-improvement and frozen-files rules make awkward — the brief slightly pulls in two directions there. Nothing I would delete.

ESCALATION: none
ESCALATION TARGET: none
ESCALATION CASE: none
ESCALATION SUPPORT: none
ESCALATION DISSENT: none

SUMMARY: Make read_mapping_file tolerate BOM/latin-1 encodings and report short rows
RATIONALE: Encoding failures currently lose whole files silently and short rows vanish without trace — the worst kind of data loss for clinical coders who trust the output. A utf-8-sig-first, latin-1-fallback open plus per-line warnings is a small, localised edit that can only rescue inputs, never change behaviour on clean ones, and touches no output format.

<<<EDIT>>>
FILE: icd_mapper.py
<<<SEARCH>>>
    def read_mapping_file(self, file_path: str) -> None:
        """Read and process an ICD mapping file."""
        with open(file_path, 'r', encoding='utf-8') as file:
            header = next(file)
            reader = csv.reader(file, quoting=csv.QUOTE_MINIMAL)
            
            for row in reader:
                if len(row) >= 8:
                    counter = row[0].strip()
<<<REPLACE>>>
    def read_mapping_file(self, file_path: str) -> None:
        """Read and process an ICD mapping file."""
        # utf-8-sig strips a BOM if present; fall back to latin-1 for
        # exports saved in a legacy single-byte encoding.
        try:
            file_handle = open(file_path, 'r', encoding='utf-8-sig')
            file_handle.close()
        except UnicodeDecodeError:
            encoding = 'latin-1'
        else:
            encoding = 'utf-8-sig'
        
        with open(file_path, 'r', encoding=encoding) as file:
            header = next(file)
            reader = csv.reader(file, quoting=csv.QUOTE_MINIMAL)
            
            for row in reader:
                if len(row) >= 8:
                    counter = row[0].strip()
<<<END>>>

<<<EDIT>>>
FILE: icd_mapper.py
<<<SEARCH>>>
                    
                    if icd10_code not in self.mappings:
                        self.mappings[icd10_code] = []
<<<REPLACE>>>
                    if icd10_code not in self.mappings:
                        self.mappings[icd10_code] = []
                    # report (never silently drop) rows we cannot read
                elif any(field.strip() for field in row):
                    print(f"Warning: {file_path}: line {reader.line_num} "
                          f"has {len(row)} fields (expected at least 8); "
                          f"row skipped.")
<<<END>>>
```
