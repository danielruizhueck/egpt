// Locks src/posix-box.mjs — the OS box on macOS (sandbox-exec / Seatbelt), the POSIX counterpart of
// setup/sandbox-logon-launcher.ps1 (operator An 2026-10-15, "un verdadero sandbox ... los demás em
// corren en el sandbox"; 2026-10-17, "linux can wait — macOS only"). DARWIN ONLY on this build; the
// Linux bwrap twin is a later PR and is not here to test.
//
// TWO LAYERS of test, matching how much can be PROVEN where:
//   · PURE BUILDERS (any OS): the Seatbelt profile string, the minimal env, the ancestor-chain and
//     escaping helpers. Deterministic from their inputs, the bulk of the file, so a Linux CI runner
//     checks them too.
//   · DARWIN LIVE (describe.skipIf(process.platform !== 'darwin')): build a REAL box with temp dirs
//     standing in for the operator home / room / shares, spawn /bin/bash under sandbox-exec, and
//     assert the kernel actually enforces it — room write ok, ro-share write denied / read ok,
//     operator-home sibling read denied, write outside denied, HOME/TMPDIR are the box's, box dir
//     removed after exit, and a granted path whose NAME carries spaces/parens/@/& works (An
//     2026-10-17).
import { describe, it, expect, afterAll } from 'vitest';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// macOS canonicalises /var → /private/var, so a temp dir from mkdtemp (under /var/folders) must be
// realpath'd before it is compared against what the box's policy — which realpaths its inputs —
// emits. Real operator paths under /Users carry no such symlink, so this is a test-env concern only.
const mkTmp = (prefix) => realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
import {
  seatbeltProfile, minimalBoxEnv, ancestorDirsOf, sbplQuote,
  preparePosixBox, isPosixBoxPlatform, posixBoxRootOf, binInstallDirOf,
} from '../src/posix-box.mjs';

// ── minimalBoxEnv ───────────────────────────────────────────────────────────────────────────────
describe('posix-box — minimalBoxEnv: a built env, never the daemon\'s inherited one', () => {
  it('keeps only the allowlisted base keys, sets HOME/TMPDIR, and drops everything else (no inherited secrets)', () => {
    const env = minimalBoxEnv({
      baseEnv: {
        PATH: '/usr/bin', LANG: 'en_US.UTF-8', LC_TIME: 'es_ES.UTF-8', TERM: 'xterm', TZ: 'UTC',
        USER: 'ourmac', LOGNAME: 'ourmac', SHELL: '/bin/zsh',
        SSH_AUTH_SOCK: '/private/tmp/com.apple.launchd.X/Listeners',
        AWS_SECRET_ACCESS_KEY: 'nope', NPM_TOKEN: 'nope', HOME: '/Users/ourmac', TMPDIR: '/var/folders/x',
      },
      home: '/box/home', tmpdir: '/box/tmp',
    });
    expect(env.PATH).toBe('/usr/bin');
    expect(env.LANG).toBe('en_US.UTF-8');
    expect(env.LC_TIME).toBe('es_ES.UTF-8');   // swept by the LC_* loop
    expect(env.HOME).toBe('/box/home');        // the box's, not the operator's
    expect(env.TMPDIR).toBe('/box/tmp');
    expect(env.CLAUDE_CODE_TMPDIR).toBe('/box/tmp');   // MEASURED: claude falls back to /tmp/claude without it
    // the secrets a daemon env carries are GONE:
    expect(env.SSH_AUTH_SOCK).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.NPM_TOKEN).toBeUndefined();
  });

  it('setEnv wins over everything, split on the FIRST = (a value may itself contain =)', () => {
    const env = minimalBoxEnv({
      baseEnv: { PATH: '/usr/bin' }, home: '/h', tmpdir: '/t',
      setEnv: ['CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01=weird==', 'CLAUDE_CONFIG_DIR=/store/thread', 'CLAUDE_CODE_TMPDIR=/override'],
    });
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01=weird==');
    expect(env.CLAUDE_CONFIG_DIR).toBe('/store/thread');
    expect(env.CLAUDE_CODE_TMPDIR).toBe('/override');   // setEnv overrides the tmpdir default
  });

  it('a box with no PATH in the base env still gets a usable one (it could run nothing otherwise)', () => {
    const env = minimalBoxEnv({ baseEnv: {}, home: '/h', tmpdir: '/t' });
    expect(env.PATH).toContain('/usr/bin');
  });

  it('ignores junk setEnv entries (no =, leading =, non-string) rather than throwing', () => {
    const env = minimalBoxEnv({ baseEnv: { PATH: '/usr/bin' }, home: '/h', tmpdir: '/t', setEnv: ['NOEQUALS', '=leadingeq', 42, null, 'OK=1'] });
    expect(env.OK).toBe('1');
    expect(env.NOEQUALS).toBeUndefined();
    expect(env['']).toBeUndefined();
  });
});

// ── ancestorDirsOf ──────────────────────────────────────────────────────────────────────────────
describe('posix-box — ancestorDirsOf: the traverse chain, path excluded', () => {
  it('lists every parent from / down to the path\'s parent, and not the path itself', () => {
    expect(ancestorDirsOf('/Users/ourmac/.egpt/conversations/whatsapp/SI Admin - E&M-2610131705'))
      .toEqual(['/', '/Users', '/Users/ourmac', '/Users/ourmac/.egpt', '/Users/ourmac/.egpt/conversations', '/Users/ourmac/.egpt/conversations/whatsapp']);
  });
  it('a top-level path yields just /', () => {
    expect(ancestorDirsOf('/opt')).toEqual(['/']);
  });
});

// ── sbplQuote ───────────────────────────────────────────────────────────────────────────────────
describe('posix-box — sbplQuote: SBPL string escaping', () => {
  it('wraps in double quotes and escapes backslash and double-quote only', () => {
    expect(sbplQuote('/a/b')).toBe('"/a/b"');
    expect(sbplQuote('/a"b')).toBe('"/a\\"b"');
    expect(sbplQuote('/a\\b')).toBe('"/a\\\\b"');
  });
  it('leaves spaces, parens, @ and & untouched (real paths: "SI Admin - E&M", "My Drive (info@…)")', () => {
    expect(sbplQuote('/x/SI Admin - E&M-2610131705')).toBe('"/x/SI Admin - E&M-2610131705"');
    expect(sbplQuote('/Users/ourmac/My Drive (info@emotionandmotion.com)/0. Claude/17_MARKETING'))
      .toBe('"/Users/ourmac/My Drive (info@emotionandmotion.com)/0. Claude/17_MARKETING"');
  });
});

// ── seatbeltProfile ─────────────────────────────────────────────────────────────────────────────
describe('posix-box — seatbeltProfile (SBPL): the darwin policy', () => {
  const base = {
    boxDir: '/Users/op/.egpt-box/uuid',
    room: '/Users/op/.egpt/conversations/whatsapp/SI Admin - E&M-2610131705',
    writablePaths: ['/Users/op/.egpt-jsonl/thread-1', '/work/rw'],
    readPaths: ['/work/ro'],
    repoRoot: '/Users/op/src/egpt',
    readMountPaths: ['/Users/op/src/siran'],
    extraReadDirs: ['/Users/op/src', '/Users/op/repos'],
    binInstallDir: '/Users/op/.local/share/claude/versions',
    nodeDir: null,
    operatorHome: '/Users/op',
  };
  const p = seatbeltProfile(base);

  it('opens (version 1) + (allow default), then a write default-deny', () => {
    expect(p.startsWith('(version 1)\n')).toBe(true);
    expect(p).toContain('(allow default)');
    expect(p).toContain('(deny file-write*)');
    // the write default-deny comes BEFORE every write allow (order is last-match-wins)
    expect(p.indexOf('(deny file-write*)')).toBeLessThan(p.indexOf('(allow file-write* (subpath "/Users/op/.egpt/conversations'));
  });

  it('allows writes on the box dir, the room and the writable shares — and NOT the read-only share', () => {
    expect(p).toContain('(allow file-write* (subpath "/Users/op/.egpt-box/uuid"))');
    expect(p).toContain('(allow file-write* (subpath "/Users/op/.egpt/conversations/whatsapp/SI Admin - E&M-2610131705"))');
    expect(p).toContain('(allow file-write* (subpath "/Users/op/.egpt-jsonl/thread-1"))');
    expect(p).toContain('(allow file-write* (subpath "/work/rw"))');
    expect(p).not.toContain('(allow file-write* (subpath "/work/ro"))');
  });

  it('allows the few writable char devices and nothing else device-wise', () => {
    expect(p).toContain('(literal "/dev/null")');
    expect(p).toContain('(literal "/dev/dtracehelper")');
    expect(p).toContain('(regex #"^/dev/tty")');
  });

  it('denies the operator home, /Users, /Volumes and the temp/caches, then re-opens the box\'s own reads', () => {
    expect(p).toContain('(deny file-read* (subpath "/Users/op"))');
    expect(p).toContain('(deny file-read* (subpath "/Users"))');
    expect(p).toContain('(deny file-read* (subpath "/Volumes"))');
    expect(p).toContain('(deny file-read* (subpath "/private/var/folders"))');
    expect(p).toContain('(deny file-read* (subpath "/private/tmp"))');
    expect(p).toContain('(deny file-read* (subpath "/tmp"))');
    for (const allow of [
      '/Users/op/.egpt/conversations/whatsapp/SI Admin - E&M-2610131705', '/work/rw', '/work/ro',
      '/Users/op/.egpt-box/uuid', '/Users/op/src/egpt', '/Users/op/src/siran',
      '/Users/op/src', '/Users/op/repos', '/Users/op/.local/share/claude/versions',
    ]) {
      expect(p, `read allow missing: ${allow}`).toContain(`(allow file-read* (subpath "${allow}"))`);
    }
    // the deny comes before the allow (last-match-wins re-opens the room under the denied home)
    expect(p.indexOf('(deny file-read* (subpath "/Users/op"))')).toBeLessThan(p.indexOf('(allow file-read* (subpath "/Users/op/.egpt/conversations'));
  });

  it('grants file-read-METADATA on the ancestors so realpath/lstat can traverse, home still unlistable', () => {
    expect(p).toContain('(allow file-read-metadata (literal "/Users/op"))');
    expect(p).toContain('(allow file-read-metadata (literal "/Users"))');
    // metadata, not data: there is no (allow file-read* (subpath "/Users/op")) re-opening the home
    expect(p).not.toContain('(allow file-read* (subpath "/Users/op"))\n');
  });

  it('denies every measured escape: keychain, Apple Events, LaunchServices, launchd, ssh-agent socket', () => {
    expect(p).toContain('(global-name "com.apple.SecurityServer")');
    expect(p).toContain('(deny appleevent-send)');
    expect(p).toContain('(global-name "com.apple.coreservices.launchservicesd")');
    expect(p).toContain('(global-name "com.apple.xpc.launchd.domain.user")');
    expect(p).toContain('(deny network-outbound (regex #"/com\\.apple\\.launchd\\."))');
    expect(p).toContain('(deny signal)\n(allow signal (target same-sandbox))');
  });

  it('a read-only node (node under the operator home) adds its install dir to the read allows', () => {
    const withNode = seatbeltProfile({ ...base, nodeDir: '/Users/op/.local/n/bin' });
    expect(withNode).toContain('(allow file-read* (subpath "/Users/op/.local/n/bin"))');
  });

  it('escapes a room path that carries a quote or backslash', () => {
    const weird = seatbeltProfile({ ...base, room: '/Users/op/a"b\\c' });
    expect(weird).toContain('(allow file-write* (subpath "/Users/op/a\\"b\\\\c"))');
  });

  it('a granted share whose NAME has spaces, parens, @ and & is a valid allow rule, untouched (An 2026-10-17)', () => {
    const tricky = seatbeltProfile({
      ...base,
      room: '/Users/op/.egpt/conversations/whatsapp/E&M finanzas-2610160829',
      writablePaths: ['/Users/op/My Drive (info@emotionandmotion.com)/0. Claude/17_MARKETING'],
    });
    expect(tricky).toContain('(allow file-write* (subpath "/Users/op/.egpt/conversations/whatsapp/E&M finanzas-2610160829"))');
    expect(tricky).toContain('(allow file-write* (subpath "/Users/op/My Drive (info@emotionandmotion.com)/0. Claude/17_MARKETING"))');
    expect(tricky).toContain('(allow file-read* (subpath "/Users/op/My Drive (info@emotionandmotion.com)/0. Claude/17_MARKETING"))');
  });
});

// ── preparePosixBox (filesystem, any OS: builds the darwin sandbox-exec invocation) ───────────────
describe('posix-box — preparePosixBox: dispatch + box-dir lifecycle', () => {
  const HOME = mkTmp('posixbox-home-');
  const ROOM = join(HOME, '.egpt', 'conversations', 'whatsapp', 'SI Admin - E&M-2610131705');
  mkdirSync(ROOM, { recursive: true });
  const REPO = mkTmp('posixbox-repo-');
  afterAll(() => { for (const d of [HOME, REPO]) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } });

  it('rejects a non-POSIX platform (win32 handled elsewhere; linux is a later PR)', () => {
    expect(() => preparePosixBox({ platform: 'win32', targetFolder: ROOM, bin: '/bin/bash', operatorHome: HOME })).toThrow(/not a POSIX box platform/);
    expect(() => preparePosixBox({ platform: 'linux', targetFolder: ROOM, bin: '/bin/bash', operatorHome: HOME })).toThrow(/not a POSIX box platform/);
  });

  it('darwin: hands back sandbox-exec -f <profile> <bin> <args>, plants the box dir + symlinks, cleanup removes it', () => {
    const box = preparePosixBox({
      platform: 'darwin', targetFolder: ROOM, bin: '/bin/bash', args: ['-c', 'echo hi'],
      sharePaths: [join(HOME, '.egpt-jsonl', 'thread-1')], readMounts: [{ name: 'repos', path: REPO }],
      setEnv: ['CLAUDE_CODE_OAUTH_TOKEN=tok'], repoRoot: REPO, operatorHome: HOME, baseEnv: { PATH: '/usr/bin' },
    });
    expect(box.command).toBe('/usr/bin/sandbox-exec');
    expect(box.argv[0]).toBe('-f');
    expect(box.argv.slice(2)).toEqual(['/bin/bash', '-c', 'echo hi']);
    const profilePath = box.argv[1];
    expect(existsSync(profilePath)).toBe(true);
    expect(readFileSync(profilePath, 'utf8')).toContain('(version 1)');
    // the box dir is under ~/.egpt-box and holds home/ + tmp/ + the profile
    expect(profilePath.startsWith(posixBoxRootOf(HOME))).toBe(true);
    expect(box.env.HOME.startsWith(posixBoxRootOf(HOME))).toBe(true);
    expect(box.env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok');
    // the symlinks were planted in the box home
    expect(existsSync(join(box.env.HOME, 'egpt'))).toBe(true);
    expect(existsSync(join(box.env.HOME, 'src'))).toBe(true);
    expect(existsSync(join(box.env.HOME, 'repos'))).toBe(true);
    // cleanup removes the whole box dir and NOT the symlink targets
    box.cleanup();
    expect(existsSync(box.env.HOME)).toBe(false);
    expect(existsSync(ROOM), 'cleanup followed a symlink into the room').toBe(true);
    expect(existsSync(REPO), 'cleanup followed a symlink into the checkout').toBe(true);
  });
});

describe('posix-box — platform set', () => {
  it('admits darwin, not win32/linux/others (darwin only on this build)', () => {
    expect(isPosixBoxPlatform('darwin')).toBe(true);
    expect(isPosixBoxPlatform('linux')).toBe(false);   // a later PR
    expect(isPosixBoxPlatform('win32')).toBe(false);
    expect(isPosixBoxPlatform('freebsd')).toBe(false);
  });
});

describe('posix-box — binInstallDirOf', () => {
  it('resolves a symlinked bin to its real containing dir, null for a non-string / missing', () => {
    const dir = mkTmp('bin-');
    const real = join(dir, 'claude-2.1.302');
    writeFileSync(real, '');
    expect(binInstallDirOf(real)).toBe(dir);
    expect(binInstallDirOf('')).toBe(null);
    expect(binInstallDirOf(42)).toBe(null);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// DARWIN LIVE: build a real box with sandbox-exec and prove the KERNEL enforces it. Skipped on any
// non-darwin runner. These stand up temp dirs for operator-home / room / shares, so they touch no
// real profile and no real ~/.claude.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe.skipIf(process.platform !== 'darwin')('posix-box — DARWIN LIVE: sandbox-exec enforces the policy', () => {
  const HOME = mkTmp('live-home-');
  const ROOM = join(HOME, '.egpt', 'conversations', 'whatsapp', 'Room - E&M-123');
  const SHARE_RW = join(HOME, 'share-rw');
  const SHARE_RO = join(HOME, 'share-ro');
  const SIBLING = join(HOME, 'secret-sibling');   // under operator home, NOT shared → must be unreadable
  const REPO = mkTmp('live-repo-');
  for (const d of [ROOM, SHARE_RW, SHARE_RO, SIBLING]) mkdirSync(d, { recursive: true });
  writeFileSync(join(ROOM, 'r.txt'), 'room');
  writeFileSync(join(SHARE_RO, 'ro.txt'), 'ro');
  writeFileSync(join(SHARE_RW, 'rw.txt'), 'rw');
  writeFileSync(join(SIBLING, 'secret.txt'), 'SECRET');
  afterAll(() => { for (const d of [HOME, REPO]) try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } });

  // Run `/bin/bash -c <script>` inside a freshly-prepared box; return { status, stdout, stderr, box }.
  function boxed(script, extra = {}) {
    const box = preparePosixBox({
      platform: 'darwin', targetFolder: ROOM, bin: '/bin/bash', args: ['-c', script],
      sharePaths: [SHARE_RW], sharePathsReadOnly: [SHARE_RO],
      repoRoot: REPO, operatorHome: HOME, baseEnv: { PATH: '/usr/bin:/bin' }, ...extra,
    });
    const r = spawnSync(box.command, box.argv, { cwd: ROOM, env: box.env, encoding: 'utf8' });
    return { ...r, box };
  }

  it('room: write is allowed', () => {
    const { status } = boxed(`echo x > "${join(ROOM, 'w.txt')}"`);
    expect(status).toBe(0);
    expect(existsSync(join(ROOM, 'w.txt'))).toBe(true);
  });

  it('read-only share: read OK, write DENIED', () => {
    const read = boxed(`cat "${join(SHARE_RO, 'ro.txt')}"`);
    expect(read.status).toBe(0);
    expect(read.stdout).toContain('ro');
    const write = boxed(`echo x > "${join(SHARE_RO, 'nope.txt')}" 2>&1; echo rc=$?`);
    expect(write.stdout).toMatch(/rc=[^0]/);
    expect(existsSync(join(SHARE_RO, 'nope.txt'))).toBe(false);
  });

  it('writable share: write allowed', () => {
    const { status } = boxed(`echo x > "${join(SHARE_RW, 'w.txt')}"`);
    expect(status).toBe(0);
    expect(existsSync(join(SHARE_RW, 'w.txt'))).toBe(true);
  });

  it('operator-home sibling (not shared): read DENIED', () => {
    const r = boxed(`cat "${join(SIBLING, 'secret.txt')}" 2>&1; echo rc=$?`);
    expect(r.stdout).not.toContain('SECRET');
    expect(r.stdout).toMatch(/rc=[^0]/);
  });

  it('write outside every allowed path: DENIED', () => {
    const target = join(HOME, 'escape.txt');
    const r = boxed(`echo x > "${target}" 2>&1; echo rc=$?`);
    expect(r.stdout).toMatch(/rc=[^0]/);
    expect(existsSync(target)).toBe(false);
  });

  it('HOME and TMPDIR are the box\'s own, under ~/.egpt-box', () => {
    const r = boxed('echo "HOME=$HOME TMPDIR=$TMPDIR"');
    expect(r.stdout).toContain(`HOME=${posixBoxRootOf(HOME)}`);
    expect(r.stdout).toMatch(new RegExp(`TMPDIR=${posixBoxRootOf(HOME).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
  });

  it('env carries no daemon variables — only the built allowlist + the box HOME/TMPDIR', () => {
    const r = boxed('env', { baseEnv: { PATH: '/usr/bin:/bin', SSH_AUTH_SOCK: '/private/tmp/leak.sock', AWS_SECRET_ACCESS_KEY: 'LEAK', NPM_TOKEN: 'LEAK' } });
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('SSH_AUTH_SOCK');
    expect(r.stdout).not.toContain('AWS_SECRET_ACCESS_KEY');
    expect(r.stdout).not.toContain('LEAK');
  });

  it('signals: an outside process of the same user cannot be signalled; the box\'s own child can', () => {
    const outside = spawn('/bin/sleep', ['30'], { stdio: 'ignore' });
    try {
      const r = boxed(`kill -0 ${outside.pid} 2>/dev/null; echo other=$?; /bin/sleep 30 & c=$!; kill $c 2>/dev/null; echo child=$?`);
      expect(r.stdout).toMatch(/other=[^0]/);   // denied: the daemon, the spine, other beings are out of reach
      expect(r.stdout).toContain('child=0');    // its own tree still works
      expect(outside.exitCode).toBe(null);      // and the outside process is still alive
    } finally { outside.kill(); }
  });

  it('the box dir is removed after the process exits (cleanup wired to the real proc in sandbox-cli-session)', () => {
    const { box } = boxed('true');
    expect(existsSync(box.env.HOME)).toBe(true);
    box.cleanup();
    expect(existsSync(box.env.HOME)).toBe(false);
  });

  it('realpath/lstat can traverse the denied home to the room (the metadata traverse chain works)', () => {
    const r = boxed(`/bin/ls -la "${ROOM}" >/dev/null 2>&1; echo room=$?; /bin/ls "${HOME}" >/dev/null 2>&1; echo home=$?`);
    expect(r.stdout).toContain('room=0');     // the room lists
    expect(r.stdout).toMatch(/home=[^0]/);    // the home does not (metadata, not list)
  });

  // ── GRANTED PATHS WITH TRICKY NAMES (An 2026-10-17): spaces, parens, @ and & in a granted folder
  //    must be reachable with full rights, a ro-granted one readable-not-writable, and a sibling that
  //    is NOT granted still denied. Scratch folders under the temp home, never the real Drive. ──
  describe('granted paths whose names carry spaces, parens, @ and &', () => {
    const RW = join(HOME, 'My Drive (info@emotionandmotion.com)', '0. Claude', '17_MARKETING');
    const RO = join(HOME, 'E&M finanzas-2610160829 (read only)');
    const UNGRANTED = join(HOME, 'My Drive (info@emotionandmotion.com)', '0. Claude', 'CONTRATOS & PAGOS');
    for (const d of [RW, RO, UNGRANTED]) mkdirSync(d, { recursive: true });
    writeFileSync(join(RO, 'tarifas.md'), 'RO-OK');
    writeFileSync(join(UNGRANTED, 'secret.md'), 'SECRET');

    function boxedWith(script) {
      const box = preparePosixBox({
        platform: 'darwin', targetFolder: ROOM, bin: '/bin/bash', args: ['-c', script],
        sharePaths: [RW], sharePathsReadOnly: [RO], operatorHome: HOME, repoRoot: REPO, baseEnv: { PATH: '/usr/bin:/bin' },
      });
      const r = spawnSync(box.command, box.argv, { cwd: ROOM, env: box.env, encoding: 'utf8' });
      box.cleanup();
      return r;
    }

    it('rw-granted folder with spaces/parens/@: write succeeds', () => {
      const r = boxedWith(`echo x > "${join(RW, 'nota.md')}" 2>&1; echo rc=$?`);
      expect(r.stdout).toContain('rc=0');
      expect(existsSync(join(RW, 'nota.md'))).toBe(true);
    });

    it('ro-granted folder with & in its name: read OK, write DENIED', () => {
      const read = boxedWith(`cat "${join(RO, 'tarifas.md')}"`);
      expect(read.status).toBe(0);
      expect(read.stdout).toContain('RO-OK');
      const write = boxedWith(`echo x > "${join(RO, 'nope.md')}" 2>&1; echo rc=$?`);
      expect(write.stdout).toMatch(/rc=[^0]/);
      expect(existsSync(join(RO, 'nope.md'))).toBe(false);
    });

    it('a sibling folder NOT granted (CONTRATOS & PAGOS) stays denied even with the tricky parent', () => {
      const r = boxedWith(`cat "${join(UNGRANTED, 'secret.md')}" 2>&1; echo rc=$?`);
      expect(r.stdout).not.toContain('SECRET');
      expect(r.stdout).toMatch(/rc=[^0]/);
    });
  });
});
