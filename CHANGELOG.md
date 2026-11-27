# Changelog

## 3.6.0

Consolidated release: the per-model execution settings, the report performance analysis notebook, a progress heartbeat, a command-line and
agent-driven deployment path and the **LoadTest Fabric App**. It builds on 3.4.0 and is compatible with every `models` value and result written
by 3.3.0 and 3.4.0.

- **Per-model execution settings.** Each item of `models` may carry its own `ramp_levels` (a fixed number of users or a ramp), `iterations`,
  `delay_sec`, `enable_think_times`, `think_time_scale`, `max_think_time_sec`, `think_time_jitter_pct`, `fallback_think_time_sec`, `ramp_up_sec` and
  `initial_user_jitter_sec`. A key that is missing or `null` falls back to the pipeline parameter of the same name. Only
  `PL_PerfTest_MultiModel_v3` changes: each of those ten parameters is forwarded as `@coalesce(item()?.<name>, pipeline().parameters.<name>)`.
  The installer keeps and validates those keys and fails before creating anything on an invalid value. The same semantic model may be listed
  several times with different `model_key` values, one per user profile. `test_name_prefix`, the RLS switches and the 3.4.0 parameters stay global.
- **Progress heartbeat.** `RunPerfScenario_v3` writes `Files/PerfScenarios/progress/<loadtest_id>/user_<n>.json` (status, iteration, queries done)
  at the start of every iteration and when the user ends. It is best effort (a write error never fails the test), holds no UPN or DAX, and does
  not change the result CSV files.
- **Report performance analysis.** New notebook `AnalyzeReportPerformance_v3`: 20 analyses (Q01-Q20) in six blocks (overall, per action and
  journey, per visual, per RLS identity, skew introduced by the offset and the think times, test quality and regression), each with its table, a chart,
  a description (what it measures, how it is computed, how to read it, skew the test may introduce) and automatic conclusions that name the
  affected model and level. It reads 3.3 and 3.4 result formats, works without think times, masks UPNs (`MASK_UPN`), can save every result as a Delta
  table `perf_qNN_<topic>` (`SAVE_TO_TABLES`) and can export `manifest.json` plus one JSON per analysis to `Files/PerfScenarios/analysis/<ANALYSIS_ID>/`
  (`EXPORT_JSON`), which is what the app shows. `RUN_IDS`, `MODELS` and `LEVELS` also accept JSON or comma-separated text, so a job can pass them.
- **LoadTest Fabric App** (`app/`): parameterize `PL_PerfTest_MultiModel_v3` in a guided page (exclusive options as buttons, fields that do
  not apply greyed out), upload navigation and users files to the lakehouse, launch, follow the model, level and iteration of a run, cancel it, and read the
  analysis (alerts and the 20 analyses with charts and tables) without leaving the app. It has a demo mode and its own tests. See
  [app/README.md](app/README.md).
- **Deployment.** `tools/deploy_orchestrator.py` deploys from a terminal (or CI): it uploads the package, runs the installer notebook with your
  parameters and verifies the result. [AGENTS.md](AGENTS.md), [docs/agent-deployment.md](docs/agent-deployment.md) and
  [examples/agent-prompts/](examples/agent-prompts) let an AI agent such as GitHub Copilot do the same from plain-language prompts.
- The package and the installer deploy 4 notebooks and 2 pipelines. `tools/make_synthetic_logs.py` generates synthetic logs with the exact result
  schema; new tests execute every cell of the analysis notebook over them. `requirements-dev.txt` adds `matplotlib`, `deltalake` and `pyarrow`.

## 3.5.0 (not released separately; included in 3.6.0)
## 3.5.0

Additive release: no change to the test notebooks, the pipelines or the result schema.

- **New notebook `AnalyzeReportPerformance_v3`:** report performance analysis of the test logs, with 20 analyses (Q01-Q20) in six
  blocks (overall, per action and journey, per visual, per RLS identity, skew introduced by the offset and the think times, test
  quality and regression), each with its table, a chart, a description (what it measures, how it is computed, how to read it, skew the
  test may introduce) and automatic conclusions that name the affected model and level. It reads the CSV files with DuckDB, reads 3.3
  and 3.4 result formats, works without think times, and can optionally save every result as a Delta table `perf_qNN_<topic>` in the
  default lakehouse (`SAVE_TO_TABLES = True`) to build a Power BI report on top. UPNs are masked by default (`MASK_UPN`).
- The package and the installer deploy the new notebook (4 notebooks and 2 pipelines).
- `tools/make_synthetic_logs.py` generates synthetic logs with the exact result schema; the new tests execute every cell of the
  notebook over them. `requirements-dev.txt` adds `matplotlib`, `deltalake` and `pyarrow`.

## 3.4.0

**Behaviour change: a failed query no longer ends the virtual user.** Until 3.3.0 an exception in a query ended that virtual user,
its CSV was never written and the run lost every row of that user. From 3.4.0 the failed query is recorded as a row with
`status = error`, `rows = 0` and the error message (token redacted), a line is added to `error.log`, the connection is reopened if the
error closed it and the user continues with the next query. The CSV is written in `finally`, so partial results always survive.
Set `stop_on_query_error = true` to stop the user at its first failed query as before (its rows and CSV are still kept).

**A green run can contain failed queries.** With the default `stop_on_query_error = false` the notebook and the pipeline end Completed even if queries failed. Read `failed_queries` and `error_rate` in `summary.json` or in the notebook exit value, or set `fail_on_error_rate` so the notebook fails above a threshold.

- **Result schema:** the user CSV files gain two columns, `status` (`ok` or `error`) and `error`. `AnalyzeLoadTest_v3` (queries 1 and 8)
  and `summary.json` count failed queries and compute latency percentiles over successful queries only. Runs without the `status`
  column (3.3.0 and earlier) are read as successful.
- **Run summary:** `RunLoadTest_v3` writes `summary.json` in every run folder and exits with it (`notebookutils.notebook.exit`): latency
  percentiles of the successful queries, failed queries, lost virtual users, error rate, throughput and UTC window. A failed
  `runMultiple` still leaves `summary.json` with the error before the notebook fails.
- New parameter `write_results_to_tables` (notebook and both pipelines, default `false`): appends each run to the Delta tables
  `loadtest_runs` and `loadtest_queries` of the default lakehouse, with explicit schemas. `RunLoadTest_v3` is a Python notebook (no
  Spark), so it writes with `deltalake.write_deltalake` to the OneLake `abfss://` path of the default lakehouse (`/dbo` added on
  schema-enabled lakehouses) with the storage token; the mounted `/lakehouse/default/Tables` path fails on commit. Columns are typed
  (`Int64`, `float64`, `string`) so all-null columns keep their type. The append uses `schema_mode="merge"`, so a table created by an
  earlier version gains the new columns; with an old `deltalake` that does not support it the append is plain and a table with a
  different schema must be dropped first.
- New parameter `stop_on_query_error` (both notebooks and both pipelines, default `false`), see above.
- New parameter `fail_on_error_rate` (`RunLoadTest_v3` and both pipelines, default `1.0`, range 0 to 1): after writing `summary.json`
  and the tables, the notebook fails when the run's error rate is above it. `0` fails on any failed query; `1.0` never fails.
- **ADOMD authentication:** `RunPerfScenario_v3` authenticates like semantic-link (`refresh_tom_access_token` plus an
  `OnAccessTokenExpired` callback). On some capacity and region combinations the `pbi` token passed as `password=` fails with
  "Authentication failed for all authenticators" while sempy works; without sempy the notebook falls back to the previous form. The
  token is no longer part of the logged connection string. `EffectiveUserName` (RLS) keeps working. This relies on a private
  semantic-link module (`sempy.fabric._client._utils`), marked in the code.
- `RunPerfScenario_v3`: the ADOMD `DataReader` is always closed.
- `RunLoadTest_v3`: the polars consolidation accepts CSV files with different columns.

## 3.3.0

- **RLS identities from a text file.** New switches, in the same spirit as `enable_think_times`:
  - `rls_source`: `list` (default), `file` or `none`.
  - `rls_scope`: `global` (default) or `per_model`.
  - `rls_users_file`: global file with one UPN per line (blank lines and `#` comments ignored, duplicates removed, invalid lines rejected with their line number).
  - Each item of `models` may carry `users` or `users_file` for per-model identities; a model without its own falls back to the global value.
  - The defaults reproduce 3.2.0: with the default parameters nothing changes.
- The pipelines pass the item of each model to the notebook as JSON (`model_settings`), so optional keys never break a pipeline expression.
- Installer: validates `users` / `users_file` in `MODELS`, new optional `RLS_SOURCE`, `RLS_SCOPE`, `RLS_USERS`, `RLS_USERS_FILE` defaults,
  creates `Files/PerfScenarios/Users/` and warns when a referenced users file does not exist yet.
- Notebook logs state where the identities come from and how many there are, never the UPNs.
- Samples `users.example.txt` and `models.rls.example.json`; tests for every combination of source and scope.

## 3.2.0

First public release of the repository.

- English notebooks, installer and documentation (Spanish guide in `docs/es/`).
- Repository structure: `notebooks/`, `pipelines/`, `installer/`, `tools/`, `samples/`, `tests/`, `docs/`, `upstream/`.
- `upstream/` holds the untouched original files of `microsoft/fabric-toolbox` (pinned commit, verified by test).
- Pipelines ship with placeholders (`{{WORKSPACE_ID}}`, `{{NOTEBOOK:...}}`, `{{PIPELINE:...}}`) and a safe default ramp `[1, 5, 10]`.
- `RunLoadTest_v3` and `RunPerfScenario_v3`: access token redacted from console output and `error.log`.
- Package manifest no longer carries tenant, user or workspace identifiers; the builder checks for leaks instead of using a deny list.
- Installer verification is generic (foreign ids, ids that do not exist, unresolved placeholders, lakehouse binding, pipeline references).
- Analysis notebook renamed `AnalyzeLoadTest_v3` with English column names.
- Test suite (think-time parser, scenario and load-test notebooks, analysis notebook, installer against a fake Fabric API, package checks) and CI.

## 3.1.x (internal)

Spanish-language builds used while developing the solution: parallel models, sequential ramp, think times, staggered start, RLS
parameter, deployment package and installer.
