# egpt-daemon-task-labels.ps1 - the ONE place that says how the session 1 logon task describes
# itself. Dot-sourced by register-session1-daemon-task.ps1, which stamps it when it registers the
# task, and by migrations\0005 / 0043, which stamp it on a task registered before - so a fresh
# node and a migrated node carry the same line.
#
# ONE LINE, what it is first and what disabling it costs last. Since 2026-10-17 the task is the
# node's only runner; until then this line pointed at the session 0 service (0043 replaces it).
#
# NO XML METACHARACTERS (< > & " '). The migrations write this text into the task's exported
# XML verbatim and require the re-export to match byte for byte; Task Scheduler would escape
# them, and the lossless check would then refuse. setup\egpt-daemon-task-labels.Tests.ps1 holds it.
#
# NO TOP-LEVEL SIDE EFFECTS - dot-sourced, including by Pester. ASCII ONLY: PowerShell 5.1 reads
# a BOM-less UTF-8 script as ANSI.

function Get-EgptDaemonTaskDescription {
  return "eGPT spine supervisor (egpt-daemon.mjs) in session 1, started at logon - the only eGPT runner on this node. Disable it and the node stays silent."
}
