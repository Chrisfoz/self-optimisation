# Generation 002 — proposal from `gpt-6-astra` (openai)

Every model asked this generation, not only the one whose proposal was chosen. See attempts.json's fanOut for which one was.

```
SUMMARY: Prevent duplicate mappings during encoding fallback in the list reader
RATIONALE: In `icd_mapper_list.py`, a UTF-8 decoding failure late in a file can occur after mappings have already been appended; retrying as Latin-1 then appends those mappings again. Read the candidate encoding completely before processing any rows, so failed decoding attempts cannot modify the mapping list. This localized change preserves successful-file behavior, intentional duplicates, ordering, and spreadsheet columns without adding dependencies. Verification should include the existing tests and a Latin-1 file with enough ASCII rows to exceed the decoder buffer before an accented descriptor; confirm every input mapping appears exactly once per occurrence (tests were not run here).

<<<EDIT>>>
FILE: icd_mapper_list.py
<<<SEARCH>>>
                with open(file_path, 'r', encoding=encoding) as file:
                    header = next(file)
                    reader = csv.reader(file, quoting=csv.QUOTE_MINIMAL)
<<<REPLACE>>>
                with open(file_path, 'r', encoding=encoding) as file:
                    header = next(file)
                    # Finish decoding before appending: an encoding retry must
                    # not duplicate mappings from a partially decoded file.
                    lines = file.readlines()
                    reader = csv.reader(lines, quoting=csv.QUOTE_MINIMAL)
<<<END>>>

BRIEF FEEDBACK: The source and mapping-integrity constraints helped identify a concrete retry bug. Whole-file buffering increases memory use but matches the primary reader's existing approach. I would delete the conflicting response-format requirements; no implementation constraint needed relaxing.
```
