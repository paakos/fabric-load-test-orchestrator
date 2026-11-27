# Deploying with an AI agent (GitHub Copilot and similar)

You can ask a coding agent, such as GitHub Copilot in VS Code or the Copilot CLI, to deploy and operate the orchestrator in plain language.
The agent does not need to guess: this repository gives it a deterministic tool and a runbook.

| Piece | What it is for |
|---|---|
| [`AGENTS.md`](../AGENTS.md) | The runbook the agent reads first: rules, order of the steps, REST calls and checks. Copilot reads it automatically when the repository is open |
| [`tools/deploy_orchestrator.py`](../tools/deploy_orchestrator.py) | One command that uploads the package, runs the installer notebook in the workspace and verifies the result |
| [`examples/agent-prompts/`](../examples/agent-prompts) | Ready-to-paste prompts in natural language (deploy, dry run, configure models, run a test, analyze, deploy the app, update, remove) |

The agent never needs to see a password: it uses your own sign-in (`az login`), so it can do only what you can do in the workspace.

## Before you start

1. Clone this repository and open it in VS Code (or start the Copilot CLI in the folder). The agent must be in **agent mode**.
2. Install **Python 3.10+** and the **Azure CLI**, then sign in with the account that has **Contributor** (or higher) in the target workspace:
   ```powershell
   az login --tenant <your tenant id or domain>
   ```
3. Have a Fabric **workspace on a capacity** (trial or paid). If you do not have one, the prompt can ask the agent to create it.
4. Build the package once, or download `FabricLoadTest_v3_package.zip` from the Releases page into `dist/`:
   ```powershell
   python tools/build_package.py
   ```
5. For Fabric operations beyond the script (listing models, starting a pipeline) the agent uses `az rest` against `https://api.fabric.microsoft.com`.
   If you have the **Fabric MCP server** configured in your editor it can use it instead; both work.

## The prompts

Copy a prompt, replace the values in `<angle brackets>` and send it to the agent. Every prompt ends by asking the agent to show what it did,
so you can check it.

### 1. Install, with a dry run first

> Deploy the Fabric Load Test Orchestrator to my workspace `<workspace name>`. Use the lakehouse `<lakehouse name>` (create it if it does not exist).
> First do a dry run with `tools/deploy_orchestrator.py` and show me the plan. When I say OK, run it for real and tell me which items were created.
> Read `AGENTS.md` first and do not change any file of the repository.

### 2. Install with my models already configured

> Deploy the orchestrator to workspace `<workspace name>`, lakehouse `<lakehouse name>`. I want to test two semantic models of that workspace:
> `Sales` with the navigation file `PowerBIPerformanceData_Sales.json` and `Inventory` with `PowerBIPerformanceData_Inventory.json`.
> `Sales` should ramp 5 and then 20 users; `Inventory` just 10 users with no think times. Use one users file per model with
> `users_sales.txt` and `users_inventory.txt`. Write the `models` file for me, show it, then deploy.

### 3. Run a test and follow it

> In workspace `<workspace name>` run `PL_PerfTest_MultiModel_v3` with the models and settings we deployed. Use the ramp `[1, 5, 10]` and
> 1 iteration. Tell me when it finishes, how long each level took and whether any query failed (look at the CSV files and `summary.json`
> of each run folder in `Files/PerfScenarios/logs`).

### 4. Analyze the results

> Run the notebook `AnalyzeReportPerformance_v3` over the test prefix `ramp-v3` with `EXPORT_JSON = True`, wait for it and summarize the
> alerts and the three slowest visuals of each model. Tell me where the JSON results were written.

### 5. Deploy the Fabric App

> Deploy the LoadTest app from the `app/` folder to workspace `<workspace name>`. Follow `app/README.md`: register the Entra single-page app
> (I will approve the consent), build it outside OneDrive and publish it with rayfin. Give me the app URL when it is ready.

### 6. Update to a new version

> Update the orchestrator in workspace `<workspace name>` to the version in `dist/` (overwrite the existing items, keep the schedules).

### 7. Remove

> Remove the orchestrator items from workspace `<workspace name>`: the two pipelines and the four notebooks, but keep the lakehouse and the
> result files. Show me the list and wait for my confirmation before deleting.

## What the agent does with them

For a deployment the agent runs, in this order (this is also what [`AGENTS.md`](../AGENTS.md) tells it):

1. Checks `az account show` and that the package exists.
2. `python tools/deploy_orchestrator.py --workspace "<name>" --lakehouse "<name>" --dry-run`, and shows you the output.
3. After your confirmation, the same command without `--dry-run`. The script uploads the zip to `Files/deploy/`, creates the installer notebook with
   your parameters, runs it and checks that the six items exist.
4. Lists the workspace items and tells you what to upload next (one Performance Analyzer JSON per model, the users files).

## Good practice when you delegate

- **Dry run first**, and read the plan. The installer overwrites items with the same name unless you say `--no-overwrite`.
- **Use a test workspace** the first time. The load test reads semantic models and can consume capacity.
- **Do not paste secrets** in prompts. The agent does not need them. User principal names (UPNs) for RLS go in a users file in the lakehouse,
  not in the chat.
- Ask the agent to **show the commands** it runs. Everything it needs is in the repository, so there is no hidden step.
- Do not give the agent the identity of a workspace administrator for RLS tests: the impersonated users need only read and build permission on the model.
- Large levels (100 users or more) need a bigger Spark session: ask the agent to raise `vCores` in the `%%configure` cell of `RunLoadTest_v3`.

## If something fails

| Symptom | What to tell the agent |
|---|---|
| `Could not get a token` | Run `az login` again in the same terminal and retry |
| `Workspace '<name>': 0 matches` | Use `--workspace-id` with the id from the workspace URL |
| `The installer ended Failed` | Open the installer run in the Monitor hub and read its output; the message names the cause (see [deployment.md](deployment.md#troubleshooting)) |
| HTTP 403 | Your account is not Contributor in the workspace |
| `ItemDisplayNameNotAvailableYet` | A deleted item still reserves its name; wait a few minutes and retry |
