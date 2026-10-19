@echo off
REM beeper-update.cmd - double-clickable launcher for beeper-update.ps1.
REM The .ps1 asks for administrator only when it must (a Beeper service this user may not stop).
REM Any arguments are passed straight through:  beeper-update.cmd -DryRun
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0beeper-update.ps1" -Pause %*
echo.
pause
