// side-group-mouth-room.test.mjs — how the node learns Rodz's own room for a side group it made, by
// id, never by title (operator 2026-10-18). The real boot() on kg's two-connection shape: the primary
// makes the group P and posts the opener there itself; the opener's canary names P; Rodz's account
// receives its copy in its own room R (any chat — the bridge's awaitMessage); R is stored as the
// alias's mouth_chat, and the being's replies in P then go out on Rodz's connection, in R.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-side-group-mouth-room-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs } from 'node:fs';
import { dirname } from 'node:path';
import { shortChatId } from '../src/bridges/chat-id.mjs';

let boot, emptyState, ensureContact, recordThread;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact, recordThread } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const PRIMARY = 'TOK-primary';       // anrodz42 — the ear, and the account that makes every side group
const SECONDARY = 'TOK-secondary';   // dolly.egpt — Rodz, the mouth
const NAME_OF = { [PRIMARY]: 'primary', [SECONDARY]: 'secondary' };
const AN = '+16468217865';
const RODZ = '+13472576794';
const RODZ_ID = '@whatsapp_lid-rodz:beeper.local';
const ORIGIN = '!origin-as-primary-sees-it';
const P_FULL = '!sidegroup:beeper.local';    // what the primary's create returns
const P = shortChatId(P_FULL);
const R = '!sidegroup-as-rodz-sees-it';      // Rodz's own room for the same group
// The same title on another group Rodz is in: nothing may find a group by its title.
const DECOY = '!decoy-same-title';

const self = (id) => ({ id, isSelf: true });
const member = (id, phoneNumber) => ({ id, phoneNumber, fullName: id });
const WORLD = {
  [PRIMARY]: {
    [ORIGIN]: [self('an@beeper.local'), member(RODZ_ID, RODZ), member('lulu@beeper.local', '+34600000000')],
    [P]: [self('an@beeper.local'), member(RODZ_ID, RODZ)],
  },
  [SECONDARY]: {
    [R]: [self('rodz@dolly.local'), member('an@dolly.local', AN)],
    [DECOY]: [self('rodz@dolly.local'), member('an@dolly.local', AN)],
  },
};
const TITLE_OF = { [R]: 'SI+Origen-x', [DECOY]: 'SI+Origen-x' };
const SELF_IDENTITY = { [PRIMARY]: [AN, '@anrodriguez:beeper.com'], [SECONDARY]: [RODZ, '@dolly-egpt:beeper.com'] };
const digits = (v) => String(v ?? '').replace(/\D/g, '');
const rawChat = (token, id) => (WORLD[token][id] ? { id, type: 'group', accountID: 'whatsapp', title: TITLE_OF[id] ?? id, participants: { items: WORLD[token][id] } } : null);

// One spy per connection. What the primary sends into P reaches Rodz's account as its own copy in R.
function fakeTransport() {
  const built = [];
  const waiters = [];
  const start = async (opts) => {
    const token = opts.beeperToken;
    const spy = { connection: NAME_OF[token], token, onIncoming: opts.onIncoming, sent: [], streams: [], created: [] };
    built.push(spy);
    const copyToRodz = (chatId, text) => {
      if (token !== PRIMARY || shortChatId(chatId) !== P) return;
      const copy = { id: `copy-${waiters.length}`, chatID: R, text };
      for (const w of [...waiters]) if (w.test(copy)) { waiters.splice(waiters.indexOf(w), 1); w.done(copy); }
    };
    return {
      async send(text, o) { spy.sent.push({ text, chatId: o?.chatId }); copyToRodz(o?.chatId, text); return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { delivered: false, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); this.delivered = true; } };
        spy.streams.push(h); return h;
      },
      async editMessage() { return true; },
      async createGroup(o) { spy.created.push(o); return { success: true, chatID: P_FULL }; },
      async chatHasParticipant(chat, identity) {
        const roster = WORLD[token][shortChatId(chat)] ?? WORLD[token][chat];
        return roster ? roster.some((p) => (p.phoneNumber && digits(p.phoneNumber) === digits(identity)) || p.id === identity) : null;
      },
      async selfIdentities() { return SELF_IDENTITY[token]; },
      async chatRaw(chat) { return rawChat(token, chat) ?? rawChat(token, shortChatId(chat)); },
      async listChatsRaw() { return Object.keys(WORLD[token]).map((id) => rawChat(token, id)); },
      async listMessagesRaw() { return []; },
      async resolveUserIdByPhone(d) { return digits(d) === digits(RODZ) ? RODZ_ID : null; },
      awaitMessage(chat, test, ms) {
        if (token !== SECONDARY) return Promise.resolve(null);
        return new Promise((done) => { waiters.push({ chat, test, done }); setTimeout(() => done(null), ms).unref?.(); });
      },
      async resolveChatIdByTitle() { spy.byTitle = (spy.byTitle ?? 0) + 1; return DECOY; },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built, waiters };
}

function memIo() {
  const files = new Map();
  const dirs = new Set();
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    files,
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => { if (!files.has(path)) throw missing(path); return files.get(path); },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()].filter((f) => dirname(f) === path).map((f) => f.slice(path.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
  };
}
const fakeSession = (opts) => ({ sessionId: opts.sessionId ?? 'sess-1', async turn(m, onUpdate) { onUpdate?.('ok'); return { text: 'ok', sessionId: this.sessionId }; }, close() {} });

const KG = () => ({
  node_name: 'kg', node_role: 'primary', user_name: 'An',
  beeper: {
    primary: { account: 'anrodz42@example.com', token: PRIMARY, phone: AN },
    secondary: { account: 'dolly.egpt@example.com', token: SECONDARY, phone: RODZ },
  },
  agents: { egpt: { configuration: 'egpt', default: true, handles: ['e'], name: 'E' } },
});

async function bootWith(config, state) {
  const { start, built } = fakeTransport();
  let convState = state;
  const lines = [];
  const app = await boot({
    readConfig: () => config, startBridge: start, makeSession: fakeSession, probeEndpoint: async () => ({ ok: false, status: 0 }),
    loadState: async () => convState, writeState: async (s) => { convState = s; },
    io: memIo(), ingest: false, tickMs: 0, now: () => Date.UTC(2026, 9, 18, 22, 0),
    log: { line: (s) => lines.push(s) },
  });
  const byConnection = Object.fromEntries(built.map((s) => [s.connection, s]));
  return { app, byConnection, lines, state: () => convState };
}
async function waitFor(check, { timeoutMs = 3000, stepMs = 5 } = {}) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { const v = check(); if (v) return v; await new Promise((r) => setTimeout(r, stepMs)); }
  return check();
}
const seed = () => {
  const st = ensureContact(emptyState(), 'whatsapp', ORIGIN, { pushedName: 'Origen' }).state;
  return recordThread(st, 'whatsapp', ORIGIN, 'th-1', '2026-10-18T00:00:00Z', 'egpt');
};
const say = (spy, chatId, body, extra = {}) => spy.onIncoming(body, { chatId, chatName: chatId === ORIGIN ? 'Origen' : 'SI+Origen-x', network: 'whatsapp', userId: '@anrodriguez:beeper.com', senderName: 'An', authorized: true, isSender: true, msgKey: `k-${body}`, ...extra });

describe('a side group\'s mouth room is learned from Rodz\'s copy of the opener, by id', () => {
  it('/join: the primary makes P and posts the opener there; Rodz\'s copy in R makes R the mouth room; replies in P go out in R', async () => {
    const { app, byConnection, state } = await bootWith(KG(), seed());
    await say(byConnection.primary, ORIGIN, '/join x');
    await waitFor(() => state().contacts.whatsapp[P]?.mouth_chat);
    expect(byConnection.primary.created).toEqual([expect.objectContaining({ participantIDs: [RODZ_ID], title: 'SI+Origen-x' })]);
    expect(byConnection.primary.sent.map((m) => shortChatId(m.chatId))).toContain(P);   // the opener, from the creator
    expect(state().contacts.whatsapp[P]).toMatchObject({ aliasOf: ORIGIN, mouth_chat: R });

    await say(byConnection.primary, P, 'e hola', { atEStart: true, atEAnywhere: true, msgKey: 'k-2' });
    await waitFor(() => byConnection.secondary.streams.length || byConnection.secondary.sent.length);
    expect([...byConnection.secondary.streams, ...byConnection.secondary.sent].map((m) => m.chatId)).toEqual([R]);
    expect(byConnection.primary.byTitle ?? 0).toBe(0);
    expect(byConnection.secondary.byTitle ?? 0).toBe(0);
    app.stop();
  });
});
