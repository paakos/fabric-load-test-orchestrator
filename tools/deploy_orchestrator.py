"""Deploys the orchestrator into a Fabric workspace from the command line (or from an AI agent) by driving the installer notebook.

It does what you would do by hand: uploads the package zip to the lakehouse, creates the installer notebook with the parameters you give
(models, RLS defaults, overwrite, dry run), runs it, waits for the result and lists what ended up in the workspace. All the real work
(placeholder resolution, hash check, verification of ids) stays in `installer/Setup_LoadTest_v3.ipynb`.

Only the Python standard library and the Azure CLI (`az login` first) are needed. Tokens can also come from the environment:
FABRIC_ACCESS_TOKEN (https://api.fabric.microsoft.com) and STORAGE_ACCESS_TOKEN (https://storage.azure.com). If `az` is signed in to several
tenants, set AZ_SUBSCRIPTION_ID to a subscription of the right one.

Examples
  python tools/deploy_orchestrator.py --workspace "Load Test" --lakehouse LoadTestLakehouse --dry-run
  python tools/deploy_orchestrator.py --workspace-id <guid> --lakehouse LoadTestLakehouse --models-file my_models.json
  python tools/deploy_orchestrator.py --workspace "Load Test" --create-lakehouse --rls-source file --rls-scope per_model
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
FABRIC = "https://api.fabric.microsoft.com"
ONELAKE = "https://onelake.dfs.fabric.microsoft.com"
INSTALLER_NAME = "Setup_LoadTest_v3"
GUID = re.compile(r"^[0-9a-fA-F]{8}-([0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$")


class DeployError(RuntimeError):
    pass


class Http:
    """Minimal HTTP client. Tests replace it with an in-memory fake; it returns (status, headers, body)."""

    def request(self, method: str, url: str, headers: dict, body: bytes | None = None) -> tuple[int, dict, bytes]:
        req = urllib.request.Request(url, data=body, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=120) as resp:
                return resp.status, {k.lower(): v for k, v in resp.headers.items()}, resp.read()
        except urllib.error.HTTPError as error:
            return error.code, {k.lower(): v for k, v in error.headers.items()}, error.read()


def az_token(resource: str) -> str:
    # AZ_SUBSCRIPTION_ID picks the account when `az` is signed in to several tenants (the default one may not be the right one)
    subscription = os.environ.get("AZ_SUBSCRIPTION_ID")
    az = shutil.which("az")
    if not az:
        raise DeployError("The Azure CLI (`az`) was not found. Install it and run `az login` (or set FABRIC_ACCESS_TOKEN / STORAGE_ACCESS_TOKEN).")
    command = [az, "account", "get-access-token", "--resource", resource, "--query", "accessToken", "-o", "tsv"]
    if subscription:
        if not re.fullmatch(r"[A-Za-z0-9 ._()-]+", subscription):
            raise DeployError("AZ_SUBSCRIPTION_ID must be a subscription id or name (letters, digits, spaces and . _ ( ) -).")
        command += ["--subscription", subscription]
    try:
        out = subprocess.run(command, capture_output=True, text=True, check=True)
    except (OSError, subprocess.CalledProcessError) as error:
        raise DeployError(f"Could not get a token for {resource}. Run `az login` (or set FABRIC_ACCESS_TOKEN / STORAGE_ACCESS_TOKEN).") from error
    return out.stdout.strip()


class Fabric:
    def __init__(self, http: Http, fabric_token: str, storage_token: str, sleep=time.sleep):
        self.http, self.fabric_token, self.storage_token, self.sleep = http, fabric_token, storage_token, sleep

    def _call(self, method, url, token, body=None, extra=None, ok=(200, 201, 202, 204)):
        headers = {"Authorization": f"Bearer {token}", "x-ms-fabric-skill": "deploy-orchestrator", **(extra or {})}
        data = None
        if isinstance(body, (dict, list)):
            data, headers["Content-Type"] = json.dumps(body).encode(), "application/json"
        elif isinstance(body, bytes):
            data = body
        for attempt in range(6):
            status, resp_headers, payload = self.http.request(method, url, headers, data)
            if status == 429 and attempt < 5:
                self.sleep(int(resp_headers.get("retry-after", "5")))
                continue
            break
        if status not in ok:
            detail = payload.decode("utf-8", "replace")[:400]
            raise DeployError(f"{method} {url.split('?')[0]} failed with HTTP {status}: {detail}")
        return status, resp_headers, payload

    def api(self, method, path, body=None, ok=(200, 201, 202, 204)):
        status, headers, payload = self._call(method, FABRIC + path, self.fabric_token, body, ok=ok)
        return status, headers, (json.loads(payload) if payload else None) or {}

    def wait_operation(self, headers, timeout_s=600, want_result=False):
        """Long-running operation: poll the Location header until it ends."""
        location = headers.get("location")
        if not location:
            return {}
        deadline = time.time() + timeout_s
        while True:
            _, h, state = self._call("GET", location, self.fabric_token)
            state = json.loads(state) if state else {}
            if state.get("status") in ("Succeeded", "Completed"):
                break
            if state.get("status") in ("Failed", "Cancelled"):
                raise DeployError(f"Operation {state['status']}: {json.dumps(state.get('error') or state.get('failureReason') or {})[:400]}")
            if time.time() > deadline:
                raise DeployError("Timed out waiting for a Fabric operation")
            self.sleep(int(h.get("retry-after", "3")))
        if want_result:
            _, _, result = self._call("GET", location.rstrip("/") + "/result", self.fabric_token)
            return json.loads(result) if result else {}
        return state

    def list_all(self, path):
        items, token = [], None
        while True:
            url = path + (("&" if "?" in path else "?") + "continuationToken=" + urllib.parse.quote(token) if token else "")
            _, _, body = self.api("GET", url)
            items += body.get("value", [])
            token = body.get("continuationToken")
            if not token:
                return items

    def find_workspace(self, name=None, workspace_id=None):
        if workspace_id:
            _, _, body = self.api("GET", f"/v1/workspaces/{workspace_id}")
            return body
        matches = [w for w in self.list_all("/v1/workspaces") if w["displayName"].lower() == name.lower()]
        if len(matches) != 1:
            raise DeployError(f"Workspace '{name}': {len(matches)} matches (use --workspace-id)")
        return matches[0]

    def lakehouse(self, ws, wanted, create):
        found = self.list_all(f"/v1/workspaces/{ws}/lakehouses")
        if wanted:
            hit = [x for x in found if x["id"].lower() == wanted.lower() or x["displayName"].lower() == wanted.lower()]
            if hit:
                return hit[0]
            if not create:
                raise DeployError(f"Lakehouse '{wanted}' not found in the workspace (add --create-lakehouse to create it)")
        elif len(found) == 1:
            return found[0]
        elif found:
            raise DeployError("The workspace has several lakehouses: choose one with --lakehouse")
        elif not create:
            raise DeployError("The workspace has no lakehouse: use --create-lakehouse")
        _, headers, body = self.api("POST", f"/v1/workspaces/{ws}/lakehouses", {"displayName": wanted or "LoadTestLakehouse"})
        return body if body.get("id") else self.wait_operation(headers, want_result=True)

    def upload(self, ws, lakehouse_id, relative_path, data: bytes):
        """OneLake DFS write in three steps: create (explicit empty body), append, flush."""
        url = f"{ONELAKE}/{ws}/{lakehouse_id}/{relative_path}"
        self._call("PUT", url + "?resource=file", self.storage_token, b"", {"Content-Length": "0"})
        self._call("PATCH", url + "?action=append&position=0", self.storage_token, data)
        self._call("PATCH", url + f"?action=flush&position={len(data)}", self.storage_token, b"", {"Content-Length": "0"})


def literal(value) -> str:
    return repr(value)


def patch_parameters(source: str, values: dict) -> str:
    for name, value in values.items():
        pattern = re.compile(rf"^{name} = .*?(?=\s+#|$)", re.M)
        if not pattern.search(source):
            raise DeployError(f"The installer has no parameter {name}")
        source = pattern.sub(lambda _m: f"{name} = {literal(value)}", source, count=1)
    return source


def build_installer(text: str, values: dict, workspace_id: str, lakehouse: dict) -> dict:
    nb = json.loads(text)
    cell = next(c for c in nb["cells"] if "parameters" in c.get("metadata", {}).get("tags", []))
    cell["source"] = patch_parameters("".join(cell["source"]), values).splitlines(keepends=True)
    nb["metadata"]["dependencies"] = {"lakehouse": {"known_lakehouses": [{"id": lakehouse["id"]}], "default_lakehouse": lakehouse["id"],
                                                    "default_lakehouse_name": lakehouse["displayName"],
                                                    "default_lakehouse_workspace_id": workspace_id}}
    return {"displayName": INSTALLER_NAME, "type": "Notebook", "definition": {"format": "ipynb", "parts": [
        {"path": "notebook-content.ipynb", "payload": base64.b64encode(json.dumps(nb, ensure_ascii=False).encode()).decode(),
         "payloadType": "InlineBase64"}]}}


def package_items(zip_path: Path) -> list[str]:
    with zipfile.ZipFile(zip_path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
    return sorted(item["name"] for item in manifest["items"])


def packaged_installer(zip_path: Path) -> str:
    """The installer notebook inside the zip: always the one that matches the package."""
    with zipfile.ZipFile(zip_path) as archive:
        return archive.read("installer/Setup_LoadTest_v3.ipynb").decode("utf-8")


def put_installer(client: Fabric, ws: str, body: dict) -> str:
    existing = [i for i in client.list_all(f"/v1/workspaces/{ws}/notebooks") if i["displayName"] == INSTALLER_NAME]
    if existing:
        item_id = existing[0]["id"]
        _, headers, _ = client.api("POST", f"/v1/workspaces/{ws}/notebooks/{item_id}/updateDefinition", {"definition": body["definition"]})
        client.wait_operation(headers)
        return item_id
    status, headers, created = client.api("POST", f"/v1/workspaces/{ws}/notebooks", body)
    return created["id"] if created.get("id") else client.wait_operation(headers, want_result=True)["id"]


def run_installer(client: Fabric, ws: str, item_id: str, timeout_min: int) -> dict:
    _, headers, _ = client.api("POST", f"/v1/workspaces/{ws}/items/{item_id}/jobs/instances?jobType=RunNotebook", {})
    location = headers["location"]
    deadline = time.time() + timeout_min * 60
    while True:
        _, h, state = client._call("GET", location, client.fabric_token)
        state = json.loads(state)
        if state["status"] in ("Completed", "Failed", "Cancelled", "Deduped"):
            return state
        if time.time() > deadline:
            raise DeployError("Timed out waiting for the installer notebook")
        client.sleep(int(h.get("retry-after", "10")))


def main(argv=None, http: Http | None = None, sleep=time.sleep) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    target = ap.add_mutually_exclusive_group(required=True)
    target.add_argument("--workspace", help="workspace display name")
    target.add_argument("--workspace-id", help="workspace id")
    ap.add_argument("--lakehouse", help="lakehouse name or id (default: the only one of the workspace)")
    ap.add_argument("--create-lakehouse", action="store_true", help="create the lakehouse if it does not exist")
    ap.add_argument("--package", type=Path, default=ROOT / "dist" / "FabricLoadTest_v3_package.zip")
    ap.add_argument("--installer", type=Path, help="installer notebook (default: the one inside the package zip)")
    ap.add_argument("--models-file", type=Path, help="JSON file with the `models` value (see samples/models.example.json)")
    ap.add_argument("--rls-source", choices=["list", "file", "none"])
    ap.add_argument("--rls-scope", choices=["global", "per_model"])
    ap.add_argument("--rls-users", help="comma-separated UPNs (global list)")
    ap.add_argument("--rls-users-file", help="global users file, e.g. /lakehouse/default/Files/PerfScenarios/Users/users.txt")
    ap.add_argument("--no-overwrite", action="store_true", help="abort if an item with the same name already exists")
    ap.add_argument("--dry-run", action="store_true", help="the installer only prints its plan")
    ap.add_argument("--keep-installer", action="store_true", help="do not delete the installer notebook afterwards")
    ap.add_argument("--timeout-min", type=int, default=20)
    args = ap.parse_args(argv)

    if args.workspace_id and not GUID.match(args.workspace_id):
        raise SystemExit("--workspace-id must be a GUID")
    if not args.package.exists():
        raise SystemExit(f"{args.package} not found: run `python tools/build_package.py` or download the zip from the Releases page")
    values = {"OVERWRITE": not args.no_overwrite, "DRY_RUN": args.dry_run}
    if args.models_file:
        values["MODELS"] = json.loads(args.models_file.read_text(encoding="utf-8"))
    for key, option in (("RLS_SOURCE", args.rls_source), ("RLS_SCOPE", args.rls_scope), ("RLS_USERS_FILE", args.rls_users_file)):
        if option:
            values[key] = option
    if args.rls_users:
        values["RLS_USERS"] = [u.strip() for u in re.split(r"[;,]", args.rls_users) if u.strip()]

    try:
        client = Fabric(http or Http(), os.environ.get("FABRIC_ACCESS_TOKEN") or az_token(FABRIC),
                        os.environ.get("STORAGE_ACCESS_TOKEN") or az_token("https://storage.azure.com"), sleep)
        ws = client.find_workspace(args.workspace, args.workspace_id)
        lakehouse = client.lakehouse(ws["id"], args.lakehouse, args.create_lakehouse)
        print(f"Workspace: {ws['displayName']}  Lakehouse: {lakehouse['displayName']}")
        client.upload(ws["id"], lakehouse["id"], f"Files/deploy/{args.package.name}", args.package.read_bytes())
        print(f"Uploaded {args.package.name} to Files/deploy/")
        installer_text = args.installer.read_text(encoding="utf-8") if args.installer else packaged_installer(args.package)
        installer_id = put_installer(client, ws["id"], build_installer(installer_text, values, ws["id"], lakehouse))
        print(f"Running {INSTALLER_NAME} (dry run: {args.dry_run}) ...")
        state = run_installer(client, ws["id"], installer_id, args.timeout_min)
        if state["status"] != "Completed":
            reason = json.dumps(state.get("failureReason") or {})[:500]
            raise DeployError(f"The installer ended {state['status']}: {reason}. Open the notebook run in the workspace (Monitor hub) for its output.")
        if not args.keep_installer and not args.dry_run:
            client.api("DELETE", f"/v1/workspaces/{ws['id']}/notebooks/{installer_id}")
        if not args.dry_run:
            names = {i["displayName"] for i in client.list_all(f"/v1/workspaces/{ws['id']}/items")}
            missing = [n for n in package_items(args.package) if n not in names]
            if missing:
                raise DeployError(f"The installer finished but these items are missing: {', '.join(missing)}")
            print("Deployed and verified: " + ", ".join(package_items(args.package)))
        else:
            print("Dry run finished: nothing was created. The installer notebook was kept: open its last run for the plan, or run again without --dry-run.")
    except DeployError as error:
        print(f"ERROR: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
