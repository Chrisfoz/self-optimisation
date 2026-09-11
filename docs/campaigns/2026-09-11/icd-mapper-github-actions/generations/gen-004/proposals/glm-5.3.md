# Generation 004 — proposal from `glm-5.3` (zai)

Every model asked this generation, not only the one whose proposal was chosen. See attempts.json's fanOut for which one was.

```
PILLAR: edge-case files whose row is recovered (and crash count)

PROBLEM: `icd_mapper_unique.py` opens files with plain `encoding='utf-8'` and calls `next(file)` on the header before any fallback, so a latin-1 descriptor byte raises `UnicodeDecodeError`; `process_directory` catches it and the whole file's mappings are silently lost. A UTF-8 BOM also corrupts the first data row's counter field (it survives only because the counter isn't used, but the descriptor of the first row can be affected in other scripts). `icd_mapper_list.py` tries `utf-8` first, so a BOM leaks `\ufeff` into the first data row's first field, and its fallback chain silently restarts parsing mid-file state cleanly but its first attempt can partially append rows before a later decode error — no, actually its loop re-reads from scratch, that's fine; the BOM issue remains. `icd_mapper.py` already handles both cases correctly (gen-001).

CHANGE: Bring the two sibling scripts in line with `icd_mapper.py`'s proven decode strategy:
1. In `icd_mapper_unique.py`, `read_mapping_file`: replace the plain `open(..., 'utf-8')` with a try/except that opens with `utf-8-sig` and falls back to `latin-1` on `UnicodeDecodeError`, reading the header inside the successful open (same shape as `icd_mapper.py`).
2. In `icd_mapper_list.py`, `read_mapping_file`: change the encoding list from `['utf-8', 'latin1', 'cp1252']` to `['utf-8-sig', 'latin1', 'cp1252']` so a BOM is stripped on the primary path.

No parsing, stripping, or output logic changes — only how bytes become text.

WHY THIS ONE: Gen-002's short-row recovery was rejected three times for producing mappings with blanked mandatory fields; the design is hard to get right without more fixture coverage. Encoding robustness, by contrast, is already validated in `icd_mapper.py` by the measurement harness (latin-1 and BOM files recover there), is a mechanical port, and removes a real failure mode: a whole file silently vanishing from `unique_icd10am_codes.xlsx` and the downstream `icd10am_codes.txt`.

RISK: Very low. `utf-8-sig` decodes plain UTF-8 identically and only strips a leading BOM; latin-1 decodes every byte sequence, so it can only succeed where utf-8 raised. Clean files take a byte-identical code path. Worst case is unchanged behaviour for the fallback encodings already in the list.

ALSO UPDATE: Nothing else — the public names, row handling, and output formats in both scripts are untouched.

VERIFICATION: Run `python -m pytest -q tests` (targets `icd_mapper.py`, must still pass unchanged). Then feed each script's `process_directory` a latin-1 encoded file and a BOM file and confirm "Successfully processed" plus the expected rows in the exports.

BRIEF FEEDBACK: The generation history with failure reasons was the most valuable part — it stopped me re-attempting the short-row design that review already rejected three times. The measured dimensions give useful steering. The frozen-tests constraint is reasonable, but the fact that tests only cover `icd_mapper.py` while three sibling scripts share the same fragile reading logic means improvements to the siblings are unverifiable by the gate — I'd let the harness add smoke tests for the other scripts.

ESCALATION: The characterisation tests only exercise `icd_mapper.py`; the three sibling scripts can regress freely.
ESCALATION TARGET: pipeline
ESCALATION CASE: Extend tests/ with minimal tests for `icd_mapper_list.py` and `icd_mapper_unique.py` (at least: a latin-1 file and a BOM file produce the expected rows). This would lock in encoding robustness across all scripts, which is where the duplication lives. Risk: low, additive-only.
ESCALATION SUPPORT: esc-001 — short-row recovery has been accepted-then-rejected three times precisely because no test pins the intended behaviour; a fixture row with omitted trailing empties plus an assertion via `get_mapping` would settle it.
ESCALATION DISSENT: none

SUMMARY: Strip BOM and fall back to latin-1 in unique/list mapper file reads
RATIONALE: `icd_mapper_unique.py` opens files as plain UTF-8, so a latin-1 byte makes `process_directory` silently discard the entire file, and `icd_mapper_list.py`'s utf-8-first chain lets a BOM leak into the first row. `icd_mapper.py` already proves the safe strategy (gen-001). Porting that proven decode path to the two siblings is mechanical, byte-identical for clean files, and recovers whole files rather than single rows.

<<<EDIT>>>
FILE: icd_mapper_unique.py
<<<SEARCH>>>
        with open(file_path, 'r', encoding='utf-8') as file:
            header = next(file)
            reader = csv.reader(file, quoting=csv.QUOTE_MINIMAL)
<<<REPLACE>>>
        # utf-8-sig strips a byte order mark; fall back to latin-1 so a
        # single undecodable byte cannot cost us the whole file
        try:
            file = open(file_path, 'r', encoding='utf-8-sig')
        except UnicodeDecodeError:
            file = open(file_path, 'r', encoding='latin-1')
        with file:
            header = next(file)
            reader = csv.reader(file, quoting=csv.QUOTE_MINIMAL)
<<<END>>>

<<<EDIT>>>
FILE: icd_mapper_list.py
<<<SEARCH>>>
        encodings = ['utf-8', 'latin1', 'cp1252']
<<<REPLACE>>>
        encodings = ['utf-8-sig', 'latin1', 'cp1252']
<<<END>>>
```
