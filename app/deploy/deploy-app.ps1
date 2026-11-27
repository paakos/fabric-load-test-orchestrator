<#
.SYNOPSIS
  Builds the Load Test app in a scratch folder and publishes it as a Fabric App with rayfin-cli (static hosting).

.DESCRIPTION
  Nothing is hard-coded: every id comes from a parameter. The script never installs or builds inside the repository:
  it copies the repository (without promotion-gate, .git and node_modules) to -WorkDir, writes app\.env there, runs
  `npm ci` and `npx rayfin up`. Run it with -WhatIf to see the plan without changing anything.

  Prerequisites: Node 20, 22 or 24 (rayfin-cli does not support Node 26), a Microsoft Entra SPA registration with the redirect
  URI <origin>/blank.html (see app\README.md) and a workspace in a region that supports Fabric Apps.

.PARAMETER AppWorkspaceId   Workspace (GUID) that will hold the Fabric App item.
.PARAMETER ClientId         Client id (GUID) of the Entra SPA registration.
.PARAMETER TenantId         Tenant id (GUID) or 'organizations'.
.PARAMETER ItemName         Name of the Fabric App item.
.PARAMETER DefaultWorkspaceId  Optional: workspace preselected on the Environment page (the one with the orchestrator).
.PARAMETER WarnWorkspaces   Optional: workspace display names the app warns about.
.PARAMETER WorkDir          Scratch folder for the build (default: a folder in the system temp path).
.PARAMETER UseAzToken       Use the signed-in Azure CLI account for rayfin (RAYFIN_TOKEN / RAYFIN_TENANT_ID) instead of `rayfin login`.
.PARAMETER Subscription     Optional: Azure subscription (id or name) whose account `az` must use when it is signed in to several tenants.

.EXAMPLE
  pwsh app\deploy\deploy-app.ps1 -AppWorkspaceId <guid> -ClientId <guid> -TenantId <guid> -WhatIf
#>
[CmdletBinding(SupportsShouldProcess)]
param(
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$AppWorkspaceId,
  [Parameter(Mandatory)][ValidatePattern('^[0-9a-fA-F-]{36}$')][string]$ClientId,
  [string]$TenantId = 'organizations',
  [string]$ItemName = 'LoadTestApp',
  [string]$DefaultWorkspaceId = '',
  [string]$WarnWorkspaces = '',
  [string]$WorkDir = (Join-Path ([IO.Path]::GetTempPath()) 'loadtest-app-deploy'),
  [switch]$UseAzToken,
  [string]$Subscription = ''
)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$workApp = Join-Path $WorkDir 'app'

$nodeMajor = [int]((node -v) -replace '^v(\d+)\..*', '$1')
if ($nodeMajor -notin 20, 22, 24) { throw "Node $nodeMajor is not supported by rayfin-cli: use Node 20, 22 or 24." }

if ($PSCmdlet.ShouldProcess($WorkDir, 'Copy the repository (without promotion-gate, .git, node_modules)')) {
  New-Item -ItemType Directory -Force $WorkDir | Out-Null
  robocopy $repo $WorkDir /MIR /XD promotion-gate .git .github node_modules dist .rayfin /XF *.zip *.pem .env .env.local /NFL /NDL /NJH /NJS | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "robocopy failed with code $LASTEXITCODE" }
}

$envLines = @(
  '# Written by deploy-app.ps1. Public ids only, no secrets.',
  "VITE_MSAL_CLIENT_ID=$ClientId", "VITE_MSAL_TENANT_ID=$TenantId",
  "VITE_DEFAULT_WORKSPACE_ID=$DefaultWorkspaceId", "VITE_WARN_WORKSPACES=$WarnWorkspaces")
if ($PSCmdlet.ShouldProcess((Join-Path $workApp '.env'), 'Write the app configuration')) {
  Set-Content (Join-Path $workApp '.env') $envLines -Encoding utf8
}

if ($WhatIfPreference -and -not (Test-Path $workApp)) { Write-Host "What if: npm ci and rayfin up would run in $workApp"; return }
Push-Location $workApp
try {
  if ($PSCmdlet.ShouldProcess($workApp, 'npm ci')) { npm ci --no-audit --no-fund; if ($LASTEXITCODE) { throw 'npm ci failed' } }
  if ($UseAzToken) {
    $sub = if ($Subscription) { @('--subscription', $Subscription) } else { @() }
    $token = az account get-access-token --resource https://api.fabric.microsoft.com --query accessToken -o tsv @sub
    $env:RAYFIN_TOKEN = $token
    $env:RAYFIN_TENANT_ID = (az account show --query tenantId -o tsv @sub)
  }
  if ($PSCmdlet.ShouldProcess("workspace $AppWorkspaceId", "rayfin up --item-name $ItemName (build, static hosting)")) {
    npx rayfin up --workspace-id $AppWorkspaceId --item-name $ItemName --yes
    if ($LASTEXITCODE) { throw "rayfin up failed with code $LASTEXITCODE" }
    Write-Host 'Done. Add <hosting url>/blank.html to the redirect URIs of the Entra SPA registration (Single-page application platform).'
  }
} finally { Pop-Location }
