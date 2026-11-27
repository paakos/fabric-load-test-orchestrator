# Agent runbook: Fabric Load Test Orchestrator

This file is for AI coding agents (GitHub Copilot, Claude Code and similar) working in this repository. Humans: see [README.md](README.md) and
[docs/agent-deployment.md](docs/agent-deployment.md).

## What this repository is

Pipeline-driven load tests for Power BI semantic models in Microsoft Fabric. A notebook (`installer/Setup_LoadTest_v3.ipynb`) plus a zip
deploy 4 notebooks and 2 pipelines into a workspace. An optional Fabric App (`app/`) launches tests and shows the results.
Everything user-facing is in English.

## Rules

1. **Use the signed-in user's identity** (`az login`). Never ask for, print or store passwords, tokens, client secrets or UPNs of real people.
   Tokens come from `az account get-access-token`.
2. **Dry run before any change** to a workspace, and show the plan. Ask for confirmation before overwriting or deleting items.
3. **Do not edit repository files to deploy.** Deployment parameters go on the command line or in a temporary file outside the repository.
4. **Do not commit** ids of workspaces, tenants, users or tokens. The package builder rejects them; do not work around it.
5. npm and Node artifacts (`node_modules`, `dist`, caches) must never be left in a synced folder such as OneDrive: build in a scratch folder.
6. Deleting items or workspaces is a separate, explicit request. Keep the lakehouse and `Files/PerfScenarios/logs` unless told otherwise.

## Deploy the orchestrator

```powershell
az account show                                     # signed in? right tenant?
python tools/build_package.py                       # or use the zip from the Releases page in dist/
python tools/deploy_orchestrator.py --workspace "<name>" --lakehouse "<lakehouse>" --dry-run
python tools/deploy_orchestrator.py --workspace "<name>" --lakehouse "<lakehouse>" [--models-file models.json] [--rls-source file --rls-scope per_model]
```

- `--create-lakehouse` creates the lakehouse if it is missing; `--no-overwrite` aborts if an item already exists;
  `--workspace-id <guid>` replaces `--workspace` when the name is ambiguous.
- The script uploads the zip to `Files/deploy/`, creates `Setup_LoadTest_v3` with your parameters, runs it, deletes it and checks the 6 items exist.
  The installer itself verifies hashes, ids and placeholders. If the job fails, read the notebook run in the Monitor hub.
- `models.json` is the `models` parameter: see [docs/pipeline-parameters.md](docs/pipeline-parameters.md) and
  [samples/models.per-model.example.json](samples/models.per-model.example.json). `workspace` is a **name** (empty = same workspace), never an id.
- Afterwards the user must upload one Performance Analyzer JSON per model to `Files/PerfScenarios/Queries/` and, for RLS, users files
  (one UPN per line) to `Files/PerfScenarios/Users/`.

## Run a test

1. Find the pipeline: `GET https://api.fabric.microsoft.com/v1/workspaces/{ws}/items?type=DataPipeline` → `PL_PerfTest_MultiModel_v3`.
2. Start it: `POST /v1/workspaces/{ws}/items/{pipelineId}/jobs/instances?jobType=Pipeline` with
   ```json
   {"executionData": {"parameters": {"models": [ ... ], "test_name_prefix": "ramp-v3", "ramp_levels": [1, 5, 10], "iterations": 1}}}
   ```
   Send every parameter you want to control; omitted ones keep the value stored in the pipeline. Names must match exactly
   (Fabric ignores unknown names silently). Reference: [docs/pipeline-parameters.md](docs/pipeline-parameters.md).
3. The response is `202` with a `Location` header: poll it until `Completed`, `Failed` or `Cancelled`.
4. A green run can contain failed queries: read `summary.json` in each `Files/PerfScenarios/logs/<prefix>-<model>-c<N>-<date>/` folder
   (`failed_queries`, `error_rate`), or the `status = error` rows of the CSV files.
5. While it runs, `Files/PerfScenarios/progress/<loadtest_id>/user_<n>.json` shows each virtual user's iteration.

## Analyze

Run the notebook `AnalyzeReportPerformance_v3` (`POST .../items/{id}/jobs/instances?jobType=RunNotebook`) with parameters such as
`RUN_PREFIX`, `SLA_SEC`, `APDEX_T`, `EXPORT_JSON = true`. The results are written to `Files/PerfScenarios/analysis/<ANALYSIS_ID>/`
(`manifest.json` with the alerts, plus one JSON per analysis). The notebook must have the lakehouse that holds the logs as its default lakehouse.

## Deploy the app

Follow [app/README.md](app/README.md). In short: register an Entra single-page application (no secret, redirect `<origin>/blank.html`),
build in a scratch folder, publish with rayfin-cli, give the URL to the user. The user approves any consent prompt.

## Change the code

```powershell
pip install -r requirements-dev.txt
pytest                                  # real notebooks against fake Fabric/ADOMD runtimes
python tools/build_package.py           # fails if the package contains ids, e-mails or tenants
cd app; npm ci; npm run typecheck; npm test; npm run build   # in a scratch copy, see rule 5
```

`notebooks/*.ipynb` are the source of truth. Keep them free of outputs and of lakehouse bindings. After changing a parameter of a pipeline,
update `docs/pipeline-parameters.md`, `docs/parameters.md`, the installer and the tests that check the parameter lists.
