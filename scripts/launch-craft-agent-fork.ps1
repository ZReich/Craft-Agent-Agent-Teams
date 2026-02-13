param(
  [switch]$SkipLaunch
)
$ErrorActionPreference = "Stop"

$RepoPath = "C:\Users\monta\Documents\Craft-Agent-Agent-Teams"
$Branch = "feature/agent-teams-usage-tracking"

Write-Host "`n=== Craft Agent Fork Launcher ===" -ForegroundColor Cyan
Write-Host "Repo: $RepoPath"

if (!(Test-Path $RepoPath)) { throw "Repo path not found: $RepoPath" }

Write-Host "`n[1/6] Stopping running Craft Agent/Electron dev processes..." -ForegroundColor Yellow
$targets = Get-CimInstance Win32_Process -ErrorAction SilentlyContinue | Where-Object {
  $_.ProcessId -and $_.ProcessId -ne $PID -and (
    $_.Name -in @("Craft Agents.exe", "craft-agent.exe", "electron.exe") -or
    (
      $_.Name -in @("bun.exe", "node.exe", "electron.exe") -and
      $_.CommandLine -and
      ($_.CommandLine -match "Craft-Agent-Agent-Teams|craft-agent")
    )
  )
} | Group-Object ProcessId | ForEach-Object { $_.Group[0] }

if ($targets -and $targets.Count -gt 0) {
  foreach ($proc in $targets) {
    try {
      Stop-Process -Id $proc.ProcessId -Force -ErrorAction Stop
      Write-Host ("Stopped PID {0} ({1})" -f $proc.ProcessId, $proc.Name)
    } catch {
      Write-Host ("Could not stop PID {0} ({1})" -f $proc.ProcessId, $proc.Name) -ForegroundColor DarkYellow
    }
  }
} else {
  Write-Host "No matching background processes found."
}

Write-Host "`n[2/6] Clearing build caches..." -ForegroundColor Yellow

# Remove build output (same as electron:clean)
$distDir = Join-Path $RepoPath "apps\electron\dist"
$releaseDir = Join-Path $RepoPath "apps\electron\release"
if (Test-Path $distDir) { Remove-Item $distDir -Recurse -Force; Write-Host "  Cleared apps\electron\dist\" }
if (Test-Path $releaseDir) { Remove-Item $releaseDir -Recurse -Force; Write-Host "  Cleared apps\electron\release\" }

# Remove Vite caches (stale dependency pre-bundles)
$viteCaches = @(
  (Join-Path $RepoPath "apps\electron\node_modules\.vite"),
  (Join-Path $RepoPath "node_modules\.vite")
)
foreach ($cache in $viteCaches) {
  if (Test-Path $cache) { Remove-Item $cache -Recurse -Force; Write-Host "  Cleared $cache" }
}

# Remove MCP server build outputs (rebuilt every time anyway)
$mcpDists = @(
  (Join-Path $RepoPath "packages\bridge-mcp-server\dist"),
  (Join-Path $RepoPath "packages\session-mcp-server\dist")
)
foreach ($d in $mcpDists) {
  if (Test-Path $d) { Remove-Item $d -Recurse -Force; Write-Host "  Cleared $d" }
}

Write-Host "  Done." -ForegroundColor Green

Write-Host "`n[3/6] Refreshing code from GitHub..." -ForegroundColor Yellow
git -C $RepoPath fetch origin
git -C $RepoPath checkout $Branch
git -C $RepoPath pull --ff-only origin $Branch

Write-Host "`n[4/6] Refreshing dependencies..." -ForegroundColor Yellow
bun install --cwd $RepoPath

Write-Host "`n[5/6] Verifying Electron runtime..." -ForegroundColor Yellow
$electronExe = Join-Path $RepoPath "node_modules\electron\dist\electron.exe"
if (!(Test-Path $electronExe)) {
  Write-Host "Electron binary missing. Repairing install..." -ForegroundColor DarkYellow
  node (Join-Path $RepoPath "node_modules\electron\install.js")
}
if (!(Test-Path $electronExe)) { throw "Electron runtime is still missing after repair." }

if ($SkipLaunch) {
  Write-Host "`n[6/6] Skipping app launch (SkipLaunch switch set)." -ForegroundColor DarkYellow
  exit 0
}

Write-Host "`n[6/6] Starting Electron dev environment..." -ForegroundColor Yellow
Set-Location $RepoPath
bun run electron:dev
