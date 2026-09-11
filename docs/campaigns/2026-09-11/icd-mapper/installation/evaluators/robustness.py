"""Data robustness probe for icd_mapper.py: feed the reader the awkward but
legitimate inputs real mapping exports contain, and count how many of their
rows survive. Prints one JSON object. Run by evaluators/robustness.mjs."""

import io
import json
import os
import sys
import tempfile
import contextlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)
from icd_mapper import ICDMapper  # noqa: E402

HEADER = '"Counter","ICD-10 code","WHO update 1=Add 2=Del","ICD-10 code descriptor","ICD-10-AM Map","Aust update 1=Add 2=Del","Additive Map (+)","ICD-10-AM code descriptor"'
ROW = '1,"A00.0",,"Example condition","A00.0",,,"Example condition"'

# name -> (file bytes, the ICD-10 code that should be readable afterwards)
CASES = {
    "plain utf-8": ((HEADER + "\n" + ROW + "\n").encode("utf-8"), "A00.0"),
    "utf-8 with BOM": (("﻿" + HEADER + "\n" + ROW + "\n").encode("utf-8"), "A00.0"),
    "windows line endings": ((HEADER + "\r\n" + ROW + "\r\n").encode("utf-8"), "A00.0"),
    "latin-1 descriptor": ((HEADER + "\n" + '1,"A00.0",,"Syndrome de Löfgren","A00.0",,,"Syndrome de Löfgren"' + "\n").encode("latin-1"), "A00.0"),
    "unquoted code with padding": ((HEADER + "\n" + '1, A00.0 ,,"Example","A00.0",,,"Example"' + "\n").encode("utf-8"), "A00.0"),
    "row missing trailing empty columns": ((HEADER + "\n" + '1,"A00.0",,"Example","A00.0"' + "\n").encode("utf-8"), "A00.0"),
    "blank line between rows": ((HEADER + "\n\n" + ROW + "\n").encode("utf-8"), "A00.0"),
    "extra trailing column": ((HEADER + "\n" + ROW + ',"extra"' + "\n").encode("utf-8"), "A00.0"),
}


def main():
    recovered, crashed, details = 0, 0, []
    with tempfile.TemporaryDirectory() as tmp:
        for name, (data, code) in CASES.items():
            path = os.path.join(tmp, "case.txt")
            with open(path, "wb") as f:
                f.write(data)
            m = ICDMapper()
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    m.read_mapping_file(path)
                ok = bool(m.get_mapping(code))
                recovered += ok
                details.append(f"{name}: {'ok' if ok else 'row silently dropped'}")
            except Exception as e:  # noqa: BLE001 — a crash is the measurement
                crashed += 1
                details.append(f"{name}: crashed ({type(e).__name__})")
    print(json.dumps({"total": len(CASES), "recovered": recovered, "crashed": crashed, "details": details}))


if __name__ == "__main__":
    main()
