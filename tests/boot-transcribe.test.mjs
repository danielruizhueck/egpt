// boot-transcribe.test.mjs — /transcribe wired end to end through boot (2026-10-16): the being's reply
// carries the verb, boot's limb sends the file through THE transcription service to the worker rung
// (a fake worker over HTTP here), the text lands beside the file, a status shows the job meanwhile,
// and the outcome returns to the being as a wake turn in the same chat.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';

const _PRIVATE_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-boot-transcribe-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { promises as fs, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, join } from 'node:path';

let boot, emptyState, ensureContact, slugDir;
beforeAll(async () => {
  ({ boot } = await import('../src/spine/boot.mjs'));
  ({ emptyState, ensureContact, slugDir } = await import('../src/conversations-state.mjs'));
});
afterAll(async () => {
  delete process.env.EGPT_HOME;
  try { await fs.rm(_PRIVATE_HOME, { recursive: true, force: true }); } catch {}
});

const CHAT = '!court:beeper.com';

// The worker's two routes, as src/tools/transcriptor.mjs serves them; it answers once released.
async function fakeWorker() {
  let release;
  const gate = new Promise((r) => { release = r; });
  const posts = [];
  const server = createServer((req, res) => {
    const json = (code, o) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (req.method === 'POST' && req.url === '/v1/transcribe') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', async () => { posts.push(Buffer.concat(chunks).toString()); await gate; json(200, { ok: true, transcript: 'se abre la audiencia', durationSec: 552, ms: 7 }); });
      return;
    }
    if (req.url.startsWith('/v1/transcript/')) return json(404, { ok: false, error: 'unknown' });
    json(200, { ok: true });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, posts, release, close: () => server.close() };
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

function fakeTransport() {
  const built = [];
  const start = async (opts) => {
    const spy = { opts, onIncoming: opts.onIncoming, streams: [] };
    built.push(spy);
    return {
      async send() { return { ok: true }; },
      startStreamMessage(init, o) {
        const h = { init, finals: [], chatId: o?.chatId, update() {}, async finish(t) { this.finals.push(t); } };
        spy.streams.push(h); return h;
      },
      isAlive: () => true, stop() {},
    };
  };
  return { start, built };
}

describe('boot — /transcribe goes to the worker and wakes the being with the result', () => {
  it('the file reaches the worker rung, the text lands beside it, and the outcome returns as a wake turn', async () => {
    const worker = await fakeWorker();
    const { start, built } = fakeTransport();
    const io = memIo();
    const prompts = [];
    const ens = ensureContact(emptyState(), 'whatsapp', CHAT, { pushedName: 'Caso', slugHint: 'caso' });
    const entry = ens.state.contacts.whatsapp[CHAT];
    entry.agents = { ...(entry.agents ?? {}), egpt: { ...(entry.agents?.egpt ?? {}), mode: 'on' } };
    let convState = ens.state;
    const conv = slugDir('whatsapp', entry.slug);
    mkdirSync(join(conv, 'desktop'), { recursive: true });
    writeFileSync(join(conv, 'desktop', 'court.wma'), 'fake-wma-bytes');

    const app = await boot({
      readConfig: () => ({
        node_name: 'kg',
        user_name: 'John',
        beeper: { use: 'main', main: { account: 'you@example.com', token: 'TOK' } },
        agents: { egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true } },
        transcription_service: { use_config: 'main', main: { fallback_order: ['worker'], worker: { type: 'whisper-server-remote', endpoint: worker.url, token: Buffer.from('k').toString('base64') } } },
      }),
      startBridge: start,
      makeSession: (opts) => ({
        opts, sessionId: 'sess-1',
        async turn(m, onUpdate) {
          prompts.push(m);
          const text = prompts.length === 1 ? 'Lo transcribo.\n/transcribe desktop/court.wma' : `↩ ${m}`;
          onUpdate?.(text);
          return { text, sessionId: this.sessionId };
        },
        close() {},
      }),
      probeEndpoint: async () => ({ ok: false, status: 0 }),
      loadState: async () => convState,
      writeState: async (s) => { convState = s; },
      io, ingest: false, tickMs: 0,
      log: { line: () => {} },
    });
    try {
      const spy = built[0];
      await spy.onIncoming('transcribe la audiencia', { chatId: CHAT, chatName: 'Caso', network: 'whatsapp', userId: 'u-1', senderName: 'An', authorized: true, msgKey: 'm1' });
      expect(spy.streams[0].finals[0]).toContain('Lo transcribo.');
      expect(spy.streams[0].finals[0]).not.toContain('/transcribe');
      await vi.waitFor(() => expect(worker.posts).toEqual(['fake-wma-bytes']));
      await vi.waitFor(() => expect(spy.streams.some((s) => /transcribing desktop\/court\.wma on worker/.test(s.init))).toBe(true));
      expect(prompts).toHaveLength(1);

      worker.release();
      await vi.waitFor(() => expect(prompts).toHaveLength(2), { timeout: 5000 });
      expect(prompts[1]).toContain('A background task you started has finished: /transcribe desktop/court.wma → done: desktop/court.wma.transcript.txt (9m12s of audio, via worker).');
      expect(readFileSync(join(conv, 'desktop', 'court.wma.transcript.txt'), 'utf8')).toBe('se abre la audiencia\n');
      const transcript = [...io.files.entries()].find(([p]) => p.endsWith('transcript.md'))?.[1] ?? '';
      expect(transcript).toContain('/transcribe desktop/court.wma → started');
    } finally {
      worker.close();
      app.stop();
    }
  });
});
