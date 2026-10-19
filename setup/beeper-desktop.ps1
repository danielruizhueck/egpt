# beeper-desktop.ps1 - helpers for this machine's Beeper Desktop installs: the optional eGPT
# Beeper services, who may stop/start them, the tokens in config.yaml and the API port each answers.
# Dot-sourced by src\tools\beeper-update.ps1, grant-beeper-service-control.ps1,
# install-beeper-s0-service.ps1, renew-beeper-token.ps1 and egpt-wake-duty.ps1.
# Functions only: no top-level side effects (tests dot-source it).
#
# ASCII ONLY: PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI.

$BeeperApiPorts = 23373..23382   # a Desktop's API binds the first free port from 23373
$BeeperServiceRights = 'CCLCSWRPWPLORC'   # query, start (RP), stop (WP), interrogate, read control

# The NSSM services whose program is this Beeper.exe. None = the baseline: the Beeper app alone.
function Get-BeeperServices([string] $Exe) {
  Get-CimInstance Win32_Service | Where-Object { $_.PathName -match 'nssm' } | ForEach-Object {
    $app = (Get-ItemProperty "HKLM:\SYSTEM\CurrentControlSet\Services\$($_.Name)\Parameters" -ErrorAction SilentlyContinue).Application
    if ($app -and $app -ieq $Exe) { [pscustomobject]@{ Name = $_.Name; Running = ($_.State -eq 'Running') } }
  }
}

# May this process stop and start the service? Asks the SCM for exactly those rights; changes nothing.
function Test-BeeperServiceControl([string] $Name) {
  if (-not ('EgptBeeper.Scm' -as [type])) {
    Add-Type -Namespace EgptBeeper -Name Scm -MemberDefinition @'
[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenSCManager(string machine, string db, uint access);
[DllImport("advapi32.dll", SetLastError = true, CharSet = CharSet.Unicode)] public static extern IntPtr OpenService(IntPtr scm, string name, uint access);
[DllImport("advapi32.dll")] public static extern bool CloseServiceHandle(IntPtr h);
'@
  }
  $scm = [EgptBeeper.Scm]::OpenSCManager([NullString]::Value, [NullString]::Value, 1)   # SC_MANAGER_CONNECT
  if ($scm -eq [IntPtr]::Zero) { return $false }
  try {
    $h = [EgptBeeper.Scm]::OpenService($scm, $Name, 0x3C)   # START | STOP | ENUMERATE_DEPENDENTS | QUERY_STATUS: what Stop-/Start-Service use
    if ($h -eq [IntPtr]::Zero) { return $false }
    [void][EgptBeeper.Scm]::CloseServiceHandle($h)
    return $true
  } finally { [void][EgptBeeper.Scm]::CloseServiceHandle($scm) }
}

# --- the service's security descriptor (SDDL), as text ---------------------------------------
function Get-SddlAllowAces([string] $Sddl) {
  [regex]::Matches($Sddl, '\(A;([^;()]*);([^;()]*);([^;()]*);([^;()]*);([^;()]*)\)')
}

# Does an allow ACE give $Sid both start (RP) and stop (WP)?
function Test-BeeperServiceAce([string] $Sddl, [string] $Sid) {
  foreach ($m in Get-SddlAllowAces $Sddl) {
    if ($m.Groups[5].Value -ne $Sid) { continue }
    $r = $m.Groups[2].Value
    if ($r -match '^0x') { $v = [Convert]::ToInt32($r, 16); if (($v -band 0x30) -eq 0x30) { return $true }; continue }
    $codes = [regex]::Matches($r, '..') | ForEach-Object { $_.Value }
    if ($codes -contains 'RP' -and $codes -contains 'WP') { return $true }
  }
  return $false
}

# Where the DACL's ACE list ends: after D:, its flags and its (...) entries.
function Get-SddlDaclEnd([string] $Sddl) {
  $i = $Sddl.IndexOf('D:')
  if ($i -lt 0) { throw "no DACL in '$Sddl'" }
  $j = $i + 2
  while ($j -lt $Sddl.Length -and $Sddl[$j] -match '[A-Z_]' -and -not ($j + 1 -lt $Sddl.Length -and $Sddl[$j + 1] -eq ':')) { $j++ }
  while ($j -lt $Sddl.Length -and $Sddl[$j] -eq '(') {
    $k = $Sddl.IndexOf(')', $j)
    if ($k -lt 0) { throw "unterminated ACE in '$Sddl'" }
    $j = $k + 1
  }
  return $j
}

function Add-BeeperServiceAce([string] $Sddl, [string] $Sid) {
  if (Test-BeeperServiceAce $Sddl $Sid) { return $Sddl }
  return $Sddl.Insert((Get-SddlDaclEnd $Sddl), "(A;;$BeeperServiceRights;;;$Sid)")
}

function Remove-BeeperServiceAce([string] $Sddl, [string] $Sid) {
  return [regex]::Replace($Sddl, '\(A;[^;()]*;[^;()]*;[^;()]*;[^;()]*;' + [regex]::Escape($Sid) + '\)', '')
}

# Grant (or -Revoke) $Sid start/stop on one service. Prints the SDDL before and after; idempotent.
function Set-BeeperServiceAccess {
  param([string] $Name, [string] $Sid, [switch] $Revoke, [switch] $DryRun)
  $before = ((& sc.exe sdshow $Name) -join '').Trim()
  if ($LASTEXITCODE -ne 0 -or $before -notmatch 'D:') { throw "sc.exe sdshow $Name failed: $before" }
  $after = if ($Revoke) { Remove-BeeperServiceAce $before $Sid } else { Add-BeeperServiceAce $before $Sid }
  Write-Host "  $Name before: $before"
  Write-Host "  $Name after:  $after"
  if ($after -eq $before) { Write-Host "  $Name unchanged"; return }
  if ($DryRun) { Write-Host "  $Name -DryRun: not written"; return }
  $out = (& sc.exe sdset $Name $after) -join ' '
  if ($LASTEXITCODE -ne 0) { throw "sc.exe sdset $Name failed: $out" }
  Write-Host "  $Name written"
}

# --- tokens and ports ------------------------------------------------------------------------
# connection name -> token, read from config.yaml by eGPT's own reader. Never print the values.
function Get-BeeperTokens([string] $RepoRoot, [string] $EgptHome) {
  $io = ([Uri](Join-Path $RepoRoot 'src\tools\config-io.mjs')).AbsoluteUri
  $js = 'const m = await import(process.argv[1]); const b = m.readConfigSync()?.beeper ?? {}; const o = {}; for (const [k, v] of Object.entries(b)) if (v && typeof v === ''object'' && v.token) o[k] = v.token; console.log(JSON.stringify(o));'
  $prev = $env:EGPT_HOME
  if ($EgptHome) { $env:EGPT_HOME = $EgptHome }
  try { $json = & node --input-type=module -e $js $io } finally { $env:EGPT_HOME = $prev }
  $t = @{}
  if ($LASTEXITCODE -eq 0 -and $json) {
    (($json | Out-String) | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $t[$_.Name] = [string]$_.Value }
  }
  return $t
}

# The port whose Desktop answers this token (200 on /v1/accounts), or $null.
function Find-BeeperPort([string] $Token) {
  foreach ($port in $BeeperApiPorts) {
    try {
      $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 3 -Uri "http://127.0.0.1:$port/v1/accounts" -Headers @{ Authorization = "Bearer $Token" }
      if ($r.StatusCode -eq 200) { return $port }
    } catch { }
  }
  return $null
}

# The Beeper version serving a port (/v1/info needs no token), or $null.
function Get-BeeperVersionAt([int] $Port) {
  try { return [string](Invoke-RestMethod -TimeoutSec 3 -Uri "http://127.0.0.1:$Port/v1/info").app.version } catch { return $null }
}
