// tools/chrome-launcher.mjs — locate Chrome, find the brain profile, and spawn a browser group's
// Chrome over --remote-debugging-pipe. Nothing here launches a Chrome on a debug port.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync, readFileSync, openSync, closeSync, readlinkSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { EGPT_HOME } from '../egpt-home.mjs';

const CHROME_PATHS = {
  win32: [
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
    'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  ],
  darwin: [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
  ],
  linux: [
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
  ],
};

export function findChromeExecutable() {
  const candidates = CHROME_PATHS[process.platform] ?? [];
  for (const p of candidates) if (existsSync(p)) return p;
  return null;
}

// Login history for the AI surfaces the brain drives lives in a Chrome profile's
// Default/History or Default/Network/Cookies as these domain substrings. A profile that
// mentions any of them has been logged in to an AI site — that's the "brain" profile the
// operator actually used, vs. a blank fresh one.
const AI_SITE_MARKERS = ['chatgpt', 'openai', 'claude.ai', 'grok'];

// Real-fs seams, injectable so tests point resolveBrainProfile at temp dirs (never a real
// profile). readFile is separated from the rest so a test can hand in a THROWING reader to
// model a locked History (Chrome holds a lock while running) without touching disk.
const defaultFs = { existsSync, readdirSync, statSync };
const defaultReadFile = (p) => readFileSync(p, 'latin1');

// Immediate subdirectory names of `dir`, or [] if it doesn't exist / can't be read. Never
// throws — a missing chrome/profiles tree is the common case on a fresh v2 install.
function listSubdirs(fs, dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch { return []; }
}

// A candidate is a REAL Chrome profile iff its Default subdir carries a Preferences file (or
// a Network/Cookies) — the two artifacts Chrome writes the moment a profile is used. A bare
// directory (or one we invented as the fresh fallback) fails this.
function isRealProfile(fs, dir) {
  const def = join(dir, 'Default');
  return fs.existsSync(join(def, 'Preferences')) || fs.existsSync(join(def, 'Network', 'Cookies'));
}

// Read a profile artifact defensively: a MISSING or LOCKED file (Chrome may be running and
// holding the History/Cookies lock) yields '' instead of throwing, so classification degrades
// to "not AI" rather than exploding.
function safeRead(readFile, file) {
  try { return readFile(file) || ''; } catch { return ''; }
}

// A real profile is an AI-brain iff its History OR Cookies mentions an AI-site domain. Read
// as latin1 + substring-match: History/Cookies are SQLite blobs, but the URLs inside are
// plain ASCII, so a defensive .includes on the raw bytes finds them without a DB open.
function isAiBrain(fs, readFile, dir) {
  const def = join(dir, 'Default');
  for (const f of [join(def, 'History'), join(def, 'Network', 'Cookies')]) {
    const text = safeRead(readFile, f);
    if (text && AI_SITE_MARKERS.some((m) => text.includes(m))) return true;
  }
  return false;
}

// Cookies mtime as a millisecond clock (−Infinity when absent/unreadable) — the "last active"
// proxy used to break a tie between multiple AI-brains.
function cookiesMtimeMs(fs, dir) {
  try { return fs.statSync(join(dir, 'Default', 'Network', 'Cookies')).mtimeMs; } catch { return -Infinity; }
}

/**
 * Find the Chrome profile the operator's AI brain actually lives in, instead of blindly
 * defaulting to the (usually blank) v2 profile dir. Pure-ish + NEVER throws: every fs touch is
 * read-only and wrapped, and all seams are injectable so tests run against temp dirs.
 *
 * Candidate roots, in PRIORITY order — ALL under <egptHome>:
 *   1. <egptHome>/chrome/profiles/brain            — the v2 default
 *   2. every OTHER immediate subdir of <egptHome>/chrome/profiles/  — discovers any additional
 *      profile the operator used (e.g. a future `brain2`), NOT hardcoded
 *
 * Preference of the returned dir:
 *   (a) an AI-brain (History/Cookies mentions an AI site) — if several qualify, the v2 default
 *       wins when it's one of them, else the most-recently-active by Cookies mtime;
 *   (b) else the first REAL, USED profile (a Network/Cookies exists);
 *   (c) else the v2 default (fresh — Chrome creates it on launch).
 *
 * @param {object}   [opts]
 * @param {string}   [opts.egptHome]  - profile root (default: EGPT_HOME)
 * @param {object}   [opts.fs]        - { existsSync, readdirSync, statSync } (default: node:fs)
 * @param {function} [opts.readFile]  - (path) => string; defaults to readFileSync(path,'latin1')
 * @returns {string} an absolute profile directory, always under egptHome
 */
export function resolveBrainProfile({ egptHome = EGPT_HOME, fs = defaultFs, readFile = defaultReadFile } = {}) {
  const profilesRoot = join(egptHome, 'chrome', 'profiles');
  const v2Default = join(profilesRoot, 'brain');

  const candidates = [v2Default];
  for (const sub of listSubdirs(fs, profilesRoot)) {
    if (sub !== 'brain') candidates.push(join(profilesRoot, sub));
  }

  const real = candidates.filter((dir) => isRealProfile(fs, dir));
  const aiBrains = real.filter((dir) => isAiBrain(fs, readFile, dir));

  if (aiBrains.length) {
    // (a) prefer the v2 default when it itself is an AI-brain, else the most-recently-active.
    if (aiBrains.includes(v2Default)) return v2Default;
    return aiBrains.reduce((best, dir) => (cookiesMtimeMs(fs, dir) > cookiesMtimeMs(fs, best) ? dir : best));
  }

  // (b) first real, USED profile (has Cookies), preserving candidate priority order.
  const used = real.find((dir) => fs.existsSync(join(dir, 'Default', 'Network', 'Cookies')));
  if (used) return used;

  // (c) the fresh v2 default — Chrome materializes it on first launch.
  return v2Default;
}

// Pipe-mode flags (chunk 3b): --remote-debugging-pipe instead of a port, and NO --remote-allow-origins
// (that is port/WS-only). Keeps the non-default --user-data-dir (Chrome 136 requires it), --no-first-run,
// the no-banner --silent-debugger-extension-api, and the renderer-alive flags. --load-extension still opts.
// --restore-last-session: a relaunch (every spine restart, every eviction) reopens the group's tabs.
export function chromePipeArgs({ userDataDir, extensionDir, url = 'about:blank' }) {
  const args = [
    '--remote-debugging-pipe',
    `--user-data-dir=${userDataDir}`,
    '--no-first-run',
    '--restore-last-session',
    `--disable-features=ChromeWhatsNewUI${extensionDir ? ',DisableLoadExtensionCommandLineSwitch' : ''}`,
    '--silent-debugger-extension-api',
    '--disable-backgrounding-occluded-windows',
    '--disable-background-timer-throttling',
    '--disable-renderer-backgrounding',
    '--new-window',
  ];
  if (extensionDir) args.push(`--load-extension=${extensionDir}`);
  args.push(url);
  return args;
}

/**
 * Spawn a group's Chrome driven over --remote-debugging-pipe. DIRECT-SPAWN ONLY: the spine holds
 * fds 3 & 4 itself. stdio ['inherit','inherit','inherit','pipe','pipe'] hands the child fd3 (we
 * write CDP) and fd4 (we read CDP). Returns { child, writable, readable, pid } — createPipeTransport
 * in cdp.mjs takes { writable, readable }. onExit({ code, signal, error }) fires when it ends or never
 * starts; passing it also installs the child's 'error' listener (without one a failed spawn throws).
 */
export async function spawnChromePipe({ userDataDir, extensionDir, url = 'about:blank', bin = null, onExit = null }) {
  const chrome = bin || findChromeExecutable();
  if (!chrome) throw new Error('Chrome executable not found in standard locations');
  await mkdir(userDataDir, { recursive: true });
  const args = chromePipeArgs({ userDataDir, extensionDir, url });
  const child = spawn(chrome, args, { stdio: ['inherit', 'inherit', 'inherit', 'pipe', 'pipe'] });
  if (onExit) {
    child.on('error', (error) => { try { onExit({ code: null, signal: null, error }); } catch { /* supervisor's problem */ } });
    child.on('exit', (code, signal) => { try { onExit({ code, signal, error: null }); } catch { /* supervisor's problem */ } });
  }
  return { child, writable: child.stdio[3], readable: child.stdio[4], pid: child.pid };
}

// Who already runs a Chrome on this --user-data-dir, or null. A running Chrome holds <dir>/lockfile
// open without write sharing (Windows) or points <dir>/SingletonLock at <host>-<pid> (POSIX); both
// outlive a Chrome that exited, so the probe is the open / the pid, never mere existence.
export function profileHolder(userDataDir) {
  if (process.platform === 'win32') {
    try { closeSync(openSync(join(userDataDir, 'lockfile'), 'r+')); return null; }
    catch (e) { return e.code === 'ENOENT' ? null : e.code; }
  }
  let pid;
  try { pid = Number(/-(\d+)$/.exec(readlinkSync(join(userDataDir, 'SingletonLock')))?.[1]); } catch { return null; }
  try { process.kill(pid, 0); return `pid ${pid}`; } catch (e) { return e.code === 'EPERM' ? `pid ${pid}` : null; }
}
