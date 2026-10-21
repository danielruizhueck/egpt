@echo off
REM grant-beeper-service-control.cmd - double-click ONCE: lets this user stop and start only this
REM machine's Beeper services, so a Beeper update needs no UAC. Asks for administrator itself.
REM Undo: revoke-beeper-service-control.cmd.   Preview, no admin:  grant-beeper-service-control.cmd -DryRun
setlocal
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0grant-beeper-service-control.ps1" -Pause %*
echo.
pause
