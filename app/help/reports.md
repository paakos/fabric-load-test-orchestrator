# Reports

The **Reports** page runs the notebook `AnalyzeReportPerformance_v3` with the Fabric Jobs API and shows what it writes. The page never runs SQL and never reads the raw CSV files:
it draws what the notebook calculated. The notebook itself is described in [Report performance analysis](../../docs/analysis.md#report-performance-analysis-analyzereportperformance_v3).

## Run an analysis

1. Choose the **test name prefix** (`RUN_PREFIX`, the `test_name_prefix` of the pipeline). The app lists the run folders of that prefix; select some to restrict the analysis (`RUN_IDS`), or leave all.
2. Optionally restrict by **model name** (the semantic model name, `MODELS`), **levels** (`LEVELS`), a start date (`SINCE_UTC`) and the **focus level** (`FOCUS_LEVEL`). Set the thresholds `SLA_SEC` (per action) and `APDEX_T` (per query).
3. **Analyze.** The app always sends `MASK_UPN = true`, `EXPORT_JSON = true` and an `ANALYSIS_ID` of its own (`<prefix>-<UTC date>-<UTC time>`) so it knows where the result will be.

The default lakehouse of the notebook must be the lakehouse that holds `Files/PerfScenarios/logs`. When the job ends the app opens the analysis.

## The analysis folder

```text
Files/PerfScenarios/analysis/<analysis_id>/
├── manifest.json        notebook version, UTC date, parameters, focus level, runs, alerts, list of queries with their chart specification
└── qNN_<topic>.json     the rows of each query (UPNs already masked)
```

The list of analyses on the page is the list of these folders. Any analysis you ran before (or from the notebook with `EXPORT_JSON = True`) can be opened.

## Reading the page

- **Header**: the runs analysed, the date and the key parameters.
- **Alerts**: the automatic conclusions of the notebook (error, warning), each linked to its query. With none, "No alerts with the current thresholds".
- **Blocks A to F**: A overall performance · B per action and journey · C per visual · D per user (RLS identity) · E skew from the offset and the think times · F test quality and regression.
- **Each query** shows its title, **What it measures** and **How to read it** (taken from the notebook), a **chart** and a **table** with sorting, filter by model and level and CSV download.
  A query with no rows says why (`no_data`) and a query that failed says the error, without breaking the page.

The charts are drawn from a specification that is data only: `grouped_bar`, `line`, `combo`, `small_multiples`, `hbar`, `heatmap`, `scatter`, `stacked100` and `diverging_bar`.
Reference lines such as `SLA_SEC` and `APDEX_T` take their value from the parameters stored in the manifest.

`duration` is client time (XMLA plus row reading); it does not include browser rendering. The levels of a model run one after another without clearing the cache, and the models run in parallel.
