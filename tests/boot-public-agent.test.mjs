// boot-public-agent.test.mjs — agents.<name>.public wired end to end through boot (2026-10-15): the
// lead's chat gets the reply text alone (no placeholder, no stamp, no 🏰), and a failed turn says
// nothing there; it is noticed in admin_channel through noticeToChannel. A being without the flag
// is locked: placeholder, stamp and signature as before.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-boot-public-agent-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { encodeNodeSignature } from '../src/node-signature.mjs';

let boot, emptyState, ensureContact;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const CHAT = '!lead:beeper.com';
const ADMIN = '!admin:beeper.com';
const CONFIG = (isPublic) => () => ({
  node_name: 'kg',
  user_name: 'John',
  bridge_signature_close: '🏰',
  admin_channel: ADMIN,
  beeper: { use: 'main', main: { account: 'you@example.com', token: 'TOK' } },
  agents: { egpt: { configuration: 'egpt', name: 'EduWeb', body_emoji: '🐶', handles: ['e'], default: true, ...(isPublic ? { public: true } : {}) } },
});

function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => { if (!files.has(path)) throw missing(path); return files.get(path); },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()].filter((f) => dirname(f) === path).map((f) => f.slice(path.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}

function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { onIncoming: opts.onIncoming, streams: [], sent: [] };
    built.push(spy);
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { init, finals: [], chatId: o?.chatId, delivered: true, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      async resolveChatId(nameOrId) { return String(nameOrId); },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

function seedOn() {
  const ens = ensureContact(emptyState(), 'whatsapp', CHAT, { pushedName: 'Bea', slugHint: 'bea' });
  const entry = ens.state.contacts.whatsapp[CHAT];
  entry.agents = { ...(entry.agents ?? {}), egpt: { ...(entry.agents?.egpt ?? {}), mode: 'on' } };
  return ens.state;
}

async function run({ isPublic, turn }) {
  const { start, built } = fakeTransport();
  let convState = seedOn();
  const lines = [];
  const app = await boot({
    readConfig: CONFIG(isPublic),
    startBridge: start,
    makeSession: (opts) => ({ opts, sessionId: 'sess-1', turn, close() {} }),
    probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState,
    writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0,
    now: () => Date.UTC(2026, 9, 15, 18, 0),
    log: { line: (m) => lines.push(m) },
  });
  const spy = built[0];
  await spy.onIncoming('hola, quiero información', { chatId: CHAT, chatName: 'Bea', network: 'whatsapp', userId: 'u-1', senderName: 'Bea', authorized: true, msgKey: 'm1' });
  return { app, spy, lines };
}
const reply = async (m, onUpdate) => { onUpdate?.('Hola'); return { text: 'Hola, ¿de qué colegio me escribes?', sessionId: 'sess-1' }; };

describe('boot — a public being', () => {
  it('the lead sees the reply text alone: no placeholder, no stamp, no 🏰 (the invisible frame stays)', async () => {
    const { app, spy } = await run({ isPublic: true, turn: reply });
    expect(spy.streams).toEqual([]);
    expect(spy.sent.filter((s) => s.chatId === CHAT).map((s) => s.text)).toEqual([`Hola, ¿de qué colegio me escribes?${encodeNodeSignature('kg', 'egpt')}`]);
    app.stop();
  });

  it('a failed turn says nothing in the lead\'s chat; the admin channel gets it', async () => {
    const { app, spy } = await run({ isPublic: true, turn: async () => { throw new Error('API Error: 529 overloaded'); } });
    await vi.waitFor(() => expect(spy.sent.some((s) => s.chatId === ADMIN)).toBe(true), { timeout: 3000 });
    expect(spy.sent.filter((s) => s.chatId === CHAT)).toEqual([]);
    expect(spy.streams).toEqual([]);
    const admin = spy.sent.find((s) => s.chatId === ADMIN).text;
    expect(admin).toContain(`egpt in ${CHAT}: turn failed:`);
    expect(admin).toContain('API Error: 529 overloaded');
    app.stop();
  });

  it('LOCK: without the flag the same being streams its placeholder, stamped and signed as before', async () => {
    const { app, spy } = await run({ isPublic: false, turn: reply });
    expect(spy.streams).toHaveLength(1);
    expect(spy.streams[0].init).toMatch(/^🐶 EduWeb: ⏳ Thinking… 🏰/);
    expect(spy.streams[0].finals[0]).toMatch(/^🐶 EduWeb: Hola, ¿de qué colegio me escribes\? 🏰/);
    app.stop();
  });
});
