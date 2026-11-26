"""Synthetic log generator with the exact FabricLoadTest v3 schema (22-column results CSV and 15-column think-times CSV).

Creates, under <output>/logs/, the structure  <prefix>-<model>-c<N>-<YYYYmmdd-HHMMSS>/ ...  read by the
AnalyzeReportPerformance_v3 notebook. Times are simulated (nothing really sleeps). Used by the tests; also handy to try the notebook
without running a real load test.

Scenarios included:
  * SalesModel     : think times + staggered start (ramp_up 20 s, jitter 2 s, recorded pause above the cap), RLS with UPNs,
                     3.3 format (22 columns). Levels 1, 5, 5 (second run, a bit slower), 20.
                     In c20 the CSV of user 19 is missing (with error.log) and there is a failed run folder without any CSV.
  * InventoryModel : no think times (delay_sec only), no RLS (empty effective_username), 3.4 format (status and error columns
                     with a few failed queries). Levels 1, 5, 20.
Usage:  python make_synthetic_logs.py <output_folder> [--seed 7]
"""
from __future__ import annotations

import argparse
import csv
import json
import random
from datetime import datetime, timedelta, timezone
from pathlib import Path

PREFIX = "ramp-v3"
BASE_UTC = datetime(2026, 11, 20, 10, 0, 0, tzinfo=timezone.utc)
RESULT_COLUMNS = ["loadtest_id", "model", "concurrent_threads", "iterations", "delay_sec", "query_number", "visual_name", "visual_id",
                  "iteration", "query", "rows", "duration", "start_time", "start_time_dt", "customdata", "effective_username",
                  "thread_id", "action_index", "source_label", "original_think_time_sec", "scaled_think_time_sec",
                  "applied_think_time_sec"]
THINK_COLUMNS = ["load_test_name", "loadtest_id", "thread_id", "effective_username", "iteration", "action_index", "source_label",
                 "think_time_basis", "original_think_time_sec", "think_time_scale", "scaled_think_time_sec", "applied_think_time_sec",
                 "sleep_start_utc", "sleep_end_utc", "queries_in_action"]
# (action label, queries, recorded pause in seconds)
ACTIONS = [("OpenReport", 5, 0.0), ("PageChange", 5, 6.0), ("SlicerFilter", 5, 3.5),
           ("DrillDown", 5, 15.0), ("CrossHighlight", 5, 4.2), ("DetailPageChange", 5, 7.5)]
VISUALS = [("Sales by region", 0.05, 1), ("Margin by category", 0.08, 10), ("Revenue KPI", 0.12, 25), ("Monthly trend", 0.20, 100),
           ("Product x month matrix", 0.35, 300), ("Store map", 0.50, 1000), ("Top customers", 0.90, 5000),
           ("Order detail", 1.40, 20000), ("Target card", 0.15, 50), ("", 2.20, 100000)]  # the last one has no title


def dax(visual: int, n: int) -> str:
    return (f'EVALUATE\nSUMMARIZECOLUMNS(\n    "Dim{visual}", \'Table\'[Column{visual}],\n'
            f'    "Measure", [Measure{visual}],\n    TREATAS({{"value {n}", "another, with comma"}}, \'Table\'[Filter])\n)')


def _csv_time(epoch: float) -> str:
    return datetime.fromtimestamp(epoch).strftime("%Y-%m-%d %H:%M:%S.%f")


def _iso(epoch: float) -> str:
    return datetime.fromtimestamp(epoch, tz=timezone.utc).isoformat()


def simulate_run(out: Path, model: str, level: int, start: datetime, think: bool, rng: random.Random, *, ramp_up=20.0, init_jitter=2.0,
                 think_scale=1.0, cap=8.0, jitter=0.1, delay=2.0, iterations=2, rls=True, slow=1.0, k_load=0.08, status_format=False,
                 missing_user=None, error_rows=0) -> dict:
    run_name = f"{PREFIX}-{model}"
    loadtest_id = f"{run_name}-c{level}-{start.strftime('%Y%m%d-%H%M%S')}"
    folder = out / loadtest_id
    (folder / "thinktimes").mkdir(parents=True, exist_ok=True)
    seen = set()
    level_factor = (1 + k_load * level) * slow
    total_ok = total_err = users_written = 0
    for thread in range(level):
        user = f"user{thread % 7}@contoso.com" if rls else ""
        user_factor = 2.5 if (rls and thread == 3) else rng.uniform(0.9, 1.1)
        t = start.timestamp() + rng.uniform(0.0, 2.5) + 0.05 * thread           # notebook start (runMultiple cost)
        rows, pauses = [], []
        if think:
            offset = ramp_up * thread / level + (rng.uniform(0, init_jitter) if init_jitter > 0 else 0.0)
            if offset > 0:
                pauses.append({"iteration": -1, "action_index": 0, "source_label": "initial_offset", "think_time_basis": "initial_offset",
                               "original": round(ramp_up * thread / level, 3), "scale": 1.0, "scaled": round(offset, 3),
                               "applied": round(offset, 3), "s0": t, "s1": t + offset + rng.uniform(0.001, 0.01), "n": 0})
                t = pauses[-1]["s1"] + 0.003
        for it in range(iterations):
            qn = 0
            for ai, (label, nq, recorded) in enumerate(ACTIONS, start=1):
                orig = scaled = applied = 0.0
                if think and recorded > 0:
                    orig, scaled = recorded, min(recorded * think_scale, cap)
                    applied = scaled * rng.uniform(1 - jitter, 1 + jitter)
                    end = t + applied + rng.uniform(0.001, 0.02)
                    pauses.append({"iteration": it, "action_index": ai, "source_label": label, "think_time_basis": "previous_group_end",
                                   "original": orig, "scale": think_scale, "scaled": round(scaled, 3), "applied": round(applied, 3),
                                   "s0": t, "s1": end, "n": nq})
                    t = end + 0.003
                for k in range(nq):
                    visual = qn % len(VISUALS)
                    name, base, rows_base = VISUALS[visual]
                    qhash = (visual, qn // len(VISUALS))
                    cache = 1.6 if qhash not in seen else 1.0
                    seen.add(qhash)
                    duration = base * level_factor * user_factor * cache * rng.lognormvariate(0, 0.25)
                    failed = status_format and error_rows > 0 and rng.random() < 0.02 and total_err < error_rows
                    n_rows = 0 if failed else max(1, int(rows_base * rng.uniform(0.8, 1.2) / (7 if rls and thread % 7 else 1)))
                    row = {"loadtest_id": loadtest_id, "model": model, "concurrent_threads": level, "iterations": iterations,
                           "delay_sec": delay, "query_number": qn + 1, "visual_name": name, "visual_id": f"{visual:02d}c1a5e0b7d94f",
                           "iteration": it, "query": dax(visual, qn), "rows": n_rows,
                           "duration": round(0.05 if failed else duration, 6), "start_time": round(t, 6), "start_time_dt": _csv_time(t),
                           "customdata": "", "effective_username": user, "thread_id": thread, "action_index": ai, "source_label": label,
                           "original_think_time_sec": orig if k == 0 else 0.0, "scaled_think_time_sec": round(scaled, 3) if k == 0 else 0.0,
                           "applied_think_time_sec": round(applied, 3) if k == 0 else 0.0}
                    if status_format:
                        row["status"] = "error" if failed else "ok"
                        row["error"] = ("AdomdErrorResponseException: Query (1, 10) Failed to resolve name 'Table[Missing]'." if failed else "")
                        total_err += 1 if failed else 0
                    rows.append(row)
                    total_ok += 0 if failed else 1
                    t += row["duration"] + 0.004
                    if not think:
                        t += delay                                              # delay_sec after every query
                    qn += 1
            t += delay                                                          # delay_sec at the end of every iteration
        if missing_user is not None and thread == missing_user:
            total_ok -= len(rows)                                               # a virtual user that failed: it writes no CSV
            continue
        columns = RESULT_COLUMNS + (["status", "error"] if status_format else [])
        with open(folder / f"{loadtest_id}_user_{thread}.csv", "w", newline="", encoding="utf-8") as fh:
            writer = csv.DictWriter(fh, fieldnames=columns)
            writer.writeheader()
            writer.writerows(rows)
        users_written += 1
        if pauses:
            with open(folder / "thinktimes" / f"{loadtest_id}_user_{thread}_thinktimes.csv", "w", newline="", encoding="utf-8") as fh:
                writer = csv.DictWriter(fh, fieldnames=THINK_COLUMNS)
                writer.writeheader()
                for p in pauses:
                    writer.writerow({"load_test_name": run_name, "loadtest_id": loadtest_id, "thread_id": thread, "effective_username": user,
                                     "iteration": p["iteration"], "action_index": p["action_index"], "source_label": p["source_label"],
                                     "think_time_basis": p["think_time_basis"], "original_think_time_sec": p["original"],
                                     "think_time_scale": p["scale"], "scaled_think_time_sec": p["scaled"],
                                     "applied_think_time_sec": p["applied"], "sleep_start_utc": _iso(p["s0"]),
                                     "sleep_end_utc": _iso(p["s1"]), "queries_in_action": p["n"]})
    if missing_user is not None:
        (folder / "error.log").write_text(
            f"Data Source=powerbi://api.powerbi.com/v1.0/myorg/Synthetic;Initial Catalog={model};Timeout=7200;"
            f"EffectiveUserName=user{missing_user % 7}@contoso.com;  : Timeout expired while executing the query\n", encoding="utf-8")
    if not any((folder / "thinktimes").iterdir()):
        (folder / "thinktimes").rmdir()                                         # the tool only creates it when there were pauses
    return {"loadtest_id": loadtest_id, "model": model, "level": level, "users_written": users_written,
            "rows_ok": total_ok, "rows_failed": total_err, "think": think}


def generate(out_dir: Path, seed: int = 7) -> dict:
    rng = random.Random(seed)
    logs = out_dir / "logs"
    logs.mkdir(parents=True, exist_ok=True)
    runs = []
    # failed run: only error.log, no CSV at all (four minutes before the first one)
    failed = logs / f"{PREFIX}-SalesModel-c20-{(BASE_UTC - timedelta(minutes=4)).strftime('%Y%m%d-%H%M%S')}"
    failed.mkdir(parents=True, exist_ok=True)
    (failed / "error.log").write_text("Authentication failed for all authenticators: user2@contoso.com\n"
                                      "Load test failed before any virtual user started\n", encoding="utf-8")
    plan = [(1, 0, 1.0), (5, 300, 1.0), (5, 600, 1.15), (20, 900, 1.0)]
    for level, shift, slow in plan:
        runs.append(simulate_run(logs, "SalesModel", level, BASE_UTC + timedelta(seconds=shift), True, rng, slow=slow, k_load=0.08,
                                 missing_user=19 if level == 20 else None))
    for level, shift in [(1, 20), (5, 320), (20, 920)]:
        runs.append(simulate_run(logs, "InventoryModel", level, BASE_UTC + timedelta(seconds=shift), False, rng, delay=1.0, rls=False,
                                 k_load=0.01, status_format=True, error_rows=4 if level == 20 else 0))
    manifest = {"logs": str(logs), "runs": runs, "failed_folder": failed.name}
    (out_dir / "manifest.json").write_text(json.dumps(manifest, indent=1), encoding="utf-8")
    return manifest


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("output", type=Path)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    m = generate(args.output, args.seed)
    print(f"{len(m['runs'])} runs with CSV, {sum(r['rows_ok'] + r['rows_failed'] for r in m['runs'])} queries in {m['logs']}")
