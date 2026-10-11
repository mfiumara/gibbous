# Remove Gibbous from this PC: the logon Scheduled Task, the tailnet port, its MCP entry in Hermes and the Hermes
# backend it started. Your data in %USERPROFILE%\.gibbous stays unless you pass -Purge (that also deletes task
# worktrees). Hermes itself and your conversations are untouched.
#   powershell -ExecutionPolicy Bypass -File scripts\uninstall.ps1 [-Purge]
param([switch]$Purge)
$GibbousHome = if ($env:GIBBOUS_HOME) { $env:GIBBOUS_HOME } else { Join-Path $env:USERPROFILE '.gibbous' }
function Say($m) { Write-Host "• $m" }

if (Get-ScheduledTask -TaskName 'Gibbous' -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName 'Gibbous' -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName 'Gibbous' -Confirm:$false
  Say 'stopped and removed the Gibbous scheduled task'
}
# Ending the task may leave its node.exe behind: stop the server it ran (any node running server\main.ts from this repo).
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*server\main.ts*' -and (Get-Process -Id $_.ProcessId -ErrorAction SilentlyContinue) -and ($_.ExecutablePath) -and ((Get-CimInstance Win32_Process -Filter "ProcessId = $($_.ParentProcessId)" -ErrorAction SilentlyContinue).CommandLine -like '*run-gibbous.cmd*') } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue; Say "stopped the Gibbous server (pid $($_.ProcessId))" }
Remove-Item (Join-Path $GibbousHome 'run-gibbous.cmd') -ErrorAction SilentlyContinue

if (Get-Command tailscale -ErrorAction SilentlyContinue) {
  $port = if ($env:GIBBOUS_TS_PORT) { $env:GIBBOUS_TS_PORT } else { 8444 }
  tailscale serve --https=$port off 2>$null | Out-Null
  if (-not $LASTEXITCODE) { Say "closed tailnet port $port" }
}
$hermes = if ($env:HERMES_BIN) { $env:HERMES_BIN } else { (Get-Command hermes -ErrorAction SilentlyContinue).Source }
if ($hermes) { & $hermes mcp remove gibbous 2>$null | Out-Null; if (-not $LASTEXITCODE) { Say 'removed the gibbous MCP server from Hermes' } }

# The `hermes serve` Gibbous spawned (detached, so it outlived the task). Only stop it if that pid still holds its port.
$backend = Join-Path $GibbousHome 'hermes-backend.json'
if (Test-Path $backend) {
  $b = Get-Content $backend -Raw | ConvertFrom-Json
  if ($b.pid -and $b.port) {
    $holds = Get-NetTCPConnection -State Listen -LocalPort $b.port -ErrorAction SilentlyContinue | Where-Object { $_.OwningProcess -eq $b.pid }
    if ($holds) { Stop-Process -Id $b.pid -Force -ErrorAction SilentlyContinue; Say "stopped the Hermes backend (pid $($b.pid))" }
  }
}

if ($Purge) {
  Remove-Item -Recurse -Force $GibbousHome -ErrorAction SilentlyContinue
  Say "deleted $GibbousHome (state, secrets, logs, worktrees)"
} else {
  Say "kept your data in $GibbousHome (run with -Purge to delete it)"
}
