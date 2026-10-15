// The spine runs at NORMAL priority, every being process at BELOW_NORMAL (2026-10-15: a being's
// transcription at the spine's own BelowNormal class put ingestion 2+ minutes behind on reve).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-process-priority-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { EventEmitter } from 'node:events';
import { promises as fs, mkdtempSync, rmSync } from 'node:fs';
import { constants, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';
import { createCodexCliSession } from '../src/codex-cli-session.mjs';
import { createPiCliSession } from '../src/pi-cli-session.mjs';
import { createSandboxCliSession, spawnBoxedCommand } from '../src/sandbox-cli-session.mjs';
import { startProfileDaemons } from '../src/daemon-runtime.mjs';

const { PRIORITY_NORMAL, PRIORITY_BELOW_NORMAL } = constants.priority;
const STORE = mkdtempSync(join(tmpdir(), 'egpt-priority-store-'));

let boot, emptyState;
beforeAll(async () => {
  await fs.mkdir(join(_HOME, 'state'), { recursive: true });
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  try { await fs.rm(_HOME, { recursive: true, force: true }); } catch { /* best effort */ }
  try { rmSync(STORE, { recursive: true, force: true }); } catch { /* best effort */ }
});

function recorder({ fail = false } = {}) {
  const calls = [];
  const setPriority = (pid, prio) => { calls.push([pid, prio]); if (fail) throw new Error('EPERM'); };
  return { calls, setPriority };
}

// A process that never answers and dies when killed: the spawn is all these tests look at.
function fakeSpawn({ pid = 4242 } = {}) {
  const spawned = [];
  const spawn = (bin, args) => {
    const proc = new EventEmitter();
    if (pid != null) proc.pid = pid;
    proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
    proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
    proc.stdin = { write: () => true, end: () => {} };
    proc.kill = () => setImmediate(() => { proc.emit('exit', null, 'SIGTERM'); proc.emit('close', null, 'SIGTERM'); });
    spawned.push({ bin, args });
    return proc;
  };
  return { spawn, spawned };
}

async function spawnOnce(session) {
  const turn = Promise.resolve().then(() => session.turn('hi')).catch(() => {});
  await new Promise((r) => setImmediate(r));
  session.close();
  await turn;
}

describe('the spine raises itself to NORMAL at boot', () => {
  function memIo() {
    const files = new Map(); const dirs = new Set();
    const missing = (p) => Object.assign(new Error(`ENOENT: ${p}`), { code: 'ENOENT' });
    return {
      appendFile: async (p, d) => files.set(p, `${files.get(p) ?? ''}${d}`),
      writeFile: async (p, d) => files.set(p, String(d)),
      readFile: async (p) => { if (!files.has(p)) throw missing(p); return files.get(p); },
      mkdir: async (p) => { dirs.add(p); },
      existsSync: (p) => files.has(p) || dirs.has(p),
      readdir: async (p) => [...files.keys()].filter((f) => dirname(f) === p).map((f) => f.slice(p.length + 1)),
      rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
    };
  }
  const CONFIG = {
    node_name: 'kg',
    networks: { whatsapp: { chat_ids: ['!self:beeper.com'], allowed_users: ['u-1'] } },
    agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } },
  };
  async function bootWith(setPriority) {
    const logs = [];
    let state = emptyState();
    const app = await boot({
      readConfig: () => CONFIG,
      startBridge: async () => ({ async send() { return { ok: true }; }, startStreamMessage: () => ({ update() {}, async finish() {} }), isAlive: () => true, stop() {} }),
      makeSession: () => ({ sessionId: 's', async turn() { return { text: '' }; }, close() {} }),
      loadState: async () => state,
      writeState: async (s) => { state = s; },
      io: memIo(), ingest: false, tickMs: 0, exit: () => {},
      log: { line: (s) => logs.push(s) },
      setPriority,
    });
    return { app, logs };
  }

  it('calls setPriority(0, PRIORITY_NORMAL)', async () => {
    const r = recorder();
    const { app } = await bootWith(r.setPriority);
    app.stop();
    expect(r.calls).toEqual([[0, PRIORITY_NORMAL]]);
  });

  it('a refused raise is logged and boot carries on', async () => {
    const r = recorder({ fail: true });
    const { app, logs } = await bootWith(r.setPriority);
    expect(app).toBeTruthy();
    app.stop();
    expect(logs.filter((l) => /priority/i.test(l) && /EPERM/.test(l))).toHaveLength(1);
  });
});

describe('the daemon raises itself to NORMAL before it spawns a spine', () => {
  it('calls setPriority(0, PRIORITY_NORMAL) ahead of every runtime start', () => {
    const order = [];
    const r = recorder();
    startProfileDaemons({
      profiles: ['C:/a'],
      processObj: { env: {}, pid: 7, on: () => {}, exit: () => {} },
      stdout: { write: () => {} },
      now: () => 0,
      setPriority: (...a) => { order.push('priority'); r.setPriority(...a); },
      createRuntime: () => ({ state: {}, start: () => { order.push('start'); return {}; } }),
    });
    expect(r.calls).toEqual([[0, PRIORITY_NORMAL]]);
    expect(order).toEqual(['priority', 'start']);
  });
});

describe('every being engine is lowered to BELOW_NORMAL right after its spawn', () => {
  it('ccode (warm-cli-session)', async () => {
    const r = recorder(); const f = fakeSpawn();
    await spawnOnce(createWarmCliSession({ spawn: f.spawn, setPriority: r.setPriority }));
    expect(f.spawned).toHaveLength(1);
    expect(r.calls).toEqual([[4242, PRIORITY_BELOW_NORMAL]]);
  });

  it('codex (codex-cli-session)', async () => {
    const r = recorder(); const f = fakeSpawn();
    await spawnOnce(createCodexCliSession({ spawn: f.spawn, bin: 'codex-test', setPriority: r.setPriority }));
    expect(f.spawned).toHaveLength(1);
    expect(r.calls).toEqual([[4242, PRIORITY_BELOW_NORMAL]]);
  });

  it('pi (pi-cli-session)', async () => {
    const r = recorder(); const f = fakeSpawn();
    await spawnOnce(createPiCliSession({ spawn: f.spawn, bin: 'pi-test', setPriority: r.setPriority }));
    expect(f.spawned).toHaveLength(1);
    expect(r.calls).toEqual([[4242, PRIORITY_BELOW_NORMAL]]);
  });

  it('a sandboxed ccode being: the launcher is lowered, once', async () => {
    const r = recorder(); const f = fakeSpawn({ pid: 5151 });
    await spawnOnce(createSandboxCliSession({
      spawn: f.spawn, cwd: process.cwd(), platform: 'win32',
      sandboxOauthToken: 'sk-ant-oat01-FAKE-TEST-TOKEN-NOT-REAL', jsonlStoreRoot: STORE,
      setPriority: r.setPriority,
    }));
    expect(f.spawned[0].bin).toBe('powershell.exe');
    expect(r.calls).toEqual([[5151, PRIORITY_BELOW_NORMAL]]);
  });

  it('a being-written heartbeat command (spawnBoxedCommand)', () => {
    const r = recorder(); const f = fakeSpawn({ pid: 6161 });
    spawnBoxedCommand({
      targetFolder: process.cwd(), command: 'echo hi', commandFile: 'x.sh',
      spawn: f.spawn, platform: 'win32', gitBashCandidates: [process.execPath], setPriority: r.setPriority,
    });
    expect(r.calls).toEqual([[6161, PRIORITY_BELOW_NORMAL]]);
  });

  it('a spawn with no pid lowers nothing (pid 0 would be the spine itself)', async () => {
    const r = recorder(); const f = fakeSpawn({ pid: null });
    await spawnOnce(createWarmCliSession({ spawn: f.spawn, setPriority: r.setPriority }));
    expect(f.spawned).toHaveLength(1);
    expect(r.calls).toEqual([]);
  });

  it('a refused lowering is logged and the spawn stands', async () => {
    const r = recorder({ fail: true }); const f = fakeSpawn();
    const logs = [];
    await spawnOnce(createWarmCliSession({ spawn: f.spawn, setPriority: r.setPriority, onLog: (m) => logs.push(m) }));
    expect(r.calls).toEqual([[4242, PRIORITY_BELOW_NORMAL]]);
    expect(logs.filter((l) => /priority/i.test(l) && /4242/.test(l) && /EPERM/.test(l))).toHaveLength(1);
  });
});
