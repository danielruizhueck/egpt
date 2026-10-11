// tests/migrations-0039-the-port-chrome-tasks-are-gone.test.mjs — migrations/0039-the-port-chrome-tasks-are-gone.mjs.
//
// Task Scheduler is a fake: a set of registered task names that the migration's PowerShell scripts
// are dispatched against. Measured on reve 2026-10-11: both tasks registered (disabled); dolly has
// egpt-chrome only.
import { describe, it, expect } from 'vitest';
import { plan, elevated } from '../migrations/0039-the-port-chrome-tasks-are-gone.mjs';

function fakeScheduler(names, { refuse = [] } = {}) {
  const store = new Set(names);
  const calls = [];
  const ps = (script) => {
    const head = script.split('\n')[0];
    calls.push(head);
    if (head === '# egpt-0039:probe') return JSON.stringify([...store].filter((n) => /^egpt-chrome(-radio)?$/.test(n)));
    const name = head.match(/^# egpt-0039:unregister (.+)$/)?.[1];
    if (!name) throw new Error(`unexpected script: ${head}`);
    if (refuse.includes(name)) throw new Error(`Access is denied: ${name}`);
    store.delete(name);
    return '';
  };
  const ctx = { platform: 'win32', ps, log: () => {} };
  return { ctx, store, calls };
}

describe('0039 — the egpt-chrome / egpt-chrome-radio scheduled tasks are gone', () => {
  it('needs no elevation (the owner unregisters a task it registered)', () => {
    expect(elevated).toBe(false);
  });

  it('reve: plans both, unregisters both, then reads satisfied; other tasks untouched', async () => {
    const { ctx, store } = fakeScheduler(['egpt-chrome', 'egpt-chrome-radio', 'egpt-daemon']);
    const p = await plan(ctx);
    expect(p.satisfied).toBe(false);
    expect(p.changes).toHaveLength(2);
    expect(p.changes.join('\n')).toMatch(/egpt-chrome .*egpt-chrome-radio/s);
    await p.apply();
    expect([...store]).toEqual(['egpt-daemon']);
    expect((await plan(ctx)).satisfied).toBe(true);
  });

  it('dolly: only the one that exists', async () => {
    const { ctx, calls } = fakeScheduler(['egpt-chrome']);
    await (await plan(ctx)).apply();
    expect(calls.filter((c) => c.startsWith('# egpt-0039:unregister'))).toEqual(['# egpt-0039:unregister egpt-chrome']);
  });

  it('neither registered → satisfied, nothing unregistered', async () => {
    const { ctx, calls } = fakeScheduler([]);
    expect(await plan(ctx)).toMatchObject({ satisfied: true });
    expect(calls).toEqual(['# egpt-0039:probe']);
  });

  it('an unregister Windows refuses surfaces as a failure — never reported done', async () => {
    const { ctx } = fakeScheduler(['egpt-chrome'], { refuse: ['egpt-chrome'] });
    await expect((await plan(ctx)).apply()).rejects.toThrow(/Access is denied/);
  });

  it('off Windows → satisfied without touching PowerShell', async () => {
    const r = await plan({ platform: 'linux', ps: () => { throw new Error('no ps'); } });
    expect(r.satisfied).toBe(true);
  });
});
