// 0001 — the Beeper services carry their ROLE: egpt-beeper-primary, egpt-beeper-secondary.
//
// NODE-SHAPE.md: "Beeper is named for its role - the same word as its config key", and never
// for an account. On 2026-09-16 kg already matched; do still ran `egpt-primary` and `BeeperRodz`.
//
// WHAT IT DOES NOT DO: implement a rename. setup/rename-beeper-s0-service.ps1 owns that - it
// copies the whole nssm Parameters subtree, carries the service-key settings nssm does not own,
// orders stop -> create -> copy -> remove so nothing is destroyed before its replacement exists,
// and rolls back a half-built service. This migration only decides WHICH renames, from evidence,
// and calls it. The legacy names come from the one map in setup/beeper-s0-naming.ps1.
//
// THE ROLE COMES FROM THE LEGACY NAME'S OWN SUFFIX (egpt-primary / egpt-secondary). It used to
// come from the CDP port; the services expose none since 2026-10-11. An account-named install
// (BeeperAn / BeeperRodz) carries no role and the map's target for it is a guess, so it is refused
// by name, as are a map that disagrees with the name, a missing --user-data-dir, two services
// sharing one, or a target name that already exists - a human decides those, not a deploy.
//
// ELEVATED: deleting and creating services needs administrator rights. Reading them does not,
// so an unelevated run still recognises a node that is already there.
//
// DOWNTIME: each rename stops that Desktop, so that account is offline for the seconds between
// stop and start. The SECONDARY goes first: the primary is the ear that wakes the spine, so it
// stays up the longest.
import { join } from 'node:path';

export const elevated = true;
export const summary = 'Beeper services are named for their role (egpt-beeper-primary / egpt-beeper-secondary)';

const LOCAL_SYSTEM = /^(\.\\)?LocalSystem$|^NT AUTHORITY\\SYSTEM$/i;

const refuse = (why) => { throw new Error(`0001 refuses: ${why}`); };
const roleOf = (name) => (/-primary$/i.test(name) ? 'primary' : /-secondary$/i.test(name) ? 'secondary' : null);
const normDir = (p) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();

// Read-only. Dot-sources the naming module for the map, then reports every service the map
// names - legacy or target - that exists on this node.
const probeScript = (repo) => `
. '${join(repo, 'setup', 'beeper-s0-naming.ps1').replace(/'/g, "''")}'
$map = Get-BeeperS0LegacyNameMap
$pairs = @($map.Keys | ForEach-Object { @{ old = $_; new = $map[$_] } })
$names = @($map.Keys) + @($map.Values) | Select-Object -Unique
$services = @()
foreach ($n in $names) {
  $svc = Get-CimInstance Win32_Service -Filter "Name='$n'"
  if (-not $svc) { continue }
  $p = Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Services\\$($svc.Name)\\Parameters" -ErrorAction SilentlyContinue
  $services += @{ name = $svc.Name; state = $svc.State; startMode = $svc.StartMode; startName = $svc.StartName; application = "$($p.Application)"; appParameters = "$($p.AppParameters)" }
}
ConvertTo-Json -Depth 4 -Compress -InputObject @{ map = $pairs; services = $services }
`;

const userDataDirs = (svc) => [...(svc.appParameters ?? '').matchAll(/--user-data-dir=(?:"([^"]*)"|(\S+))/g)].map((m) => m[1] ?? m[2]);

export async function plan(ctx) {
  if (ctx.platform !== 'win32') return { satisfied: true, notes: [`no Windows services on ${ctx.platform}`] };

  const facts = JSON.parse(ctx.ps(probeScript(ctx.repo)));
  const map = [facts.map ?? []].flat();
  const services = [facts.services ?? []].flat();
  const byName = new Map(services.map((s) => [s.name.toLowerCase(), s]));

  const legacy = map.filter((m) => byName.has(m.old.toLowerCase()));
  const present = services.map((s) => `${s.name} (${s.state}, ${s.startMode})`);
  if (!legacy.length) {
    return { satisfied: true, notes: [present.length ? `Beeper services: ${present.join(', ')}` : 'no Beeper services on this node'] };
  }

  const renames = [];
  for (const { old, new: guess } of legacy) {
    const svc = byName.get(old.toLowerCase());
    const role = roleOf(svc.name);
    if (!role) refuse(`${svc.name}: its name carries no role (primary/secondary) - rename it by hand with setup/rename-beeper-s0-service.ps1`);
    const dirs = userDataDirs(svc);
    if (dirs.length !== 1) refuse(`${svc.name}: its AppParameters carry ${dirs.length} --user-data-dir flags, so which install it is cannot be read ("${svc.appParameters}")`);
    if (roleOf(guess) !== role) {
      refuse(`${svc.name}: setup/beeper-s0-naming.ps1 maps it to ${guess}, but its name says ${role} - the name and the map disagree`);
    }
    if (!LOCAL_SYSTEM.test(svc.startName ?? '')) {
      refuse(`${svc.name} runs as ${svc.startName}, not LocalSystem - rename-beeper-s0-service.ps1 would stop to ask for a password`);
    }
    renames.push({ from: svc.name, to: guess, role, dir: dirs[0], svc });
  }

  for (const role of ['primary', 'secondary']) {
    const claim = renames.filter((r) => r.role === role);
    const target = `egpt-beeper-${role}`;
    if (claim.length && byName.has(target)) refuse(`${claim[0].from} would become ${target}, which already exists - two installs claim the ${role}`);
  }
  const dirOwners = new Map();
  for (const s of services) {
    for (const d of userDataDirs(s)) {
      const k = normDir(d);
      if (dirOwners.has(k)) refuse(`${dirOwners.get(k)} and ${s.name} share --user-data-dir ${d} - one install cannot be two services`);
      dirOwners.set(k, s.name);
    }
  }

  renames.sort((a, b) => (a.role === b.role ? 0 : a.role === 'secondary' ? -1 : 1));
  const script = join(ctx.repo, 'setup', 'rename-beeper-s0-service.ps1');
  const changes = renames.flatMap((r) => [
    `rename service ${r.from} -> ${r.to}   (${r.svc.state}, ${r.svc.startMode}, ${r.svc.startName})`,
    `  evidence: its name says ${r.role}; --user-data-dir=${r.dir}`,
    `  by: powershell -File "${script}" -From ${r.from} -To ${r.to}`,
    `  that account is OFFLINE between stop and start; the full value list: same command with -WhatIf, elevated`,
  ]);

  return {
    satisfied: false,
    changes,
    apply: async () => {
      for (const r of renames) {
        ctx.log(`renaming ${r.from} -> ${r.to}`);
        ctx.psFile(script, ['-From', r.from, '-To', r.to]);
      }
    },
  };
}
