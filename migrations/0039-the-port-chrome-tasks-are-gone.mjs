// 0039 — the `egpt-chrome` and `egpt-chrome-radio` scheduled tasks are gone.
//
// Both launched a Chrome with --remote-debugging-port, and an open loopback port let a boxed being
// in one chat drive the operator's signed-in brain Chrome. Every group's Chrome is now spine-held
// over --remote-debugging-pipe (plans/2610091931 rev 2026-10-11), so nothing fires these tasks;
// they were disabled by hand on 2026-10-11 and this removes them. A running instance is left alone.
//
// NOT ELEVATED: measured on reve 2026-10-11, both tasks run as the operator (RunLevel Limited) and
// carry the default DACL, in which the owning user has full access, so the owner unregisters them
// without administrator rights (as 0002 measured for egpt-daemon). A node where that fails refuses.
export const elevated = false;
export const summary = 'the egpt-chrome / egpt-chrome-radio scheduled tasks are unregistered';

export const TASKS = ['egpt-chrome', 'egpt-chrome-radio'];
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Read-only: which of TASKS are registered in the root folder.
export const probeScript = () => `# egpt-0039:probe
$scheduler = New-Object -ComObject Schedule.Service
$scheduler.Connect()
$folder = $scheduler.GetFolder('\\')
$found = @()
foreach ($n in @(${TASKS.map(q).join(', ')})) { try { $null = $folder.GetTask($n); $found += $n } catch { } }
ConvertTo-Json -Compress -InputObject @($found)
`;

export const unregisterScript = (name) => `# egpt-0039:unregister ${name}
Unregister-ScheduledTask -TaskName ${q(name)} -TaskPath '\\' -Confirm:$false -ErrorAction Stop
`;

export async function plan(ctx) {
  if (ctx.platform !== 'win32') return { satisfied: true, notes: [`no scheduled tasks on ${ctx.platform}`] };
  const registered = () => [].concat(JSON.parse(ctx.ps(probeScript()) || '[]'));
  const found = registered();
  if (!found.length) return { satisfied: true, notes: [`neither ${TASKS.join(' nor ')} is registered`] };
  return {
    satisfied: false,
    changes: found.map((n) => `unregister scheduled task ${n} (it launched a debug-port Chrome; a running instance is left alone)`),
    apply: async () => {
      for (const n of registered()) {
        ctx.log(`unregistering ${n}`);
        ctx.ps(unregisterScript(n));
      }
    },
  };
}
