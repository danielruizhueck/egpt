// posix-box.mjs — the OS sandbox on macOS (sandbox-exec / Seatbelt), the POSIX counterpart of
// setup/sandbox-logon-launcher.ps1 (operator An, "SI Admin - E&M", 2026-10-15: "un verdadero
// sandbox ... ningún atajo, hazlo bien esta vez ... esto se agrega al proyecto principal", and
// "los demás em corren en el sandbox"). An, 2026-10-17: "linux can wait — macOS only" — so THIS
// module is DARWIN-ONLY. The Linux (bubblewrap) twin is a LATER PR; the earlier mixed draft
// (em/posix-sandbox) carried a bwrap path, left out here deliberately rather than shipped
// unverified. `isPosixBoxPlatform` therefore admits darwin alone, and a linux node asking for the
// box is refused loudly by createSandboxCliSession, exactly as any other non-win32/darwin platform.
//
// The Windows launcher leases a pool account and hangs per-folder kernel ACEs; a macOS box has no
// account to lease — the SAME operator user runs the turn — so the boundary is a per-spawn Seatbelt
// policy instead: default-deny WRITES, then allow exactly the Room, the being's writable share
// paths and the box's own scratch; and default-deny READS of the operator's whole home, then
// re-open exactly the Room, the share paths, the read mounts and what the runtimes need. Same
// CONTRACT as the Windows box (what a turn may touch), different enforcement (a policy the kernel
// checks on every open, not an ACL on the object).
//
// WHY A SEPARATE MODULE AND NOT MORE OF sandbox-cli-session.mjs: the builders here are PURE and
// injectable so they unit-test on any OS (the Seatbelt profile string can be asserted from a Linux
// CI runner), and sandbox-cli-session.mjs stays the thin per-engine wrapper it already is — it
// dispatches to preparePosixBox() and spawns what it hands back, exactly as it spawns the powershell
// launcher on win32.
//
// NETWORK IS UNRESTRICTED, deliberately and identically to the Windows box (setup/SANDBOX.md
// "Known gaps": the box bounds the FILESYSTEM, not the network — a boxed turn reaches the Claude
// API, and anything else its tools dial). The one network rule below is the ssh-agent unix socket,
// an ESCAPE (it would let a boxed being sign with the operator's keys), not a general egress gate.
//
// WHAT IS MEASURED vs INFERRED. Every Seatbelt escape below was MEASURED on THIS Mac
// (Darwin 25.6.0 / macOS 26.6.2, claude 2.1.302, arm64) as noted inline and proven by the live
// darwin tests in tests/posix-box.test.mjs.

import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// The running eGPT checkout root — this module sits at <root>/src/, so the root is one up. It is the
// default for the `src` read-only mount (the Windows box mounts ~\src\egpt; on darwin the natural
// equivalent is the tree the spine is running from). Overridable per call for tests.
const DEFAULT_REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// THE ENGINE THAT PICKED THIS MODULE already proved the platform is darwin (the guard in
// sandbox-cli-session.mjs), but this is exported so a caller — and a test — can branch without
// re-deriving the set. DARWIN ONLY until the Linux PR lands (An 2026-10-17).
export const POSIX_BOX_PLATFORMS = new Set(['darwin']);
export const isPosixBoxPlatform = (p) => POSIX_BOX_PLATFORMS.has(p);

// WHERE A BOX'S SCRATCH LIVES: a fresh dir per spawn under ~/.egpt-box, holding the box HOME (the
// symlinks egpt/src/<name>) and the box TMPDIR. Removed when the process exits. Under the operator's
// home rather than /tmp for the same reason tests/setup-egpt-home.mjs roots its throwaway profile
// under home — home-relative behaviour matches production — and because /tmp is one of the
// directories the Seatbelt profile DENIES reads on (per-app temp of every other process), so a box
// whose own scratch sat there would have to poke a hole straight back into what it just closed.
export function posixBoxRootOf(operatorHome = homedir()) {
  return join(operatorHome, '.egpt-box');
}

// ── PURE BUILDER 1: the minimal environment ────────────────────────────────────────────────────
// The box does NOT inherit the daemon's process.env (operator "un verdadero sandbox"): a leaked
// SSH_AUTH_SOCK, npm token, or AWS credential in the daemon's environment would otherwise ride
// straight into a boxed turn. So the box env is BUILT, from an allowlist of the base env plus
// HOME/TMPDIR (the box's own) and the caller's setEnv (the credential, the CLI store dir, the
// being-link vars — exactly what -SetEnv carries on Windows).
//
// CLAUDE_CODE_TMPDIR is pinned to the box tmp too, MEASURED: claude 2.1.302 otherwise falls back to
// a hardcoded "/tmp/claude" (read out of the shipped binary: `CLAUDE_CODE_TMPDIR||CLAUDE_TMPDIR||
// "/tmp/claude"`), and the Seatbelt profile denies writes there — so without this the CLI's own
// scratch writes would fail. setEnv wins over it, so a caller may still override.
const BASE_ENV_ALLOW = ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TZ', 'USER', 'LOGNAME', 'SHELL'];
export function minimalBoxEnv({ baseEnv = {}, home, tmpdir, setEnv = [] } = {}) {
  const env = {};
  for (const k of BASE_ENV_ALLOW) {
    if (typeof baseEnv[k] === 'string' && baseEnv[k] !== '') env[k] = baseEnv[k];
  }
  // Any LC_* the base env carries (collation, time, …) — the allowlist above names the common ones,
  // this sweeps the rest so a boxed locale is the operator's, not the empty default.
  for (const [k, v] of Object.entries(baseEnv)) {
    if (k.startsWith('LC_') && typeof v === 'string' && v !== '' && !(k in env)) env[k] = v;
  }
  if (!env.PATH) env.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';   // a box with no PATH can run nothing
  if (home) { env.HOME = home; }
  if (tmpdir) { env.TMPDIR = tmpdir; env.CLAUDE_CODE_TMPDIR = tmpdir; }
  // setEnv LAST so the caller's NAME=VALUE entries win — the credential, CLAUDE_CONFIG_DIR, the
  // being-link vars. Same parse the launcher's -SetEnv uses: split on the FIRST '='.
  for (const entry of Array.isArray(setEnv) ? setEnv : []) {
    if (typeof entry !== 'string') continue;
    const i = entry.indexOf('=');
    if (i <= 0) continue;
    env[entry.slice(0, i)] = entry.slice(i + 1);
  }
  // SSH_AUTH_SOCK is NEVER passed (the box must not sign with the operator's agent); the allowlist
  // above does not name it, so this is already true — stated so a future edit does not add it.
  return env;
}

// ── PURE BUILDER 2: the Seatbelt profile (SBPL) ──────────────────────────────────────────────────
// A string in Scheme-ish SBPL. The order is load-bearing: `(allow default)` is the base, then each
// `(deny …)` carves, then each `(allow …)` on a narrower path re-opens — Seatbelt is LAST-MATCH-WINS,
// so an allow on the Room (a subpath of the denied home) beats the home deny. MEASURED on this Mac.
//
// ESCAPING: SBPL string literals are double-quoted; only `\` and `"` need escaping. Real room and
// share slugs carry spaces, parens, `@` and `&` ("SI Admin - E&M", "E&M finanzas-2610160829",
// "My Drive (info@emotionandmotion.com)") — all fine inside a quoted string untouched, and
// regression-tested. The MATCH is on the kernel's resolved vnode path, so preparePosixBox
// realpaths every input first (so /tmp → /private/tmp, a symlinked home, etc. resolve).
export function sbplQuote(p) {
  return `"${String(p).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

// Every ANCESTOR directory of an allowed path, '/' first, the path itself EXCLUDED. The box is
// granted file-read-METADATA (not data) on these so lstat()/realpath() can walk down to a folder it
// may read — the exact "traverse chain" the Windows box needed (setup/SANDBOX.md "The traverse
// chain": realpathSync through an ungranted ancestor EPERMs). Metadata, not read, so the home is
// still unlistable: `ls ~` stays denied, `stat ~/.egpt/conversations/whatsapp/<slug>` resolves.
export function ancestorDirsOf(p) {
  const abs = resolve(String(p));
  const parts = abs.split(sep).filter(Boolean);
  const out = ['/'];
  let cur = '';
  for (let i = 0; i < parts.length - 1; i++) {   // -1: exclude the path itself
    cur += `/${parts[i]}`;
    out.push(cur);
  }
  return [...new Set(out)];
}

// Resolve the real on-disk location the CLI binary lives in, so the box may read it even though it
// sits under the denied operator home (~/.local/share/claude/versions/… on this Mac, reached through
// the ~/.local/bin/claude symlink — MEASURED). Returns the containing directory (so sibling version
// files and resources load), or null if it cannot be resolved.
export function binInstallDirOf(bin) {
  if (typeof bin !== 'string' || !bin) return null;
  try {
    const real = realpathSync.native(bin);
    return dirname(real);
  } catch { return null; }
}

// node's own install dir, included as a read grant ONLY when it is under the operator home (and so
// otherwise denied). A system/homebrew node (/opt/homebrew, /usr/local, /usr) is readable by the
// `(allow default)` base and needs no grant. baseEnv.PATH is searched for a `node` the box might
// spawn (the being-link ask-spine client runs `node …`), plus the daemon's own execPath.
function nodeDirUnderHome(operatorHome, baseEnv, execPath) {
  const home = resolve(operatorHome);
  const underHome = (d) => d && resolve(d).startsWith(home + sep);
  const candidates = [];
  if (typeof execPath === 'string' && execPath) candidates.push(dirname(execPath));
  for (const d of String(baseEnv?.PATH ?? '').split(delimiter)) {
    if (!d) continue;
    const n = join(d, 'node');
    try { if (existsSync(n)) candidates.push(dirname(realpathSync.native(n))); } catch { /* skip */ }
  }
  return candidates.find(underHome) ?? null;
}

export function seatbeltProfile({
  boxDir,              // the per-spawn scratch (box HOME + box TMPDIR live under it) — read+write
  room,                // the conversation folder (cwd) — read+write
  writablePaths = [],  // the being's writable allowed_paths PLUS the thread's CLI store — read+write
  readPaths = [],      // the being's read-only allowed_paths — read only
  repoRoot,            // the eGPT checkout — read only (the `src` mount)
  readMountPaths = [], // config.yaml global_read_paths targets — read only
  extraReadDirs = [],  // ~/src and ~/repos, the standing read-only source trees (An 2026-10-17) — read only
  binInstallDir,       // where the CLI binary really lives — read only
  nodeDir = null,      // node's install dir IF under the operator home — read only
  operatorHome = homedir(),
} = {}) {
  const readAllow = [room, ...writablePaths, ...readPaths, boxDir, repoRoot, ...readMountPaths, ...extraReadDirs, binInstallDir, nodeDir]
    .filter((p) => typeof p === 'string' && p);
  const writeAllow = [boxDir, room, ...writablePaths].filter((p) => typeof p === 'string' && p);
  // The traverse chain: metadata on every ancestor of every allowed path, deduped.
  const ancestors = [...new Set(readAllow.flatMap(ancestorDirsOf))];

  const L = [];
  L.push('(version 1)');
  L.push('(allow default)                               ; base: a local user may run ordinary software');
  L.push('');
  L.push('; ---- WRITES: default-deny, then only the box\'s own writable surfaces ----');
  L.push('(deny file-write*)                            ; nothing on disk is writable until named below');
  for (const p of writeAllow) L.push(`(allow file-write* (subpath ${sbplQuote(p)}))`);
  // The character devices node/claude actually need — MEASURED (a boxed `claude --version` and a
  // real bash turn ran clean with exactly these; /dev/dtracehelper is what the Darwin libc opens
  // writably at startup). /dev itself stays read-only via the base (allow default) minus the write
  // default-deny, so no other device is writable.
  L.push('(allow file-write-data                        ; the few writable char devices a process needs');
  L.push('  (literal "/dev/null") (literal "/dev/zero") (literal "/dev/dtracehelper")');
  L.push('  (regex #"^/dev/tty") (regex #"^/dev/fd/"))');
  L.push('');
  L.push('; ---- READS: deny the operator\'s whole world, then re-open only the box\'s own ----');
  L.push(`(deny file-read* (subpath ${sbplQuote(operatorHome)}))   ; the operator's home — .claude, .egpt/config, My Drive, Library, everything`);
  L.push('(deny file-read* (subpath "/Users"))          ; every other user, and the home again by its canonical root');
  L.push('(deny file-read* (subpath "/Volumes"))        ; mounted disks, external drives, network shares');
  L.push('(deny file-read* (subpath "/private/var/folders"))  ; per-user temp + caches of every app on the box');
  L.push('(deny file-read* (subpath "/private/tmp"))    ; /tmp (its real path) — other processes\' scratch');
  L.push('(deny file-read* (subpath "/tmp"))            ; …and /tmp by the symlink name, belt and suspenders');
  for (const p of readAllow) L.push(`(allow file-read* (subpath ${sbplQuote(p)}))`);
  L.push('; traverse: metadata (NOT data) on each ancestor, so realpath()/lstat() can walk down to an');
  L.push('; allowed folder while the home itself stays unlistable (ls ~ denied, stat ~/.egpt/… allowed).');
  for (const d of ancestors) L.push(`(allow file-read-metadata (literal ${sbplQuote(d)}))`);
  L.push('');
  L.push('; ---- ESCAPES, each MEASURED on Darwin 25.6 / macOS 26.6, claude 2.1.302 ----');
  L.push('; keychain: securityd refuses, so `security find-generic-password -s "Claude Code-credentials"`');
  L.push('; fails rather than handing over the operator\'s ~/.claude OAuth (MEASURED: non-zero, denied).');
  L.push('(deny mach-lookup');
  L.push('  (global-name "com.apple.SecurityServer") (global-name "com.apple.securityd")');
  L.push('  (global-name "com.apple.secinitd"))');
  L.push('; Apple Events: no `osascript -e \'tell application …\'` can drive another app to run code');
  L.push('; outside the box (MEASURED: the send never reaches the target app).');
  L.push('(deny appleevent-send)');
  L.push('; LaunchServices: `open -a Calculator` / `open <file>` cannot ask lsd to launch anything');
  L.push('; outside the box (MEASURED: open exits 1, nothing starts).');
  L.push('(deny mach-lookup');
  L.push('  (global-name "com.apple.coreservices.launchservicesd")');
  L.push('  (global-name "com.apple.lsd.mapdb") (global-name "com.apple.lsd.modifydb")');
  L.push('  (global-name "com.apple.lsd.openurl"))');
  L.push('; launchd: `launchctl submit`/`bootstrap` cannot register an UNSANDBOXED job with the user');
  L.push('; domain (MEASURED: unsandboxed submit runs a job; under this deny it exits 1 and none is');
  L.push('; registered). This is the one escape that would otherwise outlive the turn entirely.');
  L.push('(deny mach-lookup');
  L.push('  (global-name "com.apple.xpc.launchd.domain.user")');
  L.push('  (global-name "com.apple.xpc.launchd.domain.pid"))');
  L.push('; ssh-agent / other per-user launchd unix sockets: a boxed being must not sign with the');
  L.push('; operator\'s loaded keys. `SSH_AUTH_SOCK=… ssh-add -l` cannot reach the agent (MEASURED:');
  L.push('; unsandboxed rc=0 lists keys; boxed rc=2 "no agent"). NETWORK IS OTHERWISE UNRESTRICTED —');
  L.push('; this names the launchd socket dir only, and a real TLS round-trip to the API still works.');
  L.push('(deny network-outbound (regex #"/com\\.apple\\.launchd\\."))');
  L.push('; signals: (allow default) let a boxed process signal ANY process of the operator\'s uid, so');
  L.push('; `kill <daemon pid>` took the node down from inside a turn (MEASURED 2026-10-17: kill -0 on an');
  L.push('; unrelated process rc=0). Only the box\'s own process tree may be signalled — claude ending its');
  L.push('; own tools still works (MEASURED: own child killed, the outside process untouched).');
  L.push('(deny signal)');
  L.push('(allow signal (target same-sandbox))');
  L.push('');
  return L.join('\n') + '\n';
}

// ── THE IMPURE PREPARER ──────────────────────────────────────────────────────────────────────────
// Given the per-spawn facts, prepare the box dir and return { command, argv, env, cleanup } for
// sandbox-cli-session.mjs to spawn. cwd stays the REAL room (the caller forwards spawnOpts.cwd
// unchanged): darwin cannot remap paths, so the room's real path — which includes the operator's
// username — is visible to the boxed process. KNOWN GAP, as on the Windows mount's disclosure note:
// here the `egpt` symlink gives a tidy relative name but process.cwd() still resolves the real path.
export function preparePosixBox({
  platform,
  targetFolder,            // the Room (cwd)
  sharePaths = [],         // writable allowed_paths + the thread's CLI store
  sharePathsReadOnly = [], // read-only allowed_paths
  readMounts = [],         // [{ name, path }] from config.yaml global_read_paths
  setEnv = [],             // NAME=VALUE: the credential, CLAUDE_CONFIG_DIR, being-link
  bin,
  args = [],
  repoRoot = DEFAULT_REPO_ROOT,
  operatorHome = homedir(),
  baseEnv = process.env,
  execPath = process.execPath,
  // test seams
  mkOps = { mkdirSync, symlinkSync, writeFileSync, rmSync },
} = {}) {
  if (!isPosixBoxPlatform(platform)) {
    throw new Error(`posix-box: platform=${platform} is not a POSIX box platform (darwin only on this build; linux is a later PR)`);
  }
  // CANONICALISE every path the policy names, because the kernel matches rules against the REAL
  // (resolved vnode) path. On macOS /var and /tmp are symlinks to /private/var and /private/tmp, so
  // a deny on "/private/tmp" matches an access under "/tmp/…" while an allow spelled "/tmp/…" would
  // NOT — the deny would then win over the box's own Room (MEASURED: a Room under a temp dir was
  // unreadable until its path was realpath'd). Real operator paths under /Users carry no such
  // symlink, so production is unchanged; this makes the box robust to a symlinked home, an EGPT_HOME
  // under /tmp, etc. realOf falls back to the given path when it does not resolve (a path that does
  // not exist yet — though room/shares/store all exist by spawn time).
  const realOf = (p) => { try { return realpathSync.native(p); } catch { return p; } };
  const realIfExists = (p) => { try { return realpathSync.native(p); } catch { return null; } };
  operatorHome = realOf(operatorHome);
  targetFolder = realOf(targetFolder);
  repoRoot = realOf(repoRoot);
  sharePaths = (Array.isArray(sharePaths) ? sharePaths : []).map(realOf);
  sharePathsReadOnly = (Array.isArray(sharePathsReadOnly) ? sharePathsReadOnly : []).map(realOf);
  readMounts = (Array.isArray(readMounts) ? readMounts : []).map((m) => (m && m.path ? { ...m, path: realOf(m.path) } : m));
  // ~/src and ~/repos, the standing read-only source trees every boxed being may read (An
  // 2026-10-17: "boxed beings must still be able to reach exactly the folders they are granted" —
  // the posix twin of the Windows `src` mount and global_read_paths). Only the ones that EXIST on
  // this node; a missing folder contributes no rule (and no symlink).
  const extraReadDirs = [join(operatorHome, 'src'), join(operatorHome, 'repos')].map(realIfExists).filter(Boolean);
  const boxDir = join(posixBoxRootOf(operatorHome), randomUUID());
  const boxHome = join(boxDir, 'home');
  const boxTmp = join(boxDir, 'tmp');
  const readMountList = readMounts
    .filter((m) => m && typeof m.name === 'string' && m.name && typeof m.path === 'string' && m.path);

  // cleanup: remove the per-spawn box dir. rmSync(recursive) UNLINKS symlinks, it does not traverse
  // into their targets — so the egpt/src/<name> links are removed, never the Room or the checkout
  // they point at. Idempotent and never throws (a box already gone is success).
  const cleanup = () => { try { mkOps.rmSync(boxDir, { recursive: true, force: true }); } catch { /* best effort */ } };

  try {
    const env = minimalBoxEnv({ baseEnv, home: boxHome, tmpdir: boxTmp, setEnv });

    // Plant the box home + tmp and the pool-profile symlinks, write the Seatbelt profile, and hand
    // back `sandbox-exec -f <profile> <bin> <args…>`.
    mkOps.mkdirSync(boxHome, { recursive: true });
    mkOps.mkdirSync(boxTmp, { recursive: true });
    const link = (target, name) => { try { mkOps.symlinkSync(target, join(boxHome, name)); } catch { /* a dup/clash is harmless — the profile, not the link, is the boundary */ } };
    link(targetFolder, 'egpt');
    if (repoRoot) link(repoRoot, 'src');
    for (const m of readMountList) link(m.path, m.name);

    const profile = seatbeltProfile({
      boxDir, room: targetFolder,
      writablePaths: sharePaths, readPaths: sharePathsReadOnly,
      repoRoot, readMountPaths: readMountList.map((m) => m.path), extraReadDirs,
      binInstallDir: binInstallDirOf(bin),
      nodeDir: nodeDirUnderHome(operatorHome, baseEnv, execPath),
      operatorHome,
    });
    const profilePath = join(boxDir, 'box.sb');
    mkOps.writeFileSync(profilePath, profile, 'utf8');
    // EXEC THE REAL BINARY, not the symlink. ~/.local/bin/claude is a symlink INTO the denied
    // operator home (→ ~/.local/share/claude/versions/X), and the box is granted read on the
    // install dir (the target) but not on ~/.local/bin (the link's parent) — so execvp of the link
    // path fails `Operation not permitted` (MEASURED). realpath'ing the exec target makes the kernel
    // open the real file directly, in the dir the policy allows. A bare/relative bin (PATH-resolved)
    // falls through unchanged.
    const execBin = realOf(bin);
    return { command: '/usr/bin/sandbox-exec', argv: ['-f', profilePath, execBin, ...args], env, cleanup };
  } catch (err) {
    cleanup();   // never leave a half-built box dir behind on a failed prepare
    throw err;
  }
}
