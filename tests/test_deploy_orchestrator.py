"""Tests of tools/deploy_orchestrator.py against an in-memory fake of the Fabric and OneLake REST APIs."""
import base64
import json
import re

import pytest

import build_package
import deploy_orchestrator as deploy

WS = "11111111-1111-1111-1111-111111111111"
LH = "22222222-2222-2222-2222-222222222222"


class FakeFabric(deploy.Http):
    def __init__(self, lakehouses=None, job_status="Completed", throttle_first=False, async_create=False):
        self.calls, self.files, self.notebooks = [], {}, {}
        self.async_create = async_create
        self.lakehouses = list(lakehouses if lakehouses is not None else [{"id": LH, "displayName": "LoadTestLakehouse"}])
        self.job_status, self.throttle = job_status, throttle_first
        self.items = []

    def request(self, method, url, headers, body=None):
        self.calls.append((method, url))
        assert headers["Authorization"].startswith("Bearer ") and headers["x-ms-fabric-skill"]
        path = url.split("onelake.dfs.fabric.microsoft.com")[-1] if "onelake" in url else url.split("api.fabric.microsoft.com")[-1]
        if self.throttle and "/lakehouses" in path and method == "GET":
            self.throttle = False
            return 429, {"retry-after": "1"}, b""
        if "onelake" in url:
            key = path.split("?")[0]
            if "resource=file" in url:
                assert body == b"" and headers.get("Content-Length") == "0", "OneLake needs an explicit empty body"
                self.files[key] = b""
            elif "action=append" in url:
                self.files[key] += body
            return 200, {}, b""
        j = lambda obj, status=200, h=None: (status, h or {}, json.dumps(obj).encode())  # noqa: E731
        if method == "GET" and path == f"/v1/workspaces/{WS}":
            return j({"id": WS, "displayName": "Load Test"})
        if method == "GET" and path == "/v1/workspaces":
            return j({"value": [{"id": WS, "displayName": "Load Test"}]})
        if method == "GET" and path.startswith(f"/v1/workspaces/{WS}/lakehouses"):
            return j({"value": self.lakehouses})
        if method == "POST" and path == f"/v1/workspaces/{WS}/lakehouses":
            created = {"id": LH, "displayName": json.loads(body)["displayName"]}
            self.lakehouses.append(created)
            return j(created, 201)
        if method == "GET" and path.startswith(f"/v1/workspaces/{WS}/notebooks"):
            return j({"value": [{"id": k, "displayName": v["displayName"]} for k, v in self.notebooks.items()]})
        if method == "POST" and path == f"/v1/workspaces/{WS}/notebooks":
            definition = json.loads(body)
            self.notebooks["nb-1"] = definition
            if self.async_create:   # the real service answers 202 with an operation to poll and an empty (null) body
                return 202, {"location": "https://api.fabric.microsoft.com/v1/operations/op-create"}, b"null"
            return j({"id": "nb-1"}, 201)
        if method == "GET" and path == "/v1/operations/op-create/result":
            return j({"id": "nb-1"})
        if method == "GET" and path == "/v1/operations/op-create":
            return j({"status": "Succeeded"})
        if method == "POST" and path.endswith("/updateDefinition"):
            self.notebooks["nb-1"]["definition"] = json.loads(body)["definition"]
            return 202, {"location": "https://api.fabric.microsoft.com/v1/operations/op-1"}, b""
        if method == "GET" and path == "/v1/operations/op-1":
            return j({"status": "Succeeded"})
        if method == "POST" and "jobs/instances" in path:
            return 202, {"location": "https://api.fabric.microsoft.com/v1/jobs/job-1"}, b""
        if method == "GET" and path == "/v1/jobs/job-1":
            return j({"status": self.job_status, "failureReason": {"message": "verification failed"}} if self.job_status != "Completed"
                     else {"status": "Completed"})
        if method == "DELETE" and "/notebooks/" in path:
            self.notebooks.pop("nb-1", None)
            return 200, {}, b""
        if method == "GET" and path.startswith(f"/v1/workspaces/{WS}/items"):
            return j({"value": [{"displayName": n} for n in self.items]})
        raise AssertionError(f"unexpected call {method} {path}")


@pytest.fixture(scope="module")
def package(tmp_path_factory):
    return build_package.build(tmp_path_factory.mktemp("dist"))


@pytest.fixture(autouse=True)
def tokens(monkeypatch):
    monkeypatch.setenv("FABRIC_ACCESS_TOKEN", "fabric-token")
    monkeypatch.setenv("STORAGE_ACCESS_TOKEN", "storage-token")


def run(package, fake, *args):
    return deploy.main(["--workspace", "Load Test", "--package", str(package), *args], http=fake, sleep=lambda s: None)


def installer_parameters(fake):
    nb = json.loads(base64.b64decode(fake.notebooks["nb-1"]["definition"]["parts"][0]["payload"]))
    cell = next(c for c in nb["cells"] if "parameters" in c["metadata"].get("tags", []))
    return "".join(cell["source"]), nb["metadata"]["dependencies"]["lakehouse"]


def test_full_deployment_uploads_patches_runs_and_verifies(package, capsys):
    fake = FakeFabric()
    fake.items = deploy.package_items(package)
    models = package.parent / "models.json"
    models.write_text(json.dumps([{"model_key": "Sales", "dataset": "Sales", "workspace": "", "ramp_levels": [5, 10], "enable_think_times": False,
                                   "queryfile": "/lakehouse/default/Files/PerfScenarios/Queries/nav.json"}]))
    assert run(package, fake, "--models-file", str(models), "--rls-source", "file", "--rls-scope", "per_model", "--no-overwrite") == 0
    assert fake.files[f"/{WS}/{LH}/Files/deploy/FabricLoadTest_v3_package.zip"] == package.read_bytes()
    assert "nb-1" not in fake.notebooks, "the installer notebook is deleted after a successful deployment"
    assert "Deployed and verified" in capsys.readouterr().out


def test_parameters_are_patched_as_python_and_the_lakehouse_is_bound(package):
    fake = FakeFabric()
    models = package.parent / "models2.json"
    models.write_text(json.dumps([{"model_key": "A", "dataset": "A", "enable_think_times": False, "ramp_levels": [1, 2]}]))
    run(package, fake, "--models-file", str(models), "--rls-source", "list", "--rls-users", "a@contoso.com; b@contoso.com", "--dry-run")
    source, lakehouse = installer_parameters(fake)
    namespace = {}
    exec(compile(source, "parameters", "exec"), namespace)  # valid Python, with real booleans
    assert namespace["MODELS"][0]["enable_think_times"] is False and namespace["MODELS"][0]["ramp_levels"] == [1, 2]
    assert namespace["DRY_RUN"] is True and namespace["OVERWRITE"] is True
    assert namespace["RLS_SOURCE"] == "list" and namespace["RLS_USERS"] == ["a@contoso.com", "b@contoso.com"]
    assert namespace["RLS_SCOPE"] is None and namespace["PACKAGE_PATH"].endswith("FabricLoadTest_v3_package.zip")
    assert lakehouse["default_lakehouse"] == LH and lakehouse["default_lakehouse_workspace_id"] == WS
    assert "nb-1" in fake.notebooks, "a dry run keeps the installer so its output can be read"


def test_an_existing_installer_is_updated_not_duplicated(package):
    fake = FakeFabric()
    fake.notebooks["nb-1"] = {"displayName": "Setup_LoadTest_v3", "definition": {}}
    run(package, fake, "--dry-run")
    assert not any(m == "POST" and u.endswith("/notebooks") for m, u in fake.calls)
    assert any(u.endswith("/notebooks/nb-1/updateDefinition") for m, u in fake.calls)


def test_a_failed_installer_reports_the_reason_and_keeps_the_notebook(package, capsys):
    fake = FakeFabric(job_status="Failed")
    assert run(package, fake) == 1
    assert "verification failed" in capsys.readouterr().err and "nb-1" in fake.notebooks


def test_missing_items_after_a_completed_run_is_an_error(package, capsys):
    fake = FakeFabric()
    fake.items = ["RunLoadTest_v3"]
    assert run(package, fake) == 1
    assert "missing" in capsys.readouterr().err


def test_lakehouse_selection_rules(package, capsys):
    assert run(package, FakeFabric(lakehouses=[])) == 1 and "no lakehouse" in capsys.readouterr().err
    two = [{"id": LH, "displayName": "A"}, {"id": "x", "displayName": "B"}]
    assert run(package, FakeFabric(lakehouses=two)) == 1 and "several lakehouses" in capsys.readouterr().err
    created = FakeFabric(lakehouses=[])
    assert run(package, created, "--create-lakehouse", "--dry-run") == 0 and created.lakehouses[0]["displayName"] == "LoadTestLakehouse"


def test_throttling_is_retried(package):
    assert run(package, FakeFabric(throttle_first=True), "--dry-run") == 0


def test_creation_answered_asynchronously_with_an_empty_body(package):
    fake = FakeFabric(async_create=True)
    assert run(package, fake, "--dry-run") == 0 and "nb-1" in fake.notebooks


def test_tokens_never_appear_in_urls_or_output(package, capsys):
    fake = FakeFabric()
    run(package, fake, "--dry-run")
    out = capsys.readouterr()
    assert not any("token" in url.lower() for _, url in fake.calls)
    assert "fabric-token" not in out.out + out.err and "storage-token" not in out.out + out.err


@pytest.mark.parametrize("bad", ["x&calc", "a|b", "$(whoami)", "x;y", "`id`"])
def test_the_subscription_is_validated_before_it_reaches_the_az_command(monkeypatch, bad):
    monkeypatch.setenv("AZ_SUBSCRIPTION_ID", bad)
    monkeypatch.setattr(deploy.shutil, "which", lambda name: "az")
    monkeypatch.setattr(deploy.subprocess, "run", lambda *a, **k: pytest.fail("az must not run with an unsafe subscription"))
    with pytest.raises(deploy.DeployError, match="AZ_SUBSCRIPTION_ID"):
        deploy.az_token(deploy.FABRIC)


def test_az_runs_without_a_shell(monkeypatch):
    seen = {}
    monkeypatch.setenv("AZ_SUBSCRIPTION_ID", "My Subscription (1)")
    monkeypatch.setattr(deploy.shutil, "which", lambda name: "C:/az/az.cmd")
    monkeypatch.setattr(deploy.subprocess, "run", lambda cmd, **k: seen.update(cmd=cmd, kw=k) or type("R", (), {"stdout": "tok\n"})())
    assert deploy.az_token(deploy.FABRIC) == "tok"
    assert seen["cmd"][0] == "C:/az/az.cmd" and "shell" not in seen["kw"] and seen["cmd"][-1] == "My Subscription (1)"


@pytest.mark.parametrize("bad", ["not-a-guid", "1234"])
def test_workspace_id_must_be_a_guid(package, bad):
    with pytest.raises(SystemExit):
        deploy.main(["--workspace-id", bad, "--package", str(package)], http=FakeFabric())


def test_patch_parameters_rejects_unknown_names():
    with pytest.raises(deploy.DeployError):
        deploy.patch_parameters("A = 1\n", {"B": 2})
    assert re.search(r"^A = 2$", deploy.patch_parameters("A = 1   # note\n", {"A": 2}), re.M) is None  # the comment is kept
