// spine-intake-lanes.test.mjs — one intake lane per chat (operator 2026-10-18: "messages don't
// need to be in queue ... same channel is linear, different channels in parallel, memory-cpu
// aware so no starvation"). The fast phase of a slow message in chat A does not hold chat B; a
// chat's own messages stay in arrival order; at most intakeCap() lanes run at once and a busy
// chat yields its slot after each message; a lane is found with no lookup (a scope read before
// ingestion would create the conversation unseeded); commands keep the node-wide order.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { intakeCap, INTAKE_LANES } from '../src/spine/lag-probe.mjs';

const tick = () => new Promise((r) => setTimeout(r, 0));
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

function build({ cap, scopeOf, holdRecord = () => null, commands } = {}) {
  let cb = null;
  const order = [];            // fast-phase records, in the order they were written
  const opened = [];           // placeholders, in the order they opened
  let inFlight = 0, maxInFlight = 0;
  const bridge = { onMessage(fn) { cb = fn; }, send() {}, stop() {} };
  let turn = async (_b, ev) => ({ text: `ok ${ev.body}` });
  const brain = { turn: (...a) => turn(...a), ...(scopeOf ? { scopeOf } : {}) };
  const transcript = {
    async log(ev, reply) {
      if (reply != null) return;
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      try { await (holdRecord(ev) ?? null); order.push(`${ev.chatId}:${ev.body}`); } finally { inFlight--; }
    },
    logAction() {},
  };
  const spine = createSpine({
    bridge, brain, store: { recordThread() {} },
    identity: { build: (msg) => ({ ...msg, line: msg.body }) },
    router: { resolve: () => 'e' },
    gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
    sender: { open(chatId, o) { opened.push(`${chatId}:${o?.replyTo}`); return { update() {}, fail() {}, async finish() {} }; } },
    transcript, heartbeats: { runDue() {} }, commands,
    clock: { now: () => 1000 },
    ...(cap ? { intakeCap: cap } : {}),
  });
  spine.start();
  const emit = (chatId, body, extra = {}) => cb({ surface: 'wa', chatId, chatName: chatId, senderId: 'u-1', senderName: 'An', msgId: `${chatId}-${body}`, body, kind: 'text', raw: {}, ...extra });
  return { spine, emit, order, opened, max: () => maxInFlight, setTurn: (fn) => { turn = fn; } };
}

describe('intake lanes — per chat', () => {
  it('a slow message in chat A does not delay chat B', async () => {
    const g = gate();
    const h = build({ holdRecord: (ev) => (ev.chatId === 'A' ? g.p : null) });
    h.emit('A', 'slow');
    const b = h.emit('B', 'fast');
    const won = await Promise.race([b.then(() => 'B'), new Promise((r) => setTimeout(() => r('HELD'), 300))]);
    expect(won).toBe('B');
    expect(h.opened).toContain('B:B-fast');
    expect(h.opened).not.toContain('A:A-slow');
    g.open();
  });

  it('one chat stays strictly in arrival order, whatever each message costs', async () => {
    const g = gate();
    const h = build({ holdRecord: (ev) => (ev.body === '1' ? g.p : null) });
    const all = ['1', '2', '3'].map((n) => h.emit('A', n));
    await tick(); await tick();
    expect(h.order).toEqual([]);                 // 2 and 3 wait behind 1
    g.open();
    await Promise.all(all);
    expect(h.order).toEqual(['A:1', 'A:2', 'A:3']);
    expect(h.opened).toEqual(['A:A-1', 'A:A-2', 'A:A-3']);
  });

  it('at most intakeCap() lanes run at once', async () => {
    const g = gate();
    const h = build({ cap: () => 2, holdRecord: () => g.p });
    const all = ['A', 'B', 'C', 'D', 'E'].map((c) => h.emit(c, 'x'));
    await tick(); await tick();
    expect(h.max()).toBe(2);
    expect(h.spine.stats().queueDepth).toBe(3);
    g.open();
    await Promise.all(all);
    expect(h.max()).toBe(2);
    expect(h.order).toHaveLength(5);
  });

  it('no starvation: a busy chat yields its slot after each message', async () => {
    const holds = new Map();
    const hold = (key) => { const g = gate(); holds.set(key, g); return g.p; };
    const h = build({ cap: () => 1, holdRecord: (ev) => hold(`${ev.chatId}:${ev.body}`) });
    const all = [h.emit('A', '1'), h.emit('A', '2'), h.emit('A', '3'), h.emit('B', '1')];
    const release = async (key) => { while (!holds.has(key)) await tick(); holds.get(key).open(); await tick(); };
    await release('A:1');
    await release('B:1');                        // B runs before A's backlog drains
    await release('A:2');
    await release('A:3');
    await Promise.all(all);
    expect(h.order).toEqual(['A:1', 'B:1', 'A:2', 'A:3']);
  });

  it('a lane is found with no lookup: nothing is asked about the chat before its record', async () => {
    const seen = [];
    const scopeOf = async (_being, ev) => { seen.push(`scope ${ev.chatId}`); return { surface: ev.surface, chatId: ev.chatId }; };
    const h = build({ scopeOf, holdRecord: (ev) => { seen.push(`record ${ev.chatId}`); return null; } });
    await h.emit('new-dm', 'Hola');
    expect(seen[0]).toBe('record new-dm');       // a scope read can create the conversation before ingestion seeds it
  });

  it('chats that share a turn scope still take their turns one at a time (the turn FIFO)', async () => {
    let live = 0, most = 0;
    const g = gate();
    const scopeOf = async () => ({ surface: 'room', chatId: 'acim' });
    const h = build({ scopeOf });
    h.setTurn(async () => { live++; most = Math.max(most, live); await g.p; live--; return { text: 'ok' }; });
    const a = h.emit('acim', 'room line', { surface: 'room' });
    const b = h.emit('group', 'group line');
    await tick(); await tick(); await tick();
    expect(most).toBe(1);
    g.open();
    await Promise.all([a, b]);
    expect(most).toBe(1);
  });

  it('commands keep the node-wide order: two chats\' commands never run at once', async () => {
    let running = 0, max = 0;
    const g = gate();
    const commands = {
      isCommand: (ev) => ev.body.startsWith('/'),
      async run(ev) { running++; max = Math.max(max, running); if (ev.chatId === 'A') await g.p; running--; },
    };
    const h = build({ commands });
    const a = h.emit('A', '/agents x');
    const b = h.emit('B', '/agents y');
    await tick(); await tick(); await tick();
    expect(max).toBe(1);
    g.open();
    await Promise.all([a, b]);
    expect(max).toBe(1);
  });
});

describe('intakeCap — memory and CPU aware', () => {
  it('full width when idle, a quarter under pressure, one past the edge', () => {
    expect(intakeCap(null)).toBe(INTAKE_LANES);
    expect(intakeCap({ cpu: 20, busy: 10, free: 8, total: 16 })).toBe(INTAKE_LANES);
    expect(intakeCap({ cpu: 85, busy: 10, free: 8, total: 16 })).toBe(INTAKE_LANES / 4);
    expect(intakeCap({ cpu: 20, busy: 10, free: 1.5, total: 16 })).toBe(INTAKE_LANES / 4);
    expect(intakeCap({ cpu: 20, busy: 97, free: 8, total: 16 })).toBe(1);
    expect(intakeCap({ cpu: 20, busy: 10, free: 0.5, total: 16 })).toBe(1);
  });
});
