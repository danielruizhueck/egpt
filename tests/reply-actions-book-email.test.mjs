// /book + /email as being limbs (src/spine/reply-actions.mjs): parsed like every limb, run ONLY for
// an agent whose agents.<name>.actions lists them, and their outcome handed back through `wake`
// (boot: spine.wakeOnBackground).
import { describe, it, expect, vi } from 'vitest';
import { parseReplyActions, partialProse, createReplyActions } from '../src/spine/reply-actions.mjs';
import { limbAction } from '../src/dispatch-line.mjs';

const EV = { chatId: '!lead:beeper.local', surface: 'whatsapp', chatName: 'Juan' };
const BRIDGE = { send: async () => ({}), react: async () => true };

describe('parse', () => {
  it('/book <date> <time> <summary> and /email <text> are actions, stripped from the prose', () => {
    const { prose, run, stripped } = parseReplyActions('Perfecto, lo agendo.\n/book 2026-10-20 10:00 Demo EduWeb — Colegio San José\n/email Lead: Juan, Colegio San José, 0414-000', EV);
    expect(prose).toBe('Perfecto, lo agendo.');
    expect(stripped).toEqual([]);
    expect(run).toEqual([
      { type: 'book', chatId: EV.chatId, date: '2026-10-20', time: '10:00', summary: 'Demo EduWeb — Colegio San José' },
      { type: 'email', chatId: EV.chatId, text: 'Lead: Juan, Colegio San José, 0414-000' },
    ]);
  });

  it('a /book whose date is unreadable still runs, so its failure can reach the being', () => {
    expect(parseReplyActions('/book mañana a las 10 demo', EV).run).toEqual([{ type: 'book', chatId: EV.chatId, date: null, time: null, summary: 'mañana a las 10 demo' }]);
  });

  it('an empty or placeholder-only line is stripped, never run', () => {
    for (const line of ['/book', '/book <YYYY-MM-DD> <HH:MM> <summary>', '/email', '/email <text>']) {
      const { run, stripped, prose } = parseReplyActions(line, EV);
      expect(run).toEqual([]);
      expect(stripped).toHaveLength(1);
      expect(prose).toBe('');
    }
  });

  it('mid-sentence mentions stay prose; a streaming /book line is withheld until it ends', () => {
    expect(parseReplyActions('puedo usar /book y /email si hace falta', EV).run).toEqual([]);
    expect(partialProse('Listo.\n/bo', EV)).toBe('Listo.');
    expect(partialProse('Listo.\n/book 2026-10-20 10', EV)).toBe('Listo.');
  });
});

function build({ actions = { 'edw-marketer': ['book', 'email'] }, limbs, wake = vi.fn(async () => true) } = {}) {
  const logs = [];
  const calls = [];
  const fake = (type, r) => async (a, ev, being) => { calls.push({ type, a, ev, being }); return r; };
  const ra = createReplyActions({
    bridge: BRIDGE,
    limbs: limbs ?? { book: fake('book', { outcome: 'busy', detail: 'that slot is taken; nearest free slots (America/Caracas): 2026-10-20 11:00' }), email: fake('email', { outcome: 'sent' }) },
    actionsOf: (being) => actions[being],
    wake,
    onLog: (m) => logs.push(m),
  });
  const run = (text, being) => { const p = ra.parse(text, EV); return ra.execute(p.run, p.stripped, EV, { being }); };
  return { run, logs, calls, wake };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('execute — enabled agents only, outcome back through the wake', () => {
  it('an enabled agent runs the limb; the outcome is recorded and woken back into the same chat', async () => {
    const { run, calls, wake } = build();
    const { ran } = await run('/book 2026-10-20 10:00 Demo\n/email Lead: Juan', 'edw-marketer');
    expect(calls.map((c) => [c.type, c.being, c.ev.chatId])).toEqual([['book', 'edw-marketer', EV.chatId], ['email', 'edw-marketer', EV.chatId]]);
    expect(ran.map((a) => [a.type, a.outcome])).toEqual([['book', 'busy'], ['email', 'sent']]);
    await tick();
    expect(wake.mock.calls.map((c) => c[0])).toEqual([
      { being: 'edw-marketer', surface: 'whatsapp', chatId: EV.chatId, summaries: ['/book 2026-10-20 10:00 → busy: that slot is taken; nearest free slots (America/Caracas): 2026-10-20 11:00'] },
      { being: 'edw-marketer', surface: 'whatsapp', chatId: EV.chatId, summaries: ['/email → sent'] },
    ]);
  });

  it('a being NOT enabled cannot use the verbs: refused, logged, no limb, no wake, not recorded', async () => {
    for (const [being, actions] of [['egpt', { 'edw-marketer': ['book', 'email'] }], ['edw-marketer', { 'edw-marketer': ['email'] }], ['edw-marketer', {}]]) {
      const { run, calls, wake, logs } = build({ actions });
      const { ran } = await run('/book 2026-10-20 10:00 Demo', being);
      await tick();
      expect(calls).toEqual([]);
      expect(wake).not.toHaveBeenCalled();
      expect(ran).toEqual([]);
      expect(logs).toEqual([`book: not enabled for ${being} (agents.${being}.actions) — refused`]);
    }
  });

  it('the wake is never awaited — a turn that holds the FIFO cannot deadlock on it', async () => {
    const { run, wake } = build({ wake: vi.fn(() => new Promise(() => {})) });
    await expect(run('/email Lead', 'edw-marketer')).resolves.toMatchObject({ ran: [{ type: 'email', outcome: 'sent' }] });
    await tick();
    expect(wake).toHaveBeenCalledTimes(1);
  });

  it('no limb wired → not-configured, still returned to the being; no wake wired → logged', async () => {
    const { run, wake } = build({ limbs: {} });
    await run('/email Lead', 'edw-marketer');
    await tick();
    expect(wake.mock.calls[0][0].summaries).toEqual(['/email → not-configured']);
    const logs = [];
    const ra = createReplyActions({ bridge: BRIDGE, limbs: { email: async () => ({ outcome: 'sent' }) }, actionsOf: () => ['email'], onLog: (m) => logs.push(m) });
    const p = ra.parse('/email Lead', EV);
    await ra.execute(p.run, p.stripped, EV, { being: 'x' });
    expect(logs).toEqual(['email: no wake wired — result not returned to x: /email → sent']);
  });

  it('a failing wake is logged, never thrown into the turn', async () => {
    const { run, logs } = build({ wake: async () => { throw new Error('nope'); } });
    await run('/email Lead', 'edw-marketer');
    await tick();
    expect(logs).toEqual(['email: result wake failed: nope']);
  });
});

describe('transcript stage-direction', () => {
  it('records what the limb did, outcome included', () => {
    expect(limbAction({ type: 'book', date: '2026-10-20', time: '10:00', summary: 'Demo EduWeb', outcome: 'booked' })).toBe('/book 2026-10-20 10:00 "Demo EduWeb" → booked');
    expect(limbAction({ type: 'email', text: 'Lead: Juan', outcome: 'not-configured' })).toBe('/email "Lead: Juan" → not-configured');
  });
});
