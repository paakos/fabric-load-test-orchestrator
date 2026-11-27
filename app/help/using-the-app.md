# Using the app

**Load Test** lets a performance-test team parameterize, launch, follow and read the results of the Fabric Load Test Orchestrator without writing JSON.
It has four pages and this Help panel.

| Page | What it does |
|---|---|
| **Parameters & launch** | A guided form for the 19 parameters of `PL_PerfTest_MultiModel_v3`, file upload to the lakehouse, the live JSON and the **Launch test** button |
| **Runs** | The runs of the pipeline with, for each model, the **ramp level**, the **iteration** and the **users done or failed** (see [Run progress](run-progress.md)) |
| **Reports** | Runs the `AnalyzeReportPerformance_v3` notebook and shows its 20 analyses with charts and tables (see [Reports](reports.md)) |
| **Environment** | The workspace, the pipeline, the lakehouse and the notebook the app works with, and the checks on them |

## Before you start

1. Open **Environment**, pick the test workspace and the lakehouse that holds `Files/PerfScenarios`. The app looks for the pipeline
   `PL_PerfTest_MultiModel_v3` and the notebook `AnalyzeReportPerformance_v3` in that workspace. The choice is remembered for the browser session only.
2. Sign in. One consent screen asks for Fabric (read workspaces and items, run items) and OneLake (read and write files) permissions on your behalf.
3. The app cannot read the pipeline definition (that needs a write permission, which it does not ask for), so the pipeline version shows as
   *not verified*. Confirm once that the deployed pipeline is the current version; otherwise the settings you give to each model are ignored.

## Parameters & launch

The page is one scrollable form with the sections *Models*, *Ramp and run*, *Think times*, *RLS users* and *Files*, and a fixed panel with the
JSON, the errors and warnings, a summary in plain words and the action buttons.

- **Every exclusive option is a group of buttons** (a radio group): choose one.
- **A greyed-out field does not apply** to the current choice. It stays visible with a line that says why, keeps what you typed and is not used for
  the JSON. Change the choice and it comes back.
- The **`?`** next to a parameter explains what it is for, the accepted values, an example and links to the exact section of the documentation.
- All **19 parameters are always emitted**, even at their default value: a parameter that is left out takes the value stored in the pipeline,
  which the installer may have changed. Parameters that do not apply are emitted empty or with their default.

### The three mode switches

| Switch | Options | Effect |
|---|---|---|
| **Run settings** | Global / Per model | *Global*: the ten settings are written once. *Per model*: every model card has the ten settings and the global fields are greyed out; the JSON carries the ten keys in every model |
| **RLS users** | source *none / list / file* × scope *global / per model* | Decides which fields take users and where they go. With *per model* **every model must have its own users** (the global fallback is not offered) |
| **Navigation file** | One file per model / Same file for all | The pipeline has no global navigation file: *Same file for all* only copies one path into every model |

The ten per-model settings are `ramp_levels`, `iterations`, `delay_sec`, `enable_think_times`, `think_time_scale`, `max_think_time_sec`,
`think_time_jitter_pct`, `fallback_think_time_sec`, `ramp_up_sec` and `initial_user_jitter_sec`
([reference](../../docs/pipeline-parameters.md#per-model-execution-settings)). A per-model value of `false`, `0` or `0.0` is valid and is emitted.

### Uploading files

Next to every file field there is an **Upload** button that is enabled or greyed out exactly like the field. The destination is fixed:
`Files/PerfScenarios/Queries/` for navigation JSON and `Files/PerfScenarios/Users/` for users files. The name is cleaned to
`A–Z a–z 0–9 . _ -`. If the name already exists you choose **Replace**, **Save with another name** or **Cancel**.
When the upload ends the path is written into the field it came from.

The file is checked **before** it is uploaded:

- *Navigation JSON*: the structure of a Performance Analyzer export as `RunPerfScenario_v3` reads it (an `events` array, `Visual Container Lifecycle`
  events with `visualTitle` and `visualId`, `Execute DAX Query` events with `QueryText`, at least one query). The app shows the number of user actions, queries and distinct visuals,
  and whether the file has the timestamps that the think times need.
- *Users file*: UTF-8 text, one user per line, `#` comments, commas or semicolons also separate users, the same rules as the orchestrator
  ([format](../../docs/pipeline-parameters.md#users-file-format)). The app shows how many valid users, how many duplicates were removed and the **line numbers** of invalid lines.
  It never shows the list of users. You can also **create the file from a pasted list**.

### Launching

**Launch test** is enabled only when there is no error, every mandatory field is filled, the files exist in the lakehouse (checked again right before launching),
the semantic models exist in their workspaces, the pipeline was found (and confirmed) and you are signed in. If it is greyed out, the reasons are listed under the button.

After you confirm, the app starts the pipeline once, finds the job that was created and opens it in **Runs**. If two jobs appear at the same time you are asked which one is yours.

### Privacy

User principal names (UPNs) are personal data. They are never saved in the browser (not in `localStorage`, not in `sessionStorage`), never written to the console, and they are masked
(`user_ab12cd`) everywhere except in the field where you type them. The JSON preview shows `«N users»` instead of the names; **Copy** and **Download** do include them.

### Load an existing JSON

Paste or choose a JSON of pipeline parameters. The app flags every name that is not a parameter of the pipeline (Fabric would ignore it silently) and does not import it. The modes are deduced:
a model with its own settings switches to *Per model* (missing values are completed with the global one, with a warning); a global RLS fallback with *per model* is discarded and
copied to the models that lack their own; if every model has the same navigation file, *Same file for all* is selected.

## Common mistakes

See [Common mistakes](../../docs/pipeline-parameters.md#common-mistakes) in the parameter reference. The most frequent ones in this app: a `workspace` written as a GUID (use the display name),
a `dataset` that is not the exact name of the semantic model, a navigation file recorded on another model, and RLS users without read and build permission on the model.
