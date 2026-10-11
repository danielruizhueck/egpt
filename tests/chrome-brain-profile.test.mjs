// tests/chrome-brain-profile.test.mjs — resolveBrainProfile() discovery and profileHolder.
//
// THE BUG (2026-07-22): /chrome hardcoded the brain profile to
// <EGPT_HOME>/chrome/profiles/brain — a BLANK fresh profile with no ChatGPT/Claude
// logins. resolveBrainProfile() instead scans EVERY immediate subdir of
// <EGPT_HOME>/chrome/profiles/ and prefers the one that is actually logged in to an AI site.
//
// All fixtures are REAL temp dirs (mkdtempSync) + an injected { egptHome } — no real profile
// is read, and every candidate path stays under egptHome. The locked-file case injects a
// throwing readFile instead of actually locking a file on Windows.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync, symlinkSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveBrainProfile, profileHolder } from '../src/tools/chrome-launcher.mjs';

// Build a Chrome-shaped profile at `dir`. A REAL profile needs Default/Preferences OR
// Default/Network/Cookies; `history`/`cookies` (when non-null) seed the AI-marker files.
function mkProfile(dir, { preferences = true, history = null, cookies = null } = {}) {
  const def = join(dir, 'Default');
  mkdirSync(def, { recursive: true });
  if (preferences) writeFileSync(join(def, 'Preferences'), '{}');
  if (history !== null) writeFileSync(join(def, 'History'), history);
  if (cookies !== null) {
    mkdirSync(join(def, 'Network'), { recursive: true });
    writeFileSync(join(def, 'Network', 'Cookies'), cookies);
  }
}

let root, egptHome, profilesRoot;
const v2Default = () => join(profilesRoot, 'brain');

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'egpt-brainprof-'));
  egptHome = join(root, 'egpthome');
  profilesRoot = join(egptHome, 'chrome', 'profiles');
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('resolveBrainProfile()', () => {
  it('picks a sibling AI-brain when the v2 default is blank', () => {
    // v2 default: real but blank (Preferences, no AI markers, no cookies).
    mkProfile(v2Default(), { preferences: true });
    // sibling profile: real AND logged in to ChatGPT (History has the domain).
    mkProfile(join(profilesRoot, 'brain2'), { preferences: true, history: 'visited chatgpt.com/c/abc' });

    const out = resolveBrainProfile({ egptHome });
    expect(out).toBe(join(profilesRoot, 'brain2'));
    expect(out.startsWith(egptHome)).toBe(true);
  });

  it('falls back to the v2 default when every candidate is blank', () => {
    mkProfile(v2Default(), { preferences: true });
    mkProfile(join(profilesRoot, 'brain2'), { preferences: true });
    mkProfile(join(profilesRoot, 'other'), { preferences: true });

    const out = resolveBrainProfile({ egptHome });
    expect(out).toBe(v2Default());
    expect(out.startsWith(egptHome)).toBe(true);
  });

  it('prefers the v2 default when IT is the AI-brain, over a sibling AI-brain', () => {
    // Both are AI-brains → the v2 default wins.
    mkProfile(v2Default(), { preferences: true, cookies: 'session for claude.ai' });
    mkProfile(join(profilesRoot, 'brain2'), { preferences: true, history: 'chatgpt.com' });

    expect(resolveBrainProfile({ egptHome })).toBe(v2Default());
  });

  it('among multiple sibling AI-brains (v2 default not AI), picks the most-recently-active by Cookies mtime', () => {
    mkProfile(v2Default(), { preferences: true });                                    // real, not AI
    const older = join(profilesRoot, 'brain2');
    const newer = join(profilesRoot, 'brain3');
    mkProfile(older, { preferences: true, cookies: 'openai.com session' });
    mkProfile(newer, { preferences: true, cookies: 'grok.x session' });
    // Force `newer`'s Cookies to be the most-recently-modified.
    const now = Date.now() / 1000;
    utimesSync(join(older, 'Default', 'Network', 'Cookies'), now - 100, now - 100);
    utimesSync(join(newer, 'Default', 'Network', 'Cookies'), now, now);

    const out = resolveBrainProfile({ egptHome });
    expect(out).toBe(newer);
    expect(out.startsWith(egptHome)).toBe(true);
  });

  it('does not throw and treats a locked/unreadable History as not-AI', () => {
    mkProfile(v2Default(), { preferences: true });
    mkProfile(join(profilesRoot, 'brain2'), { preferences: true, history: 'chatgpt.com' });

    // Simulate Chrome holding a lock: reading the History file throws.
    const throwingRead = (p) => {
      if (String(p).includes('History')) throw new Error('EBUSY: file is locked');
      return readFileSync(p, 'latin1');
    };

    let out;
    expect(() => { out = resolveBrainProfile({ egptHome, readFile: throwingRead }); }).not.toThrow();
    // The AI marker was unreadable → the sibling profile is NOT classified AI → fall back to v2 default.
    expect(out).toBe(v2Default());
  });

  it('returns a real USED profile (Cookies present) over the fresh default when none are AI', () => {
    mkProfile(v2Default(), { preferences: true });                                    // fresh, no cookies
    mkProfile(join(profilesRoot, 'brain2'), { preferences: true, cookies: 'example.com only' });  // used, not AI

    const out = resolveBrainProfile({ egptHome });
    expect(out).toBe(join(profilesRoot, 'brain2'));
    expect(out.startsWith(egptHome)).toBe(true);
  });

  it('never throws when the profiles dir does not exist', () => {
    // No profiles created at all — the default dir doesn't even exist yet.
    let out;
    expect(() => { out = resolveBrainProfile({ egptHome }); }).not.toThrow();
    expect(out).toBe(v2Default());
    expect(out.startsWith(egptHome)).toBe(true);
  });
});

// profileHolder: is a Chrome already running on this --user-data-dir? Chrome leaves its lock behind
// when it exits, so existence alone must never read as "held". The held case is a real OS hold:
// Windows — a PowerShell holding <dir>/lockfile open share-read, as Chrome does; POSIX — a
// SingletonLock naming this live process, as Chrome's does.
describe('profileHolder(userDataDir)', () => {
  it('no profile dir, or a profile with no lock → null', () => {
    expect(profileHolder(join(root, 'nope'))).toBe(null);
    mkdirSync(join(root, 'fresh'));
    expect(profileHolder(join(root, 'fresh'))).toBe(null);
  });

  it('a lock left behind by a Chrome that exited → null', () => {
    const dir = join(root, 'stale');
    mkdirSync(dir);
    if (process.platform === 'win32') writeFileSync(join(dir, 'lockfile'), '');
    else symlinkSync('somehost-2147483646', join(dir, 'SingletonLock'));
    expect(profileHolder(dir)).toBe(null);
  });

  it('a lock a live process holds → that holder', async () => {
    const dir = join(root, 'held');
    mkdirSync(dir);
    if (process.platform !== 'win32') {
      symlinkSync(`somehost-${process.pid}`, join(dir, 'SingletonLock'));
      expect(profileHolder(dir)).toBe(`pid ${process.pid}`);
      return;
    }
    const lock = join(dir, 'lockfile').replace(/'/g, "''");
    const ps = spawn('powershell', ['-NoProfile', '-Command', `$f=[IO.File]::Open('${lock}','OpenOrCreate','ReadWrite','Read'); [Console]::Out.WriteLine('held'); [Console]::Out.Flush(); Start-Sleep 30`], { windowsHide: true });
    try {
      await new Promise((resolve, reject) => { ps.stdout.on('data', (d) => /held/.test(String(d)) && resolve()); ps.on('exit', reject); });
      expect(profileHolder(dir)).toBe('EBUSY');
    } finally {
      const gone = new Promise((r) => ps.once('exit', r));
      ps.kill();
      await gone;   // the hold ends with the process; afterEach removes the dir
    }
  });
});
