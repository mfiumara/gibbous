# Run Gibbous at logon on Windows and keep it running: a per-user Scheduled Task that starts
# `node server\main.ts` hidden (no console window), restarts it if it stops, and logs to %USERPROFILE%\.gibbous\gibbous.log.
# Re-run after moving the repo.   powershell -ExecutionPolicy Bypass -File scripts\install-service.ps1
# Restart:  Stop-ScheduledTask -TaskName Gibbous; Start-ScheduledTask -TaskName Gibbous
# Uninstall: scripts\uninstall.ps1
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$GibbousHome = if ($env:GIBBOUS_HOME) { $env:GIBBOUS_HOME } else { Join-Path $env:USERPROFILE '.gibbous' }
$TaskName = 'Gibbous'
New-Item -ItemType Directory -Force -Path $GibbousHome | Out-Null

$node = (Get-Command node.exe -ErrorAction SilentlyContinue).Source
if (-not $node) { throw 'node.exe is not on PATH. Install Node.js 22 or newer first.' }
if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) { throw 'pnpm is not on PATH (corepack enable, or npm i -g pnpm).' }

Push-Location $Root
try {
  pnpm install --frozen-lockfile | Out-Null
  if ($LASTEXITCODE) { throw 'pnpm install failed' }
  pnpm build | Out-Null
  if ($LASTEXITCODE) { throw 'pnpm build failed' }
} finally { Pop-Location }

# A tiny launcher so the task can redirect output to the log (Task Scheduler itself can't). Started through
# conhost --headless (or a hidden PowerShell on older Windows) so no window ever shows.
$launcher = Join-Path $GibbousHome 'run-gibbous.cmd'
$log = Join-Path $GibbousHome 'gibbous.log'
Set-Content -Path $launcher -Encoding ASCII -Value @"
@echo off
cd /d "$Root"
"$node" --disable-warning=ExperimentalWarning server\main.ts >> "$log" 2>&1
"@

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -WorkingDirectory $Root `
  -Argument "-NoLogo -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command `"& '$launcher'`""
$trigger = New-ScheduledTaskTrigger -AtLogOn -User "$env:USERDOMAIN\$env:USERNAME"
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
  -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited

Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
  -Description 'Gibbous: web cockpit for Hermes (node server\main.ts)' | Out-Null
Start-ScheduledTask -TaskName $TaskName

$loginUrl = Join-Path $GibbousHome 'login-url'
for ($i = 0; $i -lt 20 -and -not (Test-Path $loginUrl); $i++) { Start-Sleep -Seconds 1 }
if (Test-Path $loginUrl) {
  Write-Host 'Gibbous is running. Log in on this PC with:'
  Get-Content $loginUrl
} else {
  Write-Host "Gibbous didn't write its sign-in link yet; see $log"
}
