# start-egpt.ps1 - THE WAY BACK from setup\stop-egpt.cmd.
#
# Normally you do not run this by hand - double-click setup\start-egpt.cmd.
#
# Undoes the stop, in the mirror order:
#   1. DELETE  EGPT_HOME\STOP  - while that file exists boot refuses to start, so
#      starting the task without deleting it just makes the spine exit again.
#      Its contents are printed first: it records who stopped the node and why.
#   2. START the Session 1 task (setup/register-session1-daemon-task.ps1) - unless its
#      daemon is already up. The task is MultipleInstances=IgnoreNew, so a stale
#      Running instance is stopped first or the start would be a no-op.
#
# Idempotent: no STOP file / an already-running daemon are both fine.
# No elevation: the task is the operator's own.
#
#   powershell -ExecutionPolicy Bypass -File .\setup\start-egpt.ps1
#   powershell -ExecutionPolicy Bypass -File .\setup\start-egpt.ps1 -EgptHome "$env:USERPROFILE\.egpt-secondary"

param(
  [string]$EgptHome = $(if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }),
  [string]$TaskName = ''
)

$ErrorActionPreference = 'Stop'

# --- 1. same profile -> task-name derivation the registrar uses ---
$base = (Split-Path $EgptHome -Leaf) -replace '^\.', ''   # ".egpt-secondary" -> "egpt-secondary"
if (-not $TaskName) {
  # THROW, never fall back to 'egpt' (2026-09-11): an empty leaf means EgptHome arrived
  # empty or mangled, and silently resolving that to the PRIMARY node is how a start aimed
  # at one node lands on another.
  if (-not $base) { throw "cannot derive a task name: -EgptHome is empty or has no leaf ('$EgptHome'). Pass -TaskName explicitly." }
  $TaskName = "$base-daemon"
}
$log = Join-Path (Join-Path $EgptHome 'config') 'logs\session1-daemon.log'

Write-Host ""
Write-Host "Starting egpt:" -ForegroundColor Cyan
Write-Host "  profile : $EgptHome   (EGPT_HOME)"
Write-Host "  task    : $TaskName"
Write-Host ""

$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
if (-not $task) {
  Write-Host "No scheduled task named '$TaskName' on this machine." -ForegroundColor Yellow
  Write-Host "  Register it with: powershell -ExecutionPolicy Bypass -File setup\register-session1-daemon-task.ps1 -EgptHome `"$EgptHome`""
  exit 1
}

# --- 2. clear the kill switch (printing WHY the node was stopped) ---
$stopFile = Join-Path $EgptHome 'STOP'
if (Test-Path $stopFile) {
  Write-Host "The node was stopped by this file:" -ForegroundColor Yellow
  Get-Content $stopFile | ForEach-Object { Write-Host "  | $_" -ForegroundColor DarkGray }
  Remove-Item $stopFile -Force
  Write-Host "Removed $stopFile" -ForegroundColor Green
} else {
  Write-Host "No STOP file at $stopFile - nothing to clear." -ForegroundColor DarkGray
}

# --- 3. start the task ---
# The daemon's pid, if state\daemon-s1.pid names a live egpt-daemon.mjs; else $null (pids are reused).
function Get-LiveDaemon {
  $path = Join-Path (Join-Path $EgptHome 'state') 'daemon-s1.pid'
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  $n = 0
  if (-not [int]::TryParse("$(Get-Content -LiteralPath $path -Raw)".Trim(), [ref]$n) -or $n -le 0) { return $null }
  $p = Get-CimInstance Win32_Process -Filter "ProcessId=$n" -ErrorAction SilentlyContinue
  if ($p -and $p.CommandLine -match 'egpt-daemon\.mjs') { return $n }
  return $null
}
$running = Get-LiveDaemon
if ($running) {
  Write-Host "The daemon was already running (pid $running)." -ForegroundColor DarkGray
} else {
  if ("$($task.State)" -eq 'Running') { Stop-ScheduledTask -TaskName $TaskName }
  Write-Host "Starting task $TaskName..." -ForegroundColor Yellow
  Start-ScheduledTask -TaskName $TaskName
  $sw = [Diagnostics.Stopwatch]::StartNew()
  while ($sw.Elapsed.TotalSeconds -lt 20 -and -not ($running = Get-LiveDaemon)) { Start-Sleep -Milliseconds 500 }
}

Write-Host ""
if ($running) {
  Write-Host "=== egpt is running ($TaskName, daemon pid $running) ===" -ForegroundColor Green
  Write-Host "  Watch it:  Get-Content `"$log`" -Tail 20 -Wait"
  Write-Host "  Stop it:   setup\stop-egpt.cmd"
} else {
  Write-Host "No daemon came up within 20s." -ForegroundColor Red
  Write-Host "  Check: Get-Content `"$log`" -Tail 40"
  exit 1
}
