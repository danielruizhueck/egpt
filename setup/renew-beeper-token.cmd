@echo off
REM renew-beeper-token.cmd - double-click to renew a Beeper Desktop API token for eGPT.
REM Elevates, then runs renew-beeper-token.ps1: stops the connection's Beeper service, opens the
REM same install in a window, asks for the new token, writes it to config.yaml, starts the service
REM again and restarts the spine. Optional argument: primary or secondary.

setlocal
set "PS1=%~dp0renew-beeper-token.ps1"

net session >nul 2>&1
if %errorLevel% NEQ 0 (
  echo Requesting administrator privileges...
  if "%~1"=="" (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -Verb RunAs"
  ) else (
    powershell -NoProfile -Command "Start-Process -FilePath '%~f0' -ArgumentList '%~1' -Verb RunAs"
  )
  exit /b
)

if not exist "%PS1%" (
  echo ERROR: renew-beeper-token.ps1 not found next to this script.
  pause
  exit /b 1
)

if "%~1"=="" (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%"
) else (
  powershell -NoProfile -ExecutionPolicy Bypass -File "%PS1%" -Connection %~1
)
pause
