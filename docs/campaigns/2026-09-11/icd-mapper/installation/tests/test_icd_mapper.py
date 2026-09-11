"""Characterisation tests for icd_mapper.py — what the tool does today, on a
synthetic fixture in the real column layout. Written when the harness was
installed; frozen to the agent (it may not edit tests/)."""

import os
import sys

import pytest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

from icd_mapper import ICDMapper  # noqa: E402

FIXTURE = os.path.join(ROOT, "tests", "fixtures", "sample_map.txt")


@pytest.fixture
def mapper():
    m = ICDMapper()
    m.read_mapping_file(FIXTURE)
    return m


def test_every_icd10_code_in_the_fixture_is_read(mapper):
    assert sorted(mapper.mappings) == ["A00.0", "A00.1", "B20", "C10"]


def test_one_to_many_keeps_every_target_in_file_order(mapper):
    targets = [m["icd10am_code"] for m in mapper.get_mapping("B20")]
    assert targets == ["B20.0", "B20.9"]


def test_quoted_descriptor_keeps_its_comma(mapper):
    assert mapper.get_mapping("A00.0")[0]["icd10_descriptor"] == "Example condition, first variant"


def test_optional_columns_become_none_when_blank(mapper):
    first = mapper.get_mapping("A00.0")[0]
    assert first["who_update"] is None and first["aus_update"] is None and first["additive_map"] is None
    assert mapper.get_mapping("B20")[0]["additive_map"] == "B20.1"
    assert mapper.get_mapping("B20")[0]["who_update"] == "1"


def test_unknown_code_is_none(mapper):
    assert mapper.get_mapping("Z99.9") is None


def test_report_lists_each_code_its_targets_and_additive_maps(mapper, tmp_path):
    out = tmp_path / "report.txt"
    mapper.generate_mapping_report(str(out))
    text = out.read_text(encoding="utf-8")
    assert text.startswith("ICD-10 to ICD-10-AM Mapping Report")
    assert "ICD-10 Code: B20" in text
    assert "- B20.0: Example infection with complication" in text
    assert "  Additive Map: B20.1" in text


def test_excel_export_has_one_row_per_mapping(mapper, tmp_path):
    pd = pytest.importorskip("pandas")
    out = tmp_path / "map.xlsx"
    mapper.export_to_excel(str(out))
    df = pd.read_excel(out)
    assert len(df) == 5
    assert list(df.columns)[:3] == ["ICD-10 Code", "ICD-10 Descriptor", "ICD-10-AM Code"]


def test_process_directory_reads_only_txt_files(tmp_path):
    (tmp_path / "a.txt").write_text(open(FIXTURE, encoding="utf-8").read(), encoding="utf-8")
    (tmp_path / "ignored.csv").write_text("not a mapping", encoding="utf-8")
    m = ICDMapper()
    m.process_directory(str(tmp_path))
    assert "B20" in m.mappings
