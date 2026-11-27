# Run progress

The **Runs** page lists the runs of `PL_PerfTest_MultiModel_v3` (from the Jobs API) with their state, start, duration and trigger.
Open one to see the **state of each model**. The page refreshes every 12 seconds, waits longer after a throttling answer (429) and stops when the run reaches a final state.

## What you see for each model

| Item | Example | Where it comes from |
|---|---|---|
| **Ramp level** | chips `1 · 5 · 10`, the current one highlighted; "Level 2 of 3 · 5 users" | The ramp of the model (from the launched JSON, or from the pipeline activity) and the run folders `Files/PerfScenarios/logs/<prefix>-<model_key>-c<N>-<timestamp>` |
| **Iteration** | "Iteration 2 of 3" or "Iteration 1–2 of 3" | The progress files `Files/PerfScenarios/progress/<loadtest_id>/user_<k>.json` that `RunPerfScenario_v3` rewrites at the start of every iteration |
| **Users of the level** | "12 of 20 done · 1 failed" | One CSV per user is written when the user **ends**; `error.log` has a line per failed query and per failed user |
| **Failed queries and error rate** | "4 failed queries · error rate 0.3 %" | `summary.json` of the level when it ends; `error.log` while it runs. For older runs, **Count from CSV** reads the `status` column of the user files |
| **Progress bar** | 55 % | Completed levels plus the fraction of the current level (from the progress files, or from the finished users) |

When the iteration cannot be known (the progress folder does not exist: the pipeline is older than the heartbeat), the page says **"Iteration: not available"** and keeps showing the level and the users.
Between the start of a level and its first progress file it says "waiting for the first progress file".
With more than 40 users in a level the page reads a spread sample of 40 progress files and says so.

## Failed queries are not failed runs

With the default `stop_on_query_error = false` a failed query is a row with `status = error` and the user carries on, so **a run with failed queries still ends Completed**.
The **Runs** page shows the failed queries and the error rate of each level so that you notice. Set `fail_on_error_rate` to make a level fail above a threshold
([Results](../../docs/pipeline-parameters.md#results), [summary and exit value](../../docs/architecture.md#run-summary-and-exit-value)).

Messages from `error.log` and from the activities can contain the identity that was impersonated. The page masks every e-mail-like text and does not show connection strings.

## Cancel and analyze

**Cancel run** asks for confirmation and sends the cancel request; the levels that were running end as cancelled.
When the run finishes, **Analyze this run** opens [Reports](reports.md) with the prefix and the run folders of this run already selected.
