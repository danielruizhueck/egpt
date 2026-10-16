// tests/warm-reconfigure.test.mjs — a being's configuration change reaches its live `claude` as a
// control request (measured on claude 2.1.301: set_model, apply_flag_settings {effortLevel}); only what a
// process cannot take reopens it — by resume, and never while its background work runs (operator
// 2026-10-16: "a being's CONFIG change must NOT close its session"). Real pool + session, fake claude.
import { describe, it, expect } from 'vitest';
import { createWarmPool } from '../src/warm-sessions.mjs';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';
import { fakeClaude } from './fake-claude-cli.mjs';

const KEY = 'egpt:ccode:whatsapp:fam';
const flush = async (n = 20) => { for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r)); };

describe('(c) a configuration change does not close the session', () => {
  function direct() {
    const spawns = [];
    const logs = [];
    const woken = [];
    const pool = createWarmPool({
      makeSession: (o) => createWarmCliSession({ ...o, spawn: (bin, args) => { const c = fakeClaude(9000 + spawns.length); spawns.push({ args, child: c }); return c; } }),
      onBackgroundDone: (key, info) => woken.push(info),
      onLog: (m) => logs.push(m),
    });
    return { pool, spawns, logs, woken };
  }
  const go = (d, text, brainOptions) => d.pool.run(KEY, text, () => {}, { brainOptions, klass: 'conversation' });

  it('model and effort apply in the live process — no close, no respawn — and the next turn runs on them', async () => {
    const d = direct();
    await go(d, 'uno', { model: 'sonnet', effort: 'high', sessionId: null });
    await go(d, 'dos', { model: 'opus', effort: 'low', sessionId: 'sess-1' });
    const claude = d.spawns[0].child;
    expect(d.spawns).toHaveLength(1);                  // ← before: evicted and respawned (configuration changed: model sonnet→opus)
    expect(claude.killed).toBe(false);
    expect(claude.controls).toEqual([{ subtype: 'set_model', model: 'opus' }, { subtype: 'apply_flag_settings', settings: { effortLevel: 'low' } }]);
    expect(claude.lines).toEqual(['uno', 'dos']);
    expect(d.logs.some((l) => l.includes(`configuration applied to the live process on ${KEY} (model sonnet→opus, effort high→low)`))).toBe(true);
    await go(d, 'tres', { model: 'opus', effort: 'low', sessionId: 'sess-1' });
    expect(claude.controls).toHaveLength(2);           // applied once
  });

  it('verbose_thinking is the bridge\'s own: it changes with no request and no close', async () => {
    const d = direct();
    await go(d, 'uno', { model: 'sonnet', verboseThinking: false });
    await go(d, 'dos', { model: 'sonnet', verboseThinking: true });
    expect(d.spawns).toHaveLength(1);
    expect(d.spawns[0].child.controls).toEqual([]);
  });

  it('a respawn after a live change starts on the new values', async () => {
    const d = direct();
    await go(d, 'uno', { model: 'sonnet' });
    await go(d, 'dos', { model: 'opus', sessionId: 'sess-1' });
    d.spawns[0].child.emit('close', 1);               // the process died between turns
    await go(d, 'tres', { model: 'opus', sessionId: 'sess-1' });
    expect(d.spawns).toHaveLength(2);
    expect(d.spawns[1].args.join(' ')).toContain('--model opus');
  });

  it('a value the CLI refuses fails that turn with its reason and keeps the session (and its old model)', async () => {
    const d = direct();
    await go(d, 'uno', { model: 'sonnet' });
    await expect(go(d, 'dos', { model: 'bogus', sessionId: 'sess-1' })).rejects.toThrow(/set_model refused — Model 'bogus' not found/);
    expect(d.spawns[0].child.killed).toBe(false);
    expect(d.pool.has(KEY)).toBe(true);
    expect((await go(d, 'tres', { model: 'sonnet', sessionId: 'sess-1' })).text).toBe('echo:tres');
    expect(d.spawns).toHaveLength(1);
  });

  it('what a process cannot take (the system prompt) reopens by resume — deferred while background work runs, never closing it', async () => {
    const d = direct();
    await go(d, 'bg: audit', { model: 'sonnet', appendSystemPrompt: 'A' });
    await go(d, 'dos', { model: 'opus', appendSystemPrompt: 'B', sessionId: 'sess-1' });
    const claude = d.spawns[0].child;
    expect(claude.killed).toBe(false);
    expect(claude.controls).toEqual([{ subtype: 'set_model', model: 'opus' }]);   // the live half still applies
    expect(d.logs.some((l) => /configuration changed on .* \(appendSystemPrompt\) — reopen deferred: 1 background task\(s\) still running/.test(l))).toBe(true);

    claude.finishBg();
    await flush();
    await go(d, 'tres', { model: 'opus', appendSystemPrompt: 'B', sessionId: 'sess-1' });
    expect(claude.killed).toBe(true);                  // reopened once the work was done
    expect(d.spawns).toHaveLength(2);
    expect(d.spawns[1].args).toEqual(expect.arrayContaining(['--resume', 'sess-1', '--append-system-prompt', 'B', '--model', 'opus']));
  });
});
