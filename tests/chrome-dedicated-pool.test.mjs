// tests/chrome-dedicated-pool.test.mjs — the per-GROUP Chrome pool (plans/2610091931 chunk 3b, rev
// 2026-10-11). A conversation in any group but `brain` (config/browsers.yaml; unlisted → `shared`)
// launches its GROUP's Chrome over --remote-debugging-pipe, driven by a pipe cdpClient (3a), admitted
// by the pure memory check (chunk 2). The `brain` group (and every conversation-less caller) keeps
// today's brain Chrome on :9221, untouched.
//
// NO REAL CHROME: spawnChromePipe is faked with two in-memory streams as fds 3 & 4 (like 3a's fake
// peer) and a fake child; memory (freeMem/rssOf) is injected as plain numbers, so admission is
// deterministic. The pipe client actually speaks CDP against a scripted peer, so "a client was built
// over the pipe" is proven by a round-trip, not by inspection.
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { chromePipeArgs } from '../src/tools/chrome-launcher.mjs';
import { createCommands, CHROME_BRAIN_PROFILE } from '../src/spine/commands.mjs';
import { chromeConversationOf } from '../src/spine/chrome-pool.mjs';
import { readBrowserGroups } from '../src/rooms-file.mjs';

const MB = 1024 * 1024;

// A scripted CDP peer on the fd pair: answers Target.getTargets so client.listTabs round-trips.
const TARGETS = [{ targetId: 'T1', type: 'page', url: 'https://x/', title: 'x' }];
function wirePeer(toChrome, toClient) {
  let buf = Buffer.alloc(0);
  toChrome.on('data', (chunk) => {
    buf = Buffer.concat([buf, Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)]);
    let i;
    while ((i = buf.indexOf(0)) !== -1) {
      const frame = buf.subarray(0, i);
      buf = buf.subarray(i + 1);
      if (!frame.length) continue;
      const msg = JSON.parse(frame.toString('utf8'));
      const result = msg.method === 'Target.getTargets' ? { targetInfos: TARGETS } : {};
      toClient.write(JSON.stringify({ id: msg.id, result }) + '\0');
    }
  });
}

// A fake spawnChromePipe: records call opts + the handles it returned, wires opts.onExit to the fake
// child (as the real launcher does), and models memory as a shared cell — a spawn CONSUMES `cost`, a
// child.kill() (eviction) FREES it, so pressure is deterministic.
function fakePipeSpawner({ mem = { free: Infinity }, cost = 0 } = {}) {
  const calls = [];
  const handles = [];
  let pid = 1000;
  const spawnChromePipe = async (opts) => {
    calls.push(opts);
    const toChrome = new PassThrough();
    const toClient = new PassThrough();
    wirePeer(toChrome, toClient);
    const child = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.stdio = [null, null, null, toChrome, toClient];
    child.kill = () => {
      if (child.killed) return;
      child.killed = true; child.exitCode = 0;
      mem.free += cost;
      try { toClient.end(); } catch { /* best effort */ }
      child.emit('exit', 0, null);
    };
    if (opts.onExit) {
      child.on('error', (error) => opts.onExit({ code: null, signal: null, error }));
      child.on('exit', (code, signal) => opts.onExit({ code, signal, error: null }));
    }
    mem.free -= cost;
    const h = { child, writable: toChrome, readable: toClient, pid: ++pid, userDataDir: opts.userDataDir };
    handles.push(h);
    return h;
  };
  return { spawnChromePipe, calls, handles };
}

function build({ config = {}, mem, cost = 0, freeMem, rssOf } = {}) {
  const { spawnChromePipe, calls, handles } = fakePipeSpawner({ mem, cost });
  const logs = [];
  let clk = 0;
  // Shared path: a DOWN cdp + a failing launch seam, so startBrowser resolves without a real socket.
  const sharedCdp = {
    isRunning: async () => false, cdpHost: async () => 'localhost:9221', listTabs: async () => [],
    openTab: async () => {}, activateTarget: async () => {}, closeTab: async () => {},
  };
  const cmds = createCommands({
    getConfig: () => config,
    cdp: sharedCdp,
    spawnChromePipe,
    freeMem: freeMem ?? (() => (mem ? mem.free : Infinity)),
    rssOf: rssOf ?? (() => null),
    onChromeLog: (m) => logs.push(m),
    launchChrome: () => ({ ok: false }),
    now: () => (clk += 1),
    sleep: async () => {},
    send: async () => {},
    brains: { resolve: (name) => ({ name, type: 'ccode' }) },
  });
  return { cmds, calls, handles, logs };
}

const SHARED = { key: 'Reinie-2607150057', name: 'Reinie', group: 'shared' };
const sharedDir = join(dirname(CHROME_BRAIN_PROFILE), 'shared');
const BRAIN = { key: 'eGPT Admin-2601010000', name: 'eGPT Admin', group: 'brain' };

describe('chromePipeArgs — pipe, non-default profile, no port/origins', () => {
  const args = chromePipeArgs({ userDataDir: 'C:/x/profiles/conv-1' });
  it('uses --remote-debugging-pipe, never a port', () => {
    expect(args).toContain('--remote-debugging-pipe');
    expect(args.some((a) => a.startsWith('--remote-debugging-port'))).toBe(false);
  });
  it('drops --remote-allow-origins (that is port/WS-only)', () => {
    expect(args.some((a) => a.startsWith('--remote-allow-origins'))).toBe(false);
  });
  it('keeps a NON-default --user-data-dir, --no-first-run and the renderer-alive flags', () => {
    expect(args).toContain('--user-data-dir=C:/x/profiles/conv-1');
    expect(args).toContain('--no-first-run');
    expect(args).toContain('--disable-renderer-backgrounding');
    expect(args).toContain('--disable-background-timer-throttling');
    expect(args).toContain('--disable-backgrounding-occluded-windows');
  });
});

describe('a non-brain GROUP → its group pipe Chrome + a pipe cdpClient', () => {
  it('pipe-spawns <profiles-root>/<group>, with the configured binary, and builds a working pipe client', async () => {
    const { cmds, calls } = build({ config: { chrome: { bin: 'C:/x/chrome.exe' } } });
    const r = await cmds.chromeClientFor(SHARED);
    expect(r.dedicated).toBe(true);
    expect(r.profileDir).toBe(sharedDir);
    expect(calls).toHaveLength(1);
    expect(calls[0].userDataDir).toBe(sharedDir);
    expect(calls[0].userDataDir).not.toBe(CHROME_BRAIN_PROFILE);   // non-default (Chrome 136 requires it)
    expect(calls[0].bin).toBe('C:/x/chrome.exe');
    // the client speaks CDP over the pipe against the scripted peer
    const tabs = await r.client.listTabs();
    expect(tabs).toEqual([{ id: 'T1', type: 'page', url: 'https://x/', title: 'x' }]);
  });

  it('group brain stays on today\'s :9221 port path (no pipe spawn) — admin_channel plays no part', async () => {
    const { cmds, calls } = build({ config: { chrome: {} }, mem: { free: 8192 * MB } });
    const r = await cmds.chromeClientFor(BRAIN);
    expect(r.dedicated).toBe(false);
    expect(r.host).toBe('localhost:9221');
    expect(calls).toHaveLength(0);
  });

  it('two chats in the SAME group share ONE Chrome', async () => {
    const { cmds, calls } = build({ mem: { free: 8192 * MB } });
    const a = await cmds.chromeClientFor(SHARED);
    const b = await cmds.chromeClientFor({ key: 'Diego-2605201243', name: 'Diego', group: 'shared' });
    expect(calls).toHaveLength(1);
    expect(b.client).toBe(a.client);
  });
});

describe('FAIL CLOSED: a chat the lookup refused gets NO browser and one log line', () => {
  it('a chat listed in two groups → no client, nothing spawned, never the brain port client', async () => {
    const { cmds, calls, logs } = build({ mem: { free: 8192 * MB } });
    const conv = chromeConversationOf({ conversation_path: 'x/eGPT Admin-2609121344' }, { brain: ['eGPT Admin'], work: ['eGPT Admin'] });
    const r = await cmds.chromeClientFor(conv);
    expect(r.client).toBe(null);
    expect(r.host).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(logs.filter((l) => /no browser for "eGPT Admin".*brain, work/.test(l))).toHaveLength(1);
  });

  it('an unsafe group name → no client, nothing spawned', async () => {
    const { cmds, calls, logs } = build({ mem: { free: 8192 * MB } });
    const r = await cmds.chromeClientFor({ key: 'x-1', name: 'Diego', group: '../brain' });
    expect(r.client).toBe(null);
    expect(calls).toHaveLength(0);
    expect(logs.filter((l) => /no browser for "Diego"/.test(l))).toHaveLength(1);
  });

  it('a non-brain group whose dir IS the brain profile dir → no browser, never the brain Chrome', async () => {
    const work = join(dirname(CHROME_BRAIN_PROFILE), 'work');
    const { cmds, calls, logs } = build({ config: { chrome: { profile_dir: work } }, mem: { free: 8192 * MB } });
    const r = await cmds.chromeClientFor({ key: 'x-1', name: 'Diego', group: 'work' });
    expect(r.client).toBe(null);
    expect(calls).toHaveLength(0);
    expect(logs.filter((l) => /no browser for "Diego".*brain profile dir/.test(l))).toHaveLength(1);
  });
});

describe('browsers.yaml end to end — an operator edit moves a chat without a restart', () => {
  it('eGPT Rodz Lulu An: brain (port path) → removed from brain → shared (pipe)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'egpt-browsers-'));
    const saved = process.env.EGPT_HOME;
    try {
      process.env.EGPT_HOME = home;
      mkdirSync(join(home, 'config'));
      const file = join(home, 'config', 'browsers.yaml');
      writeFileSync(file, 'groups:\n  brain: [ "eGPT Admin", "eGPT Rodz Lulu An" ]\n');
      const { cmds, calls } = build({ mem: { free: 8192 * MB } });
      const entry = { conversation_path: '.egpt/conversations/whatsapp/eGPT Rodz Lulu An-2609201419' };   // live shape: no pushedName

      const before = await cmds.chromeClientFor(chromeConversationOf(entry, await readBrowserGroups()));
      expect(before.dedicated).toBe(false);
      expect(calls).toHaveLength(0);

      writeFileSync(file, 'groups:\n  brain: [ "eGPT Admin" ]\n');
      const after = await cmds.chromeClientFor(chromeConversationOf(entry, await readBrowserGroups()));
      expect(after.profileDir).toBe(sharedDir);
      expect(calls).toHaveLength(1);
    } finally {
      process.env.EGPT_HOME = saved;
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('memory admission gates the EXTRA (non-brain) group Chromes', () => {
  it('LAUNCHES when free memory is well above the margin', async () => {
    const { cmds, calls } = build({ mem: { free: 8192 * MB } });
    const r = await cmds.chromeClientFor(SHARED);
    expect(r.dedicated).toBe(true);
    expect(r.client).not.toBe(null);
    expect(calls).toHaveLength(1);
  });

  it('DECLINES below the margin with nothing to evict — nothing spawned', async () => {
    // 100 − 500 estimate = −400 MB, far below the 1024 MB margin; the pool is empty so canEvict=false.
    const { cmds, calls } = build({ mem: { free: 100 * MB } });
    const r = await cmds.chromeClientFor(SHARED);
    expect(r.declined).toBe(true);
    expect(r.client).toBe(null);
    expect(r.why).toMatch(/margin/i);
    expect(calls).toHaveLength(0);
  });

  it('under pressure, EVICTS the idlest group Chrome then launches the newcomer', async () => {
    // Each Chrome costs 600 MB; 2200 MB leaves room for two (estimate 500 + margin 1024) but not three.
    const mem = { free: 2200 * MB };
    const { cmds, calls, handles, logs } = build({ mem, cost: 600 * MB });
    const A = { key: 'a', name: 'A', group: 'A-1' };
    const B = { key: 'b', name: 'B', group: 'B-1' };
    const C = { key: 'c', name: 'C', group: 'C-1' };
    await cmds.chromeClientFor(A);   // free 2200 → 1600
    await cmds.chromeClientFor(B);   // free 1600 → 1000
    const rc = await cmds.chromeClientFor(C);   // 1000 − 500 < 1024 → evict idlest (A), free 1600, launch C

    expect(rc.dedicated).toBe(true);
    expect(rc.client).not.toBe(null);
    expect(calls).toHaveLength(3);                       // A, B, C each spawned once
    const aHandle = handles.find((h) => h.userDataDir.endsWith('A-1'));
    expect(aHandle.child.killed).toBe(true);             // the idlest (A) was evicted
    expect(logs.some((l) => /evicted dedicated Chrome .*A-1/.test(l))).toBe(true);

    // the evicted profile persists on disk → a later ensure relaunches it (room is free again here)
    mem.free = 8192 * MB;
    await cmds.chromeClientFor(A);
    expect(calls).toHaveLength(4);
  });
});

describe('per-profile single-flight + never-relaunch-a-live-profile', () => {
  it('two concurrent ensures of the SAME profile spawn ONE Chrome and share the client', async () => {
    const { cmds, calls } = build({ mem: { free: 8192 * MB } });
    const [a, b] = await Promise.all([cmds.chromeClientFor(SHARED), cmds.chromeClientFor(SHARED)]);
    expect(calls).toHaveLength(1);
    expect(a.client).toBe(b.client);
  });

  it('a second ensure of a LIVE profile relaunches nothing and returns the running client', async () => {
    const { cmds, calls } = build({ mem: { free: 8192 * MB } });
    const first = await cmds.chromeClientFor(SHARED);
    const second = await cmds.chromeClientFor(SHARED);
    expect(calls).toHaveLength(1);
    expect(second.client).toBe(first.client);
    expect(second.pid).toBe(first.pid);
  });

  it('two DISTINCT groups each get their own Chrome', async () => {
    const { cmds, calls } = build({ mem: { free: 8192 * MB } });
    const a = await cmds.chromeClientFor(SHARED);
    const b = await cmds.chromeClientFor({ key: 'Other-2601010000', name: 'Other', group: 'work' });
    expect(calls).toHaveLength(2);
    expect(a.client).not.toBe(b.client);
    expect(a.profileDir).not.toBe(b.profileDir);
  });
});

describe('the brain path is inert and unchanged', () => {
  it('INERT: a conversation-less startBrowser never touches the pipe spawner', async () => {
    const { cmds, calls } = build({});
    await cmds.startBrowser();   // today's shared launch path
    expect(calls).toHaveLength(0);
  });
});
