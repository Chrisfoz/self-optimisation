# Generation 005 — proposal from `deepseek-v4-pro` (deepseek)

Every model asked this generation, not only the one whose proposal was chosen. See attempts.json's fanOut for which one was.

```
PILLAR: Data integrity — no silent loss of unreadable mapping rows
PROBLEM: In `icd_mapper_list.py` and `icd_mapper_unique.py`, short rows are silently ignored because the guard is `if len(row) >= 8:`. A nonblank row with omitted trailing empty columns vanishes without any message, violating the brief's rule that unreadable rows must be reported. `icd_mapper.py` already warns for this case, but its warning uses `reader.line_num`, which is off by one because `readlines()[1:]` discards the header before the csv reader starts counting.
CHANGE: Make all three mapping readers use the same warn-and-skip rule. In each row loop: skip only blank lines (`if not row or not any(field.strip() for field in row): continue`), then if `len(row) < 8`, print a warning with the source file basename, the actual file line (`reader.line_num + 1`), and the expected/found field counts, then continue. In `icd_mapper.py`, change the existing warning line to use `reader.line_num + 1` as well. Well-formed rows are processed exactly as before.
WHY THIS ONE: The measured edge-case table names "row missing trailing empty columns: row silently dropped" as the remaining silent-loss case. This fixes the silent part without attempting to recover ambiguous short rows, which gen-002 showed is unsafe because a short row cannot be distinguished from a truncated mandatory descriptor.
RISK: The change only adds diagnostics and corrects a diagnostic line count. It does not alter parsing, column names, report text, or spreadsheet columns. Well-formed files produce byte-identical outputs, and blank lines remain intentionally silent. The `line_num + 1` offset is correct for both `readlines()[1:]` (in `icd_mapper.py`) and `next(file)` before a csv reader (in the other two scripts).
ALSO UPDATE: The three mapping readers must change together: `icd_mapper.py` (line offset), `icd_mapper_list.py` (add warning), and `icd_mapper_unique.py` (add warning). `excel_to_txt.py` never reads mapping files, so nothing changes there.
VERIFICATION: Run a fixture with a nonblank 7-field row through `read_mapping_file` for each reader; expect one warning per reader and no code added/appended for that row. Run `python -m pytest -q tests`; the frozen invariants still pass, and a well-formed 8-column export gives identical report/Excel output.
BRIEF FEEDBACK: The frozen-test list and non-gating metrics made the silent-loss gap obvious, and the rejection history for gen-002 steered me away from unsafe short-row recovery. The unresolved create-only pattern is the biggest constraint: the obvious deduplication fix stays illegal until that is defined. I would delete or clarify the "one improvement" ambiguity when one logical improvement touches three files.
ESCALATION: none
ESCALATION TARGET: pipeline
ESCALATION CASE: supporting esc-003, no new case opened.
ESCALATION SUPPORT: esc-003 — this generation changes `icd_mapper_list.py` and `icd_mapper_unique.py`, exactly the sibling scripts the test suite does not cover; a regression there would pass CI unnoticed.
ESCALATION DISSENT: none

<<<EDIT>>>
FILE: icd_mapper.py
<<<SEARCH>>>
                print(f"Warning: {os.path.basename(file_path)} data row {reader.line_num}: "
                      f"expected 8 fields, found {len(row)} - row skipped")
<<<REPLACE>>>
                print(f"Warning: {os.path.basename(file_path)} data row {reader.line_num + 1}: "
                      f"expected 8 fields, found {len(row)} - row skipped")
<<<END>>>

<<<EDIT>>>
FILE: icd_mapper_list.py
<<<SEARCH>>>
                    for row in reader:
                        if len(row) >= 8:
                            icd10am_code = row[4].strip(' "')
                            icd10am_descriptor = row[7].strip(' "')
                            
                            if icd10am_code:  # Only process if there's a valid code
                                self.icd10am_codes.append({
                                    'ICD-10-AM Code': icd10am_code,
                                    'ICD-10-AM Descriptor': icd10am_descriptor
                                })
<<<REPLACE>>>
                    for row in reader:
                        if not row or not any(field.strip() for field in row):
                            continue  # blank line
                        if len(row) < 8:
                            print(f"Warning: {os.path.basename(file_path)} data row "
                                  f"{reader.line_num + 1}: expected 8 fields, found {len(row)} - row skipped")
                            continue
                        icd10am_code = row[4].strip(' "')
                        icd10am_descriptor = row[7].strip(' "')
                        
                        if icd10am_code:  # Only process if there's a valid code
                            self.icd10am_codes.append({
                                'ICD-10-AM Code': icd10am_code,
                                'ICD-10-AM Descriptor': icd10am_descriptor
                            })
<<<END>>>

<<<EDIT>>>
FILE: icd_mapper_unique.py
<<<SEARCH>>>
            for row in reader:
                if len(row) >= 8:
                    icd10am_code = row[4].strip(' "')
                    icd10am_descriptor = row[7].strip(' "')
                    
                    if icd10am_code:  # Only process if there's a valid code
                        self.unique_icd10am_codes.add(icd10am_code)
                        # Store the descriptor (will overwrite if duplicate, which is fine)
                        self.code_descriptors[icd10am_code] = icd10am_descriptor
<<<REPLACE>>>
            for row in reader:
                if not row or not any(field.strip() for field in row):
                    continue  # blank line
                if len(row) < 8:
                    print(f"Warning: {os.path.basename(file_path)} data row "
                          f"{reader.line_num + 1}: expected 8 fields, found {len(row)} - row skipped")
                    continue
                icd10am_code = row[4].strip(' "')
                icd10am_descriptor = row[7].strip(' "')
                
                if icd10am_code:  # Only process if there's a valid code
                    self.unique_icd10am_codes.add(icd10am_code)
                    # Store the descriptor (will overwrite if duplicate, which is fine)
                    self.code_descriptors[icd10am_code] = icd10am_descriptor
<<<END>>>
```
