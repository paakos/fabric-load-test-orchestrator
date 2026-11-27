"""Tests of AnalyzeReportPerformance_v3: every cell is executed locally (DuckDB + matplotlib, Agg backend) over synthetic logs
with the exact schema written by RunScenario_v3 (tools/make_synthetic_logs.py)."""
import contextlib
import io
import json

import pytest

pd = pytest.importorskip("pandas")
pytest.importorskip("duckdb")
matplotlib = pytest.importorskip("matplotlib")
matplotlib.use("Agg")
import matplotlib.pyplot as plt  # noqa: E402

import make_synthetic_logs as synthetic
from helpers import NOTEBOOKS, load_notebook

NOTEBOOK = load_notebook(NOTEBOOKS / "AnalyzeReportPerformance_v3.ipynb")
CODE_CELLS = [c for c in NOTEBOOK["cells"] if c["cell_type"] == "code"]


@pytest.fixture(scope="module")
def manifest(tmp_path_factory):
    return synthetic.generate(tmp_path_factory.mktemp("synthetic"), seed=7)


@pytest.fixture(autouse=True)
def no_figures(monkeypatch):
    monkeypatch.setattr(plt, "show", lambda *a, **k: plt.close("all"))


def run_notebook(logs, overrides=None, extra=None):
    """Runs all code cells. `overrides` plays the role of the parameters cell injected by Fabric."""
    namespace = {"__name__": "__main__", "display": lambda frame: None, **(extra or {})}
    output = io.StringIO()
    with contextlib.redirect_stdout(output):
        for index, cell in enumerate(CODE_CELLS):
            exec(compile("".join(cell["source"]), f"cell-{index}", "exec"), namespace)
            if "parameters" in cell["metadata"].get("tags", []):
                namespace["LOGS"] = str(logs)
                namespace.update(overrides or {})
    return namespace, output.getvalue()


def run_id(manifest, model, level):
    return next(r["loadtest_id"] for r in manifest["runs"] if r["model"] == model and r["level"] == level)


def test_notebook_structure():
    sources = "".join("".join(c["source"]) for c in NOTEBOOK["cells"])
    tagged = [c for c in CODE_CELLS if "parameters" in c["metadata"].get("tags", [])]
    assert len(tagged) == 1
    assert all(c["outputs"] == [] and c["execution_count"] is None for c in CODE_CELLS)
    assert "onmicrosoft" not in sources.lower() and "dependencies" not in NOTEBOOK["metadata"]
    headers = ["".join(c["source"]).split(" ·")[0] for c in NOTEBOOK["cells"]
               if c["cell_type"] == "markdown" and "".join(c["source"]).startswith("## Q")]
    assert headers == [f"## Q{n:02d}" for n in range(1, 21)]


def test_full_run_over_mixed_formats(manifest):
    from pathlib import Path
    ns, out = run_notebook(manifest["logs"])
    results = ns["RESULTS"]
    ok_rows = sum(r["rows_ok"] for r in manifest["runs"])
    failed_rows = sum(r["rows_failed"] for r in manifest["runs"])
    assert ns["ERRORS"] == {}
    assert "No data for" not in out
    assert ns["HAS_STATUS"] and ns["HAS_PAUSES"] and ns["HAS_OFFSETS"]

    q01 = results["Q01"]
    assert int(q01.queries.sum()) == ok_rows
    assert int(q01.failed_queries.sum()) == failed_rows
    assert int(q01[(q01.model == "SalesModel") & (q01.level == 20)].users_without_results.iloc[0]) == 1
    assert set(results["Q02"].state) - {"OK"}

    q11 = results["Q11"]
    assert (q11.state == "Atypical").any()
    assert q11.user_key.str.startswith("user_").any() and not q11.user_key.str.contains("@").any()

    q13 = results["Q13"]
    assert ((q13.unexplained_overhead_s / q13.wall_s) < 0.05).all()
    q14 = results["Q14"]
    assert len(q14) == 4 and (q14.pauses_capped > 0).all() and (q14.mean_gap_offset_s.abs() < 0.1).all()
    q16 = results["Q16"]
    assert (q16.peak_queries <= q16.peak_users).all() and (q16.mean_queries_in_flight < q16.nominal_level).all()

    q19 = results["Q19"].set_index("run_id")
    assert q19.loc[manifest["failed_folder"], "diagnosis"] == "failed run: no CSV at all"
    sales20 = q19.loc[run_id(manifest, "SalesModel", 20)]
    assert sales20.diagnosis == "virtual users are missing" and sales20.csv_users == 19
    assert "@" not in "".join(q19.first_error)
    assert int(q19.loc[run_id(manifest, "InventoryModel", 20), "failed_queries"]) == 4

    q20 = results["Q20"]
    total = q20[q20.visual_label.str.startswith("TOTAL")]
    assert len(total) == 1 and float(total.delta_pct.iloc[0]) > 5     # the second SalesModel c5 run is ~15 % slower
    assert any(a.startswith("[Q19]") for a in ns["ALERTS"]) and any(a.startswith("[Q01]") for a in ns["ALERTS"])
    assert Path(manifest["logs"]).exists()


def test_model_without_think_times(manifest):
    ns, out = run_notebook(manifest["logs"], {"MODELS": ["InventoryModel"]})
    assert ns["ERRORS"] == {} and ns["HAS_PAUSES"] is False
    assert "No data for Q14" in out and "No data for Q20" in out
    assert len(ns["RESULTS"]["Q13"]) == 3 and len(ns["RESULTS"]["Q15"]) > 0
    assert ns["RESULTS"]["Q11"].user_key.str.startswith("no_rls_thread_").all()


def test_single_model_and_level(manifest):
    ns, _ = run_notebook(manifest["logs"], {"MODELS": ["SalesModel"], "LEVELS": [5], "FOCUS_LEVEL": 5})
    assert ns["ERRORS"] == {} and len(ns["RESULTS"]["Q20"]) > 0


def test_run_ids_and_unmasked_upn(manifest):
    run = run_id(manifest, "SalesModel", 5)
    ns, _ = run_notebook(manifest["logs"], {"RUN_IDS": [run], "MASK_UPN": False})
    assert ns["ERRORS"] == {}
    assert set(ns["RESULTS"]["Q01"].run_id) == {run} and len(ns["RESULTS"]["Q19"]) == 1
    assert ns["RESULTS"]["Q11"].user_key.str.contains("@").any()


def test_filters_without_rows_do_not_break(manifest):
    ns, out = run_notebook(manifest["logs"], {"SINCE_UTC": "2999-01-01T00:00:00Z"})
    assert ns["ERRORS"] == {} and out.count("No data for") >= 17


def test_folder_without_csv_files_fails_clearly(tmp_path):
    with pytest.raises(Exception, match="No result CSV files"):
        run_notebook(tmp_path / "empty")


def test_json_export_is_the_contract_of_the_fabric_app(manifest, tmp_path):
    import json
    ns, out = run_notebook(manifest["logs"], {"EXPORT_JSON": True, "EXPORT_ROOT": str(tmp_path), "ANALYSIS_ID": "analysis-1"})
    folder = tmp_path / "analysis-1"
    doc = json.loads((folder / "manifest.json").read_text(encoding="utf-8"))
    assert ns["ERRORS"] == {} and "Exported" in out
    assert doc["notebook"] == "AnalyzeReportPerformance_v3" and doc["analysis_id"] == "analysis-1"
    assert [q["id"] for q in doc["queries"]] == [f"Q{n:02d}" for n in range(1, 21)]
    assert {q["block"] for q in doc["queries"]} == set("ABCDEF")
    assert doc["alerts"] and all({"query", "severity", "text"} <= set(a) for a in doc["alerts"])
    assert any(a["model"] == "SalesModel" and isinstance(a["level"], int) for a in doc["alerts"])
    assert all(a["model"] for a in doc["alerts"] if a["query"] == "Q07"), "alerts of the form 'Model: text' also carry the model"
    for q in doc["queries"]:
        assert q["status"] in ("ok", "no_data") and (q["status"] == "ok") == bool(q["file"])
        if q["status"] != "ok":
            continue
        rows = json.loads((folder / q["file"]).read_text(encoding="utf-8"))
        assert len(rows) == q["rows"] == len(ns["RESULTS"][q["id"]])
        columns = {c["name"] for c in q["columns"]}
        chart = q["chart"]
        used = [v for key, value in chart.items() if key in ("x", "y", "bars", "lines", "series", "group_by", "label", "value", "marker", "color",
                                                              "rows", "cols", "size") for v in ([value] if isinstance(value, str) else value or [])]
        assert set(used) <= columns, (q["id"], set(used) - columns)
    assert not any("@" in p.read_text(encoding="utf-8") for p in folder.iterdir())


def test_typed_notebook_parameters_accept_list_text(manifest):
    """Fabric notebook parameters are scalars: the app passes lists as JSON text or comma-separated text."""
    run = run_id(manifest, "SalesModel", 5)
    ns, _ = run_notebook(manifest["logs"], {"MODELS": "SalesModel, InventoryModel", "LEVELS": "5,20", "RUN_IDS": json.dumps([run]),
                                            "SINCE_UTC": "", "FOCUS_LEVEL": "", "BASELINE_RUN": ""})
    assert ns["ERRORS"] == {} and ns["MODELS"] == ["SalesModel", "InventoryModel"] and ns["LEVELS"] == [5, 20] and ns["SINCE_UTC"] is None
    assert set(ns["RESULTS"]["Q01"].run_id) == {run}


def test_without_export_nothing_is_written(manifest, tmp_path):
    ns, out = run_notebook(manifest["logs"], {"EXPORT_ROOT": str(tmp_path)})
    assert "EXPORT_JSON = False" in out and list(tmp_path.iterdir()) == []


def test_delta_persistence_overwrites_without_duplicates(manifest, tmp_path):
    pytest.importorskip("deltalake")
    pytest.importorskip("pyarrow")
    from deltalake import DeltaTable
    overrides, extra = {"SAVE_TO_TABLES": True}, {"TABLES_ROOT": str(tmp_path)}
    ns, _ = run_notebook(manifest["logs"], overrides, extra)
    assert ns["ERRORS"] == {}
    table = tmp_path / "perf_q01_executive_summary"
    first = DeltaTable(str(table)).to_pandas()
    assert len(first) == len(ns["RESULTS"]["Q01"]) and "p90_s" in first.columns
    assert len(list(tmp_path.iterdir())) >= 17
    run_notebook(manifest["logs"], overrides, extra)
    assert len(DeltaTable(str(table)).to_pandas()) == len(first)
