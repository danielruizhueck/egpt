# grant-beeper-service-control.ps1 - let the eGPT user stop and start ONLY this machine's
# Beeper services (the NSSM services running its Beeper.exe), so a Beeper update needs no UAC.
#
# One ACE per service: (A;;CCLCSWRPWPLORC;;;<user SID>) - query, start, stop; nothing else.
# Idempotent; prints each service's SDDL before and after. -Revoke takes it out again.
# -DryRun writes nothing (and needs no administrator).
#
# Run once, as administrator: grant-beeper-service-control.cmd / revoke-beeper-service-control.cmd.
# install-beeper-s0-service.ps1 grants the same ACE when it creates a service; this is for
# services created before it did. A node with no Beeper service needs none of this.
#
# ASCII ONLY: PowerShell 5.1 reads a BOM-less UTF-8 script as ANSI.
[CmdletBinding()]
param(
  # The user to grant: whoever ran this, carried through the UAC prompt (which may log in as another admin).
  [string] $Sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value,
  [string] $LocalAppData = $env:LOCALAPPDATA,
  [switch] $Revoke,
  [switch] $DryRun,
  [switch] $Pause
)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'beeper-desktop.ps1')

$id = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $DryRun -and -not (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  $a = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Sid', $Sid, '-LocalAppData', "`"$LocalAppData`"")
  if ($Revoke) { $a += '-Revoke' }
  if ($Pause) { $a += '-Pause' }
  Write-Host 'elevating...'
  Start-Process powershell -Verb RunAs -ArgumentList $a
  return
}

$exe = Join-Path $LocalAppData 'Programs\BeeperTexts\Beeper.exe'
$who = try { ([Security.Principal.SecurityIdentifier]$Sid).Translate([Security.Principal.NTAccount]).Value } catch { $Sid }
$services = @(Get-BeeperServices $exe)
if (-not $services.Count) {
  Write-Host "no Beeper service runs $exe on this machine - nothing to do (the Beeper app alone updates without administrator)"
} else {
  Write-Host "$(if ($Revoke) { 'revoking' } else { 'granting' }) start/stop on $($services.Count) Beeper service(s) for $who ($Sid)"
  foreach ($s in $services) { Set-BeeperServiceAccess -Name $s.Name -Sid $Sid -Revoke:$Revoke -DryRun:$DryRun }
}

if ($Pause) { Write-Host ''; Write-Host 'Press Enter to close...' -ForegroundColor Cyan; try { Read-Host | Out-Null } catch { } }
