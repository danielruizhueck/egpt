// boot-background-resume.test.mjs — a voice note the last spine left being transcribed, resumed
// through the real boot (src/spine/background.mjs): its audio saved into the chat's media/ by the
// same onMedia handler a live outcome reaches, its outcome dispatched like a fresh transcription,
// and the stale 🎧 taken off through the one placement (makeOutbound `react`, port `unreact`).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-boot-bg-resume-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

let boot, emptyState, ensureContact;
beforeAll(async () => {
  mkdirSync(_PRIVATE_HOME, { recursive: true });
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const CHAT = '!room:beeper.com';
const CONFIG = () => ({
  node_name: 'kg',
  user_name: 'John',
  beeper: { use: 'main', main: { account: 'you@example.com', token: 'TOK' } },
  agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } },
});

function memIo() {
  const files = new Map();
  const dirs = new Set();
  const copies = [];
  const missing = (path) => Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
  return {
    files, copies,
    appendFile: async (path, data) => files.set(path, `${files.get(path) ?? ''}${data}`),
    writeFile: async (path, data) => files.set(path, String(data)),
    readFile: async (path) => { if (!files.has(path)) throw missing(path); return files.get(path); },
    mkdir: async (path) => { dirs.add(path); },
    existsSync: (path) => files.has(path) || dirs.has(path),
    readdir: async (path) => [...files.keys()].filter((f) => dirname(f) === path).map((f) => f.slice(path.length + 1)),
    rename: async (from, to) => { if (!files.has(from)) throw missing(from); files.set(to, files.get(from)); files.delete(from); },
    copyFile: async (from, to) => { copies.push([from, to]); files.set(to, 'audio'); },
  };
}

function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { opts, onIncoming: opts.onIncoming, streams: [], removed: [] };
    built.push(spy);
    return {
      async send() { return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { init, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      async removeReaction(chat, msgId, emoji) { spy.removed.push([chat, msgId, emoji]); return true; },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

function seedOn() {
  const ens = ensureContact(emptyState(), 'whatsapp', CHAT, { pushedName: 'fam', slugHint: 'fam' });
  const entry = ens.state.contacts.whatsapp[CHAT];
  entry.agents = { ...(entry.agents ?? {}), egpt: { ...(entry.agents?.egpt ?? {}), mode: 'on' } };
  return ens.state;
}

describe('boot — a voice note pending across the restart', () => {
  it('REPRODUCE: audio saved into media/, outcome dispatched, the stale 🎧 taken off', async () => {
    const dir = join(_PRIVATE_HOME, 'case-1');
    mkdirSync(join(dir, 'state'), { recursive: true });
    const audio = join(dir, 'note.ogg');
    writeFileSync(audio, 'OggS');
    const ts = Date.UTC(2026, 9, 18, 14, 0);
    const from = { chatId: CHAT, chatName: 'fam', chatType: 'private', network: 'whatsapp', userId: 'u-1', username: 'An', firstName: 'An', senderName: 'An', isSender: false, authorized: true, atEStart: false, atEAnywhere: false, backlog: false, replyToBot: false, replyToId: null, replyToBeing: null, isReaction: false, isTranscriptFromVoice: false, voiceLine: 'arrival', msgKey: 'v1', msgHash: null, msgTs: ts };
    const media = { chatID: CHAT, chatName: 'fam', chatType: 'private', network: 'whatsapp', msgId: 'v1', senderName: 'An', isSender: false, ts, kind: 'audio', mime: 'audio/ogg', fileName: null, localPath: audio, caption: null, isVoiceNote: true };
    const backgroundFile = join(dir, 'state', 'background.json');
    writeFileSync(backgroundFile, JSON.stringify({
      transcriptions: [{ surface: 'whatsapp', chatId: CHAT, chatName: 'fam', msgId: 'v1', sender: 'An', file: audio, arrivedAt: new Date(ts).toISOString(), node: 'kg', media, from }],
      agents: [],
    }));
    const { start, built } = fakeTransport();
    const sessions = [];
    let convState = seedOn();
    const io = memIo();
    const app = await boot({
      readConfig: CONFIG,
      startBridge: start,
      makeSession: (opts) => {
        const s = { opts, sessionId: 'sess-1', prompts: [], async turn(m) { this.prompts.push(m); return { text: 'oído', sessionId: this.sessionId }; }, close() {} };
        sessions.push(s);
        return s;
      },
      probeEndpoint: async () => ({ ok: false, status: 0 }),
      loadState: async () => convState,
      writeState: async (s) => { convState = s; },
      io, ingest: false, tickMs: 0, backgroundFile,
      now: () => Date.UTC(2026, 9, 18, 14, 5),
      log: { line: () => {} },
    });
    const spy = built[0];
    // no transcription_service in this config: the resumed decode yields nothing — a live failure's outcome
    await vi.waitFor(() => expect(sessions[0]?.prompts?.length).toBe(1), { timeout: 5000 });
    expect(sessions[0].prompts[0]).toContain('[re #v1] (voice note not transcribed: no transcript)');
    expect(io.copies).toEqual([[audio, expect.stringMatching(/media[\\/][^\\/]*-an-audio-v1\.ogg$/)]]);
    const index = [...io.files.entries()].find(([p]) => /media[\\/]index\.md$/.test(p))?.[1] ?? '';
    expect(index).toContain('· An · audio · [');
    await vi.waitFor(() => expect(spy.removed).toEqual([[CHAT, 'v1', '🎧']]), { timeout: 5000 });
    await vi.waitFor(() => expect(JSON.parse(readFileSync(backgroundFile, 'utf8')).transcriptions).toEqual([]), { timeout: 5000 });
    app.stop();
  });
});
