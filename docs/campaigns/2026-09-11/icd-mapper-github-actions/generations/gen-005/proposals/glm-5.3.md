# Generation 005 — proposal from `glm-5.3` (zai)

Every model asked this generation, not only the one whose proposal was chosen. See attempts.json's fanOut for which one was.

```
PILLAR: edge-case recovery (encoding robustness across sibling scripts)

PROBLEM: `icd_mapper_list.py` tries encodings `['utf-8', 'latin1', 'cp1252']` — plain `utf-8`, not `utf-8-sig`. A UTF-8 file with a BOM (common from Windows exports) decodes "successfully" but the first cell of the header — and worse, nothing downstream — actually the header row is consumed via `next(file)`, so the BOM taints nothing critical... but the real hazard: a BOM before the first data line is consumed as part of the header only if the BOM is on line 1, which it is, so the header absorbs it. However the sibling `icd_mapper.py` (gen-001) and `icd_mapper_unique.py` (gen-004) use `utf-8-sig` with latin-1 fallback; `icd_mapper_list.py` is now the odd one out, and its multi-encoding loop re-reads nothing — actually a subtler bug: if the file decodes fine under plain `utf-8` but a later row raises `UnicodeDecodeError` mid-iteration, the codes already appended in that partial pass **stay in the list**, and the retry pass appends them again — producing duplicate rows in the Excel export. The gen-004 rationale explicitly called out this partial-read hazard in the unique script; the list script still has it.

CHANGE: In `icd_mapper_list.py` only, replace the per-encoding streaming loop in `read_mapping_file` with the decode-fully-then-parse pattern already proven in `icd_mapper.py`: open with `encoding='utf-8-sig'`, read all lines; on `UnicodeDecodeError`, reopen with `encoding='latin-1'` and read all lines. Then take `header = lines[:1]` and run `csv.reader(lines[1:])` over the fully-decoded content. The row body (fields, `strip(' "')`, append logic) is unchanged. This both strips a BOM and guarantees no partial append before a decode failure — a decode error now happens before any row is processed, so no duplicates from a re-read pass.

WHY THIS ONE: Beats continuing the per-script harmonisation elsewhere because it fixes two defects at once (BOM handling and duplicate-on-partial-decode) in one localised edit using a pattern already rehearsed and approved twice (gen-001, gen-004). It also reduces source size slightly. The short-row recovery angle is deliberately left alone — review rejected it three times in gen-002 and esc-001 reflects that dispute.

RISK: Low. For clean UTF-8 files the parsed rows are byte-identical (utf-8-sig is utf-8 plus BOM stripping; header handling is equivalent). For latin-1/cp1252 files, latin-1 decodes everything so behaviour matches the old fallback outcome without the partial-append bug. Output columns and all public names unchanged; tests only touch `icd_mapper.py`.

ALSO UPDATE: nothing — the file is self-contained and no other script calls it.

VERIFICATION: Run the tool against (a) a plain UTF-8 export, (b) a UTF-8-BOM export, (c) a latin-1 export with a stray undecodable byte in the middle of the file: confirm (a)/(b) produce identical spreadsheets and (c) processes cleanly with each row appearing exactly once, no duplicates from a partial first pass.

BRIEF FEEDBACK: The frozen-tests list and the measured edge-case dimensions genuinely helped me pick a change that is safe and observable. The create-only pattern being undefined (esc-004) is the worst constraint — four scripts duplicate reader logic and every generation must hand-copy the same fix instead of extracting one helper; I back esc-004. I would delete nothing else; the "one improvement" rule was useful discipline here.

ESCALATION: back esc-004 — pre-approve a named shared reader module so this harmonisation stops being three copy-paste generations.

ESCALATION TARGET: agent-brief

ESCALATION CASE: none (backing existing)

ESCALATION SUPPORT: esc-004 — I just re-implemented, for the third time, the same decode pattern three files need; esc-003 (sibling-script tests) would also have caught this class sooner.

ESCALATION DISSENT: none — though I side with kimi-k3's argument against esc-001: locking short-row "recovery" into tests would enshrine behaviour review rejected as unsafe; warn-and-skip is correct.

SUMMARY: Decode list-script exports fully with utf-8-sig/latin-1 to fix BOM and partial-read duplicates

RATIONALE: icd_mapper_list.py is the last reader without BOM stripping, and its streaming multi-encoding loop appends rows before a mid-file decode failure and again on retry, duplicating rows in the export. Reading all lines with utf-8-sig then falling back to latin-1 — the pattern already approved for the other two scripts — fixes both with one localised edit; row processing and output are unchanged for well-formed UTF-8 files.

<<<EDIT>>>
FILE: icd_mapper_list.py
<<<SEARCH>>>
        """Read and process an ICD mapping file."""
        # Try different encodings
        encodings = ['utf-8', 'latin1', 'cp1252']
        
        for encoding in encodings:
            try:
                with open(file_path, 'r', encoding=encoding) as file:
                    header = next(file)
                    reader = csv.reader(file, quoting=csv.QUOTE_MINIMAL)
                    
                    for row in reader:
                        if len(row) >= 8:
                            icd10am_code = row[4].strip(' "')
                            icd10am_descriptor = row[7].strip(' "')
                            
                            if icd10am_code:  # Only process if there's a valid code
                                self.icd10am_codes.append({
                                    'ICD-10-AM Code': icd10am_code,
                                    'ICD-10-AM Descriptor': icd10am_descriptor
                                })
                # If we successfully read the file, break the loop
                break
            except UnicodeDecodeError:
                if encoding == encodings[-1]:  # If this was the last encoding to try
                    raise  # Re-raise the exception
                continue  # Try the next encoding
<<<REPLACE>>>
        """Read and process an ICD mapping file."""
        # utf-8-sig also strips a byte order mark; decode the whole file up
        # front (falling back to latin-1) so a mid-file decode error cannot
        # leave a partial pass of rows already appended, which a retry would
        # then duplicate
        try:
            with open(file_path, 'r', encoding='utf-8-sig') as file:
                lines = file.readlines()
        except UnicodeDecodeError:
            with open(file_path, 'r', encoding='latin-1') as file:
                lines = file.readlines()
        
        reader = csv.reader(lines[1:], quoting=csv.QUOTE_MINIMAL)
        
        for row in reader:
            if len(row) >= 8:
                icd10am_code = row[4].strip(' "')
                icd10am_descriptor = row[7].strip(' "')
                
                if icd10am_code:  # Only process if there's a valid code
                    self.icd10am_codes.append({
                        'ICD-10-AM Code': icd10am_code,
                        'ICD-10-AM Descriptor': icd10am_descriptor
                    })
<<<END>>>
```
