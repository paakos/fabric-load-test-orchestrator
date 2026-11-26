# Analyzing the results

`notebooks/AnalyzeLoadTest_v3.ipynb` reads the CSV files that the tests wrote under `Files/PerfScenarios/logs/` with DuckDB.
It does not start tests and does not copy data. Attach, as its default lakehouse, the lakehouse where the tests wrote their results.

Parameters (first code cell): `LOGS`, `RUN_PREFIX` (= `test_name_prefix` of the pipeline, default `ramp-v3`) and
`SINCE_UTC` (ignore earlier runs, for example `"2026-10-28T10:00:00Z"`).

| # | Question it answers | What to look for |
|---|---|---|
| 1 | Which runs exist? | One row per model and level; `users_ok = true` (distinct users = level); `failed_queries` = 0 |
| 2 | Was the ramp sequential? | `OK: sequential`: each level started after the previous level of the same model ended |
| 3 | Real concurrency and start window | `peak_concurrent` close to `users`; `start_window_s` ≈ `ramp_up_sec × (N−1)/N` |
| 4 | Was every query executed? | Same number of queries and actions for every user and iteration |
| 5 | Think times recorded vs applied | `applied_to_original_ratio` ≈ `think_time_scale` (± jitter and cap); one pause per action |
| 6 | **Did the users really wait?** | `avg_actual_pause_s` ≈ `avg_applied_pause_s`; small `avg_deviation_s` |
| 7 | One user, action by action | The scenario as replayed, with applied and measured pauses |
| 8 | Latency per level | Failed queries and error rate; mean, p50, p90, p95 and max duration of the **successful** queries per model and level |
| 9 | Were the models parallel? | `overlap_s > 0` between models |

## Without the notebook: `summary.json`

Every run folder also has a `summary.json` (the exit value of `RunLoadTest_v3`) with the percentiles of the successful queries,
the failed queries and the virtual users that were lost. See [architecture.md](architecture.md#run-summary-and-exit-value).
With `write_results_to_tables = true` the same data is in the Delta tables `loadtest_runs` and `loadtest_queries`.

## Failed queries

A query that fails (timeout, throttling, RLS error...) is recorded as a row with `status = error` and its message in `error`;
the virtual user goes on with the next query. Queries 1 and 8 count them and query 8 leaves them out of the percentiles.
A growing `error_rate` with the level is a capacity or model limit, as important as the latency. Runs written before 3.4.0 have
no `status` column and are read as all successful.

## Reading query 8 (latency per level)

`p50` is the typical query, `p90` and `p95` the slow tail, `max` the worst case. When the level grows:

- a flat p50 and p90 means the model absorbs the load;
- p50 stable but p90/p95/max growing means some queries start to queue (usually the heaviest ones);
- everything growing means saturation of the capacity or the model.

Compare levels of the **same model**; models of different size are not comparable with each other.
Latency also includes time queued while the capacity is throttled: check the capacity metrics app if the tail grows suddenly.

## Do the results prove natural user behaviour?

Query 6 proves that the replayed pauses happened. Query 3 and 5 prove that users were spread in time. Together with a flat or slowly growing
latency curve in query 8 they show that the ramp reproduces an interactive load rather than a burst of simultaneous queries.
A burst (all users, no pauses) gives a much higher `peak_concurrent` for the same number of users, which is what a stress test measures.

## Report performance analysis (`AnalyzeReportPerformance_v3`)

`notebooks/AnalyzeReportPerformance_v3.ipynb` is the second analysis notebook. `AnalyzeLoadTest_v3` verifies that the test did what it
should; this one explains **how the report performed**. It reads the same CSV files (and the `thinktimes/` files when they exist), with
DuckDB, and draws every result with matplotlib. Attach the lakehouse that holds the logs as its default lakehouse and run all cells.

Parameters (cell tagged `parameters`): `LOGS`, `RUN_PREFIX`, run filters (`SINCE_UTC`, `RUN_IDS`, `MODELS`, `LEVELS`), the
`FOCUS_LEVEL` of the detailed analyses (default: the highest level of each model), thresholds (`SLA_SEC` per action, `APDEX_T` per query,
`KNEE_FACTOR`), chart sizes (`BUCKET_SEC`, `TOP_N`, `TIMELINE_MAX_RUNS`), the runs compared in Q20 (`BASELINE_RUN`, `CANDIDATE_RUN`),
`MASK_UPN` and `SAVE_TO_TABLES`.

| Block | Analyses |
|---|---|
| A. Overall | Q01 executive summary per model and level (percentiles, Apdex) · Q02 degradation curve and knee point · Q03 throughput versus latency · Q04 timeline of active users, queries in flight and p90 |
| B. Per action and journey | Q05 time per user action (serial and parallel bound) · Q06 full journey per user and iteration |
| C. Per visual | Q07 ranking of the slowest visuals · Q08 heat map visual × level · Q09 stability (variability) · Q10 volume returned versus time · Q12 cold versus warm cache |
| D. Per identity | Q11 performance per virtual user / RLS identity |
| E. Skew of the test | Q13 wall-clock breakdown of a virtual user · Q14 think-time accuracy · Q15 skew of the staggered start · Q16 nominal versus effective concurrency · Q17 ramp phases and plateau |
| F. Quality and regression | Q18 SLA compliance per action · Q19 completeness and errors · Q20 run comparison (before/after) |

Every analysis states what it measures, how it is computed, how to read it and the skew the test may introduce. The last cells
summarise the alerts with the affected model and level (**Automatic conclusions**) and, with `SAVE_TO_TABLES = True`, save every result
as a Delta table `perf_qNN_<topic>` in the default lakehouse (the notebook is Python, so it writes with `deltalake` to the OneLake path).

Things worth knowing when you read it:

- Queries that failed (3.4.0 and later) are counted but left out of every latency. Logs from 3.3.0 and earlier are read as all successful.
- Without think times the notebook still works; only Q14 reports "No data".
- **Q16 and Q17 tell you how much of the nominal level was really applied.** With realistic think times 100 users can be a handful of
  simultaneous queries, and a start window longer than the user journey means the plateau is never reached.
- UPNs are hashed (`user_xxxxxx`) in tables and charts unless `MASK_UPN = False`.
