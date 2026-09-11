# Generation 004 — proposal from `deepseek-v4-pro` (deepseek)

Every model asked this generation, not only the one whose proposal was chosen. See attempts.json's fanOut for which one was.

```
PILLAR: Robustness / recovery of legitimate exports (no silent loss through encoding failures).

PROBLEM: In `icd_mapper_unique.py`, `read_mapping_file` opens only with `encoding='utf-8'`. A Latin-1 or Windows cp1252 export raises `UnicodeDecodeError` at the first non-ASCII byte. `process_directory` catches that error and prints `Error processing <file>`, so every mapping in that file is lost. `icd_mapper.py` already uses `utf-8-sig` with a `latin-1` fallback, and `icd_mapper_list.py` tries multiple encodings; `icd_mapper_unique.py` was left behind.

CHANGE: Modify `ICDMapper.read_mapping_file` in `icd_mapper_unique.py` to loop over `('utf-8-sig', 'latin-1')`, try to read the file with each encoding, and break after the first successful pass. On `UnicodeDecodeError`, continue to the next encoding; if the last encoding is reached, re-raise so `process_directory` still reports the failure. Keep the same row extraction, length checks, and set/dict writes as today so the exported spreadsheet columns are unchanged.

WHY THIS ONE: It fixes a whole class of valid exports for one of the output scripts without touching the contested short-row padding logic; it is a tiny, local change; and it brings `icd_mapper_unique.py` in line with the encoding robustness already present elsewhere. The other candidate, short-row recovery, has a documented history of semantic ambiguity and review rejection; this change is unambiguous.

RISK: Clean UTF-8 files take the same path (`utf-8-sig` behaves like `utf-8`), and BOM files now work. A Latin-1 file may cause the `utf-8-sig` pass to decode part of the file before raising; then the fallback re-reads from scratch and overwrites the same set/dict entries, so no duplicate or incorrect descriptors are exported. Empty files still raise `StopIteration`, caught and reported by `process_directory`, exactly as before. No exported columns change.

ALSO UPDATE: nothing. `excel_to_txt.py` reads an already-produced xlsx, and the other mapper scripts already have their own fallbacks.

VERIFICATION: Create a small `.txt` file with a Latin-1 non-ASCII descriptor and run `python icd_mapper_unique.py` against a directory containing it. Before this change it prints `Error processing ...: 'utf-8' codec can't decode byte ...`; after it prints `Successfully processed ...` and the unique-code export contains the code. Existing `pytest -q tests` still passes because it does not exercise this script and the CSV/column logic is unchanged.

BRIEF FEEDBACK: The exact source snippets and generation history were the most useful; they let me see that `icd_mapper.py` and `icd_mapper_list.py` already handle encodings while `icd_mapper_unique.py` does not, and they warned me away from re-attempting short-row recovery. The limitation of one improvement per generation prevented me from also adding a shared encoding helper across the scripts, which would reduce duplication but would be more than one focus. The frozen tests being append-only is a good backstop, though the measured edge-case names can be slightly misleading because they are not all covered by those tests.

ESCALATION: support esc-001
ESCALATION TARGET: pipeline
ESCALATION CASE: none (supporting existing)
ESCALATION SUPPORT: esc-001 — the characterisation suite has no short-row fixture, so any future short-row recovery can be lost without a red build. Adding a fixture row with fewer than 8 fields and asserting `get_mapping` returns the ICD-10 code would lock the intended 8/8 edge-case behaviour. The risk is low if the row omits only trailing empty columns and expects the same None-for-blank semantics as the existing optional-column test.
ESCALATION DISSENT: none

<<<EDIT>>>
FILE: icd_mapper_unique.py
<<<SEARCH>>>
    def read_mapping_file(self, file_path: str) -> None:
        """Read and process an ICD mapping file."""
        with open(file_path, 'r', encoding='utf-8') as file:
            header = next(file)
            reader = csv.reader(file, quoting=csv.QUOTE_MINIMAL)

            for row in reader:
                if len(row) >= 8:
                    icd10am_code = row[4].strip(' "')
                    icd10am_descriptor = row[7].strip(' "')

                    if icd10am_code:  # Only process if there's a valid code
                        self.unique_icd10am_codes.add(icd10am_code)
                        # Store the descriptor (will overwrite if duplicate, which is fine)
                        self.code_descriptors[icd10am_code] = icd10am_descriptor
<<<REPLACE>>>
    def read_mapping_file(self, file_path: str) -> None:
        """Read and process an ICD mapping file."""
        # utf-8-sig also strips a byte order mark; fall back to latin-1 so
        # a single undecodable byte cannot cost us the whole file.
        for encoding in ('utf-8-sig', 'latin-1'):
            try:
                with open(file_path, 'r', encoding=encoding) as file:
                    header = next(file)
                    reader = csv.reader(file, quoting=csv.QUOTE_MINIMAL)

                    for row in reader:
                        if len(row) >= 8:
                            icd10am_code = row[4].strip(' "')
                            icd10am_descriptor = row[7].strip(' "')

                            if icd10am_code:  # Only process if there's a valid code
                                self.unique_icd10am_codes.add(icd10am_code)
                                # Store the descriptor (will overwrite if duplicate, which is fine)
                                self.code_descriptors[icd10am_code] = icd10am_descriptor
                # Successfully decoded and processed with this encoding; don't try the fallback
                break
            except UnicodeDecodeError:
                if encoding == 'latin-1':
                    raise
<<<END>>>
```
