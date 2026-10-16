// Agent usage stats (operator 2026-10-16): per being per chat, per user per being, and a
// per-being rollup — written at the ONE turn boundary (brainpool.turn), from the CLI's own
// result event (warm-cli-session). Structural, never fatal, no cost.
import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import * as YAML from 'yaml';
import { recordAgentTurn, mergeAgentTurn, turnUser, recordMemberStat, appendThreadStat } from '../src/conversations-state.mjs';
import { createWarmCliSession } from '../src/warm-cli-session.mjs';

const norm = (p) => String(p).replace(/\\/g, '/');
function memIo(seed = {}) {
  const files = new Map(Object.entries(seed).map(([k, v]) => [norm(k), v]));
  const slow = () => new Promise((r) => setTimeout(r, 3));
  const io = {
    readFile: async (p) => { await slow(); const k = norm(p); if (!files.has(k)) throw new Error('ENOENT'); return files.get(k); },
    writeFile: async (p, d) => { await slow(); files.set(norm(p), d); },
    mkdir: async () => {},
    rename: async (a, b) => { const f = norm(a), t = norm(b); if (files.has(f)) { files.set(t, files.get(f)); files.delete(f); } },
    existsSync: (p) => files.has(norm(p)),
    readdir: async (dir) => {
      const prefix = norm(dir).replace(/\/$/, '') + '/';
      return [...files.keys()].filter((k) => k.startsWith(prefix) && !k.slice(prefix.length).includes('/')).map((k) => k.slice(prefix.length));
    },
  };
  return { files, io };
}
const DIR = '/stats/whatsapp', BEINGS = '/stats/beings';
const opts = (io) => ({ io, statsDirOf: () => DIR, beingsDir: BEINGS });
const turn = (over = {}) => ({
  at: '2026-10-16T12:00:00.000Z', ms: 4000, error: false, name: 'E',
  usage: { tokens_in: 10, tokens_out: 200, cache_read: 5000, cache_write: 100 },
  model: 'claude-opus-4-1', bgStarted: 0, user: { id: '@a', name: 'Ana' }, ...over,
});

describe('mergeAgentTurn — one turn into a usage entry (pure)', () => {
  it('sums turns, time, tokens; counts errors, models, background; keeps last_turn', () => {
    let e = mergeAgentTurn({}, turn());
    e = mergeAgentTurn(e, turn({ ms: 2000, error: true, usage: null, model: 'claude-sonnet-4', bgStarted: 2, at: 'T2' }));
    expect(e).toEqual({
      turns: 2, errors: 1, time_ms: 6000, avg_s: 3,
      tokens_in: 10, tokens_out: 200, cache_read: 5000, cache_write: 100,
      models: { 'claude-opus-4-1': 1, 'claude-sonnet-4': 1 }, bg_tasks: 2, last_turn: 'T2',
    });
  });
  it('a turn with no usage adds no token keys', () => {
    expect(mergeAgentTurn({}, turn({ usage: null, model: null }))).toEqual({ turns: 1, errors: 0, time_ms: 4000, avg_s: 4, last_turn: '2026-10-16T12:00:00.000Z' });
  });
  it('never records cost', () => {
    expect(JSON.stringify(mergeAgentTurn({}, turn({ usage: { tokens_in: 1, total_cost_usd: 9 } })))).not.toContain('cost');
  });
});

describe('turnUser — who the turn is attributed to', () => {
  it('the human whose message opened the turn, else a named system bucket', () => {
    expect(turnUser({ senderId: '@a', senderName: 'Ana' })).toEqual({ id: '@a', name: 'Ana' });
    expect(turnUser({ cause: 'heartbeat' })).toEqual({ id: 'system:heartbeat' });
    expect(turnUser({})).toEqual({ id: 'system' });
  });
});

describe('recordAgentTurn — per chat, per user, per-being rollup', () => {
  it('writes agents + agent_users into the chat file and the rollup into beings/<being>.yaml', async () => {
    const { files, io } = memIo();
    await recordAgentTurn('whatsapp', '!c', 'egpt', turn(), opts(io));
    await recordAgentTurn('whatsapp', '!c', 'egpt', turn({ user: { id: 'system:heartbeat' }, at: 'T2' }), opts(io));
    const chat = YAML.parse(files.get(`${DIR}/!c.yaml`));
    expect(chat.chat_id).toBe('!c');
    expect(chat.agents.egpt).toMatchObject({ name: 'E', turns: 2, time_ms: 8000, tokens_out: 400, models: { 'claude-opus-4-1': 2 }, last_turn: 'T2' });
    expect(chat.agent_users['@a']).toEqual({ name: 'Ana', agents: { egpt: mergeAgentTurn({}, turn()) } });
    expect(chat.agent_users['system:heartbeat'].agents.egpt.turns).toBe(1);
    const roll = YAML.parse(files.get(`${BEINGS}/egpt.yaml`));
    expect(roll).toMatchObject({ being: 'egpt', name: 'E', turns: 2, time_ms: 8000 });
    expect(roll.users['@a']).toMatchObject({ name: 'Ana', turns: 1 });
    expect(roll.users['system:heartbeat'].turns).toBe(1);
    expect(files.get(`${BEINGS}/egpt.yaml`)).not.toContain('cost');
  });

  it('shares the chat file with the member collector and the thread mirror — no lost update', async () => {
    const { files, io } = memIo();
    await Promise.all([
      recordAgentTurn('whatsapp', '!c', 'egpt', turn(), opts(io)),
      recordMemberStat('whatsapp', '!c', '@a', 'T', { io, statsDirOf: () => DIR }),
      appendThreadStat('whatsapp', '!c', { id: 'TH1' }, { io, statsDirOf: () => DIR }),
    ]);
    const chat = YAML.parse(files.get(`${DIR}/!c.yaml`));
    expect(chat.agents.egpt.turns).toBe(1);
    expect(chat.members['@a'].count).toBe(1);
    expect(chat.threads.map((t) => t.id)).toEqual(['TH1']);
  });

  it('never fatal: a failing disk resolves false', async () => {
    const io = { readFile: async () => { throw new Error('EIO'); }, writeFile: async () => { throw new Error('disk full'); }, mkdir: async () => {}, readdir: async () => [], existsSync: () => false, rename: async () => {} };
    await expect(recordAgentTurn('whatsapp', '!c', 'egpt', turn(), opts(io))).resolves.toBe(false);
    await expect(recordAgentTurn('whatsapp', '', 'egpt', turn(), opts(io))).resolves.toBe(false);
  });
});

// The CLI's own `result` event is the one place tokens are known: the session hands them up on
// the turn's resolved value, beside text/sessionId — no second channel.
describe('warm-cli-session — the result event rides out on the turn', () => {
  function fake(lines) {
    const spawn = () => {
      const proc = new EventEmitter();
      proc.stdout = new EventEmitter(); proc.stdout.setEncoding = () => {};
      proc.stderr = new EventEmitter(); proc.stderr.setEncoding = () => {};
      proc.kill = () => {};
      proc.stdin = { write: () => setImmediate(() => { for (const l of lines) proc.stdout.emit('data', JSON.stringify(l) + '\n'); }), end: () => {} };
      return proc;
    };
    return spawn;
  }
  it('usage (tokens + cache), the init model and background tasks started — never cost', async () => {
    const s = createWarmCliSession({ spawn: fake([
      { type: 'system', subtype: 'init', session_id: 's1', model: 'claude-opus-4-1-20250805' },
      { type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', description: 'scan' }] },
      { type: 'result', subtype: 'success', result: 'ok', duration_ms: 900, num_turns: 3, total_cost_usd: 0.42,
        usage: { input_tokens: 12, output_tokens: 340, cache_read_input_tokens: 9000, cache_creation_input_tokens: 150 } },
    ]) });
    const r = await s.turn('hi');
    expect(r.text).toBe('ok');
    expect(r.usage).toEqual({ tokens_in: 12, tokens_out: 340, cache_read: 9000, cache_write: 150 });
    expect(r.model).toBe('claude-opus-4-1-20250805');
    expect(r.bgStarted).toBe(1);
    expect(JSON.stringify(r)).not.toContain('cost');
    s.close();
  });
  it('a result without usage resolves exactly { text, sessionId } as before', async () => {
    const s = createWarmCliSession({ spawn: fake([{ type: 'system', subtype: 'init', session_id: 's1' }, { type: 'result', subtype: 'success', result: 'ok' }]) });
    const r = await s.turn('hi');
    expect(r).toEqual({ text: 'ok', sessionId: 's1' });
    s.close();
  });
});
