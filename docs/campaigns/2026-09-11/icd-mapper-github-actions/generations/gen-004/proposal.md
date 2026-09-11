# Generation 004 — proposal

- **Date:** 2026-09-11
- **Scope:** focused — context.ambition is "focused": every generation is a small, localised change
- **Suggested by:** `kimi-k3` (moonshot)
- **Implemented by:** `kimi-k3 (moonshot)` — **the suggesting model wrote its own edits**
- **Reviewed by:** `gpt-5.5`
- **Attempts:** 1
- **Summary:** Harden icd_mapper_unique reads with utf-8-sig and latin-1 fallback
- **Pillar:** 

## Rationale

The unique-codes reader still opens files as plain UTF-8, so a latin-1/cp1252 export — common from the Windows systems coders export from — raises UnicodeDecodeError and process_directory loses every code in that file (worse, codes read before the failing byte stay in the set, unreported). This mirrors the gen-001 fix already rehearsed in icd_mapper.py: decode fully with utf-8-sig, fall back to latin-1, and only then parse rows. The row-processing body is unchanged, so output for well-formed UTF-8 files is byte-identical and no public name or output format moves.

## What the suggesting model said about its own brief

Genuinely helpful: the non-negotiable constraints made the choice obvious once I noticed a sibling reader violating the spirit of constraint 1; the detailed gen-002 failure record (three rejections with reasons) steered me away from a fourth doomed attempt at short-row recovery; and the source dump preserving trailing whitespace made exact-match edits feasible. Constraining for no good reason: the brief hints "the four scripts duplicate a lot of reading logic" but the editable allowlist is exactly those four files and the "create-only pattern" for new files is referenced yet never defined — so the hinted fix is inexpressible; either define the pattern and bless one helper module, or delete the hint. The dual format requirement (SUMMARY/RATIONALE "exactly this format" vs the PILLAR/PROBLEM/… structure) is contradictory on its face — state explicitly that both are expected. I would delete the "files over 500 lines" metric at this scale (pure noise) and the html code fences around source, which add mismatch paranoia with no benefit.

## Files changed

- `icd_mapper_unique.py` (−15/+22 lines)

## The suggestion, verbatim

```
SUMMARY: Harden icd_mapper_unique reads with utf-8-sig and latin-1 fallback
RATIONALE: The unique-codes reader still opens files as plain UTF-8, so a latin-1/cp1252 export — common from the Windows systems coders export from — raises UnicodeDecodeError and process_directory loses every code in that file (worse, codes read before the failing byte stay in the set, unreported). This mirrors the gen-001 fix already rehearsed in icd_mapper.py: decode fully with utf-8-sig, fall back to latin-1, and only then parse rows. The row-processing body is unchanged, so output for well-formed UTF-8 files is byte-identical and no public name or output format moves.

PILLAR: Reader robustness / data preservation — the "never silently lose a mapping" constraint, measured today as edge-case recovery and crash-freedom, applied to the one reader that still has no encoding safety net.

PROBLEM: In icd_mapper_unique.py, `read_mapping_file` does `with open(file_path, 'r', encoding='utf-8') as file:` with no fallback. A single undecodable byte (any latin-1/cp1252 descriptor, e.g. an accented character from a Windows export) raises UnicodeDecodeError; `process_directory` catches it and prints "Error processing {filename}" — every mapping in that file is lost. Worse, because rows are added to `self.unique_icd10am_codes` incrementally as the file streams, a mid-file decode failure leaves a partial set of codes in state with no warning that the file was only half-read. Gen-001 fixed exactly this class of bug in icd_mapper.py (utf-8-sig + latin-1 fallback, decode before parse); the fix was never carried to this sibling reader, so the most harmful divergence in the duplicated reading logic is still live.

CHANGE: Rewrite the body of `ICDMapper.read_mapping_file` in icd_mapper_unique.py to mirror icd_mapper.py exactly: (1) try `open(file_path, 'r', encoding='utf-8-sig')` and `readlines()`; on `UnicodeDecodeError`, re-open with `encoding='latin-1'` and `readlines()`; (2) parse with `csv.reader(lines[1:], quoting=csv.QUOTE_MINIMAL)` (the header line is skipped by slicing, exactly as the discarded `next(file)` skipped it before); (3) keep the row loop body — the `len(row) >= 8` check, the `strip(' "')` calls, the set/dict updates, and both comments — character-identical, only dedented out of the old `with` block. Copy the explanatory comment from icd_mapper.py so the two readers read alike. Decoding now completes before any state mutation, so a failure can never leave partial codes behind.

WHY THIS ONE: Three candidates were weighed. (a) Re-attempting short-row recovery in icd_mapper.py: rejected three times in gen-002 for a fundamental ambiguity — a short row with a present target code cannot be distinguished from one whose mandatory ICD-10-AM descriptor was genuinely truncated — and no new angle exists. (b) Adding skip-warnings to the two sibling readers: a real constraint-gap, but malformed short rows are rarer than non-UTF-8 exports, and losing an entire file is the bigger trust violation. (c) Extracting a shared reader module: the right end-state, but it exceeds "targeted edits" and the create-only pattern for new files is undefined, so it cannot be shipped safely this generation. This change removes the worst remaining divergence (the last reader with no fallback) using a pattern already rehearsed and approved in gen-001, and it makes the future dedup easier by bringing the two readers textually closer. (Noted for a future generation: icd_mapper_list.py's retry loop re-appends the UTF-8-decodable prefix before falling back, silently duplicating codes when a file is mostly ASCII with a few latin-1 bytes.)

RISK: For files without a BOM, utf-8-sig decodes byte-identically to utf-8; a BOM previously landed in the discarded header line, so stripping it changes nothing data-visible. The latin-1 fallback only executes on the code path where the old reader raised, so nothing that previously succeeded can change. Parsing `lines[1:]` is equivalent to parsing the file object after `next(file)`. Public names, method signature, output columns, and report format are untouched. One deliberate edge difference: a completely empty file previously raised StopIteration (reported as "Error processing"); it now succeeds with zero codes — matching icd_mapper.py's existing behaviour. The frozen tests do not import this module; the suite is unaffected.

ALSO UPDATE: Nothing. No other file imports or references icd_mapper_unique's reader; its `main()` and `export_unique_codes` paths are unchanged. icd_mapper_list.py keeps its own encoding loop — harmonising it (and fixing its duplicate-on-retry bug) is a separate future change, not required by this one.

VERIFICATION: 1) Create a .txt mapping export encoded in latin-1 containing a non-ASCII descriptor (e.g. "Anxiété"), call `ICDMapper().read_mapping_file(path)`, and confirm the codes and descriptors are read — before this change that file raised UnicodeDecodeError and lost everything via process_directory. 2) Read the same content as plain UTF-8 and as UTF-8-with-BOM and confirm the resulting unique-code set is identical in all three cases. 3) Regression: on a clean UTF-8 fixture, diff the produced unique_icd10am_codes.xlsx against pre-change output — must be byte-identical in content. 4) `python -m pytest -q tests` stays green.

BRIEF FEEDBACK: Genuinely helpful: the non-negotiable constraints made the choice obvious once I noticed a sibling reader violating the spirit of constraint 1; the detailed gen-002 failure record (three rejections with reasons) steered me away from a fourth doomed attempt at short-row recovery; and the source dump preserving trailing whitespace made exact-match edits feasible. Constraining for no good reason: the brief hints "the four scripts duplicate a lot of reading logic" but the editable allowlist is exactly those four files and the "create-only pattern" for new files is referenced yet never defined — so the hinted fix is inexpressible; either define the pattern and bless one helper module, or delete the hint. The dual format requirement (SUMMARY/RATIONALE "exactly this format" vs the PILLAR/PROBLEM/… structure) is contradictory on its face — state explicitly that both are expected. I would delete the "files over 500 lines" metric at this scale (pure noise) and the html code fences around source, which add mismatch paranoia with no benefit.

ESCALATION: Define the create-only file pattern (or bless one named stdlib helper module) so the triplicated reader logic can be deduplicated as a single focused change.
ESCALATION TARGET: agent-brief
ESCALATION CASE: Blocked today: the brief's own hint says the four scripts duplicate reading logic, but no generation can safely extract a shared reader — the editable allowlist contains only the four scripts and the "create-only pattern" is never defined, so a new module risks rejection at the allowlist gate. What should change: state the permitted new-file pattern explicitly (e.g. "new *.py files at repo root are allowed") or pre-approve one named module such as icd_reader.py. What it unlocks: one focused dedup generation instead of three more per-file harmonisation generations like this one. Risk: widening the writable surface; mitigated by naming exactly one permitted file and keeping the four scripts as thin wrappers over it.
ESCALATION SUPPORT: none
ESCALATION DISSENT: esc-001 — it asks the pipeline to lock short-row recovery (asserting the code is present via get_mapping), but review rejected that recovery three times in gen-002 because a short row cannot be distinguished from one with a genuinely truncated mandatory descriptor; accepting such rows risks silently blanked required fields. The rehearsed, safe behaviour is warn-and-skip, which already satisfies the brief ("reported, not dropped without a word"). Locking "kept" would enshrine behaviour reviewers deemed unsafe; if a test is added, it should assert the warning-and-skip, not the recovery.

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
        # utf-8-sig also strips a byte order mark; fall back to latin-1 so a
        # single undecodable byte cannot cost us the whole file
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
                    self.unique_icd10am_codes.add(icd10am_code)
                    # Store the descriptor (will overwrite if duplicate, which is fine)
                    self.code_descriptors[icd10am_code] = icd10am_descriptor
<<<END>>>
```

## Review

VERDICT: APPROVED

REASON: The focused change preserves parsing/output shape for valid UTF-8 while preventing partial-state failures on undecodable exports by decoding the entire file before processing.

END OF REVIEW
