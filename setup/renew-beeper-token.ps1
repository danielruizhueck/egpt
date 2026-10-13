# renew-beeper-token.ps1 - renew one Beeper connection's Desktop API token.
# Beeper's Desktop API tokens expire (30 days by default), and a node whose token expired hears
# nothing. This stops that connection's Beeper service, opens the same install in a window, takes
# the new token you paste, writes it to config.yaml, starts the service again, checks the token,
# and restarts the spine so it reconnects.
# Run it via renew-beeper-token.cmd (it elevates: stopping a service needs admin).
param([ValidateSet('primary', 'secondary')][string]$Connection)
$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$egptHome = if ($env:EGPT_HOME) { $env:EGPT_HOME } else { Join-Path $env:USERPROFILE '.egpt' }

function Say([string]$m) { Write-Host "  $m" }

function Find-ApiPort([string]$Token) {
  foreach ($port in 23373..23382) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$port/v1/accounts" -Headers @{ Authorization = "Bearer $Token" }
      if ($r.StatusCode -eq 200) { return $port }
    } catch { }
  }
  return $null
}

function Norm([string]$p) { $p.Replace('\', '/').TrimEnd('/').ToLower() }

# Beeper processes on this profile. One started with no --user-data-dir is on the default profile,
# which is only ours when the service itself runs that way ($DefaultProfile) and in Session 0.
function Get-ProfileProcesses {
  $want = Norm $profileDir
  Get-CimInstance Win32_Process -Filter "Name='Beeper.exe'" | Where-Object {
    $cl = [string]$_.CommandLine
    if ($cl -match '--user-data-dir=(?:"([^"]+)"|(\S+))') { (Norm ($Matches[1] + $Matches[2])) -eq $want }
    else { $DefaultProfile -and $_.SessionId -eq 0 }
  }
}

function Wait-ProfileClosed([int]$Seconds) {
  for ($i = 0; $i -lt $Seconds; $i++) {
    if (-not (Get-ProfileProcesses)) { return }
    Start-Sleep -Seconds 1
  }
  Get-ProfileProcesses | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
  Start-Sleep -Seconds 2
}

Write-Host ''
Write-Host 'Renew a Beeper Desktop API token for eGPT'
Write-Host ''
if (-not $Connection) {
  $pick = (Read-Host '  Which connection? [1] primary  [2] secondary').Trim()
  $Connection = @{ '1' = 'primary'; '2' = 'secondary'; 'primary' = 'primary'; 'secondary' = 'secondary' }[$pick]
  if (-not $Connection) { throw "unknown choice '$pick'" }
}

$service = "egpt-beeper-$Connection"
if (-not (Get-Service -Name $service -ErrorAction SilentlyContinue)) { throw "no service named $service on this machine" }
$params = Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$service\Parameters"
$exe = $params.Application
if (-not $exe -or -not (Test-Path -LiteralPath $exe)) { throw "$service has no Beeper.exe configured (Application: '$exe')" }

$DefaultProfile = $false
if ([string]$params.AppParameters -match '--user-data-dir=(?:"([^"]+)"|(\S+))') { $profileDir = $Matches[1] + $Matches[2] }
else {
  $DefaultProfile = $true
  $runAs = (Get-CimInstance Win32_Service -Filter "Name='$service'").StartName
  $profileDir = if ($runAs -eq 'LocalSystem') { Join-Path $env:windir 'System32\config\systemprofile\AppData\Roaming\BeeperTexts' }
                else { Join-Path $env:APPDATA 'BeeperTexts' }
}
if (-not (Test-Path -LiteralPath $profileDir)) { throw "the profile $service uses is not there: $profileDir" }
Say "connection: $Connection   service: $service"
Say "profile:    $profileDir"

Say "stopping $service ..."
Stop-Service -Name $service -Force
Wait-ProfileClosed 30

Say 'opening Beeper on that profile ...'
Start-Process -FilePath $exe -ArgumentList "--user-data-dir=`"$profileDir`""

Write-Host ''
Say 'In the Beeper window: Settings > Integrations (Developers) > Desktop API.'
Say 'Keep "Allow connections" on, approve a NEW connection, set it to NEVER expire,'
Say 'and copy its token (its Copy button).'
Write-Host ''

# Read from the clipboard: a masked Read-Host in Windows PowerShell does not take a paste.
$token = $null
while (-not $token) {
  Read-Host '  Copy the token in Beeper, then press Enter here' | Out-Null
  $token = ([string](Get-Clipboard -Raw)).Trim()
  if ($token -notmatch '^\S{16,}$') {
    Say 'the clipboard does not hold a token (16+ characters, no spaces).'
    $token = (Read-Host '  Paste it here instead (Enter alone to retry the clipboard)').Trim()
    if ($token -notmatch '^\S{16,}$') { $token = $null }
  }
}
Set-Clipboard -Value ' '
Say ("got a token: " + $token.Length + " characters")
$port = Find-ApiPort $token
if ($port) { Say "the open Beeper accepts it (port $port)" }
else { Say 'the open Beeper does not answer to it yet; writing it anyway - the service is checked after it starts' }

$token | & node (Join-Path $repo 'setup\set-beeper-token.mjs') $Connection --config (Join-Path $egptHome 'config\config.yaml')
if ($LASTEXITCODE -ne 0) { throw 'config.yaml was NOT changed (see the line above)' }

Write-Host ''
Read-Host '  Quit the Beeper window (tray icon > Quit), then press Enter' | Out-Null
Wait-ProfileClosed 20
Start-Service -Name $service
Say "$service started; waiting for its API ..."
$port = $null
for ($i = 0; $i -lt 45 -and -not $port; $i += 5) { Start-Sleep -Seconds 5; $port = Find-ApiPort $token }
if ($port) { Say "the service accepts the new token (port $port)" } else { Say 'WARNING: the service did not accept the token within 45 s - check it in Beeper' }

$pidFile = Join-Path $egptHome 'state\spine.pid'
if (Test-Path -LiteralPath $pidFile) {
  $spinePid = (Get-Content -LiteralPath $pidFile -Raw).Trim()
  if ($spinePid -and (Get-Process -Id $spinePid -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $spinePid -Force
    Say "spine (pid $spinePid) restarted - its daemon brings it back with the new token"
  } else { Say 'no running spine found; it will read the new token when it starts' }
}
Write-Host ''
Say 'Done.'
