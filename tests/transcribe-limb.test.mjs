// /transcribe (operator 2026-10-16: "All audio should be worked at dolly, reve is a fallback"). A being
// hands a file in its own folder to THE transcription service (worker first, local cli only when the
// worker fails), the text lands beside the file, and the outcome wakes the being. Live failure
// (2026-10-15): with no such limb, E ran a local whisper on reve for a court recording and starved it.
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseReplyActions, partialProse, createReplyActions } from '../src/spine/reply-actions.mjs';
import { createTranscribeLimb } from '../src/spine/transcribe-limb.mjs';
import { buildTranscriptionPipeline } from '../src/transcription-pipeline.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createSender } from '../src/spine/sender.mjs';
import { limbAction } from '../src/dispatch-line.mjs';

const EV = { chatId: '!court:beeper.local', surface: 'whatsapp', chatName: 'Caso' };
const BRIDGE = { send: async () => ({}), react: async () => true };
const PROFILE = {
  fallback_order: ['worker', 'cli'],
  worker: { type: 'whisper-server-remote', endpoint: 'http://192.0.2.2:23390', token: 'K' },
  cli: { type: 'whisper-cli', model_path: 'm.bin' },
};
const CFG = { node_name: 'kg', transcription_service: { use_config: 'main', main: PROFILE } };
const tick = () => new Promise((r) => setTimeout(r, 0));
const flush = async () => { for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r)); };

function room() {
  const base = mkdtempSync(join(tmpdir(), 'egpt-transcribe-'));
  const conv = join(base, 'conv');
  mkdirSync(join(conv, 'desktop'), { recursive: true });
  writeFileSync(join(conv, 'desktop', 'court.wma'), 'fake-audio-bytes');
  mkdirSync(join(base, 'operator'));
  writeFileSync(join(base, 'operator', 'other.wma'), 'outside');
  return { base, conv };
}

// The REAL fallback chain (src/transcription-pipeline.mjs) over fake engines.
function service({ worker = async () => 'texto del tribunal', cli = async () => 'texto local' } = {}) {
  const calls = [];
  const pipeline = buildTranscriptionPipeline({
    profile: PROFILE,
    transcribeViaEndpoint: async (p, o, log, meta) => { calls.push(['worker', p]); const t = await worker(p); if (meta) meta.durationSec = 552; return t; },
    cli: async (p, eng, log, meta) => { calls.push(['cli', p]); return cli(p); },
  });
  return { calls, transcribe: pipeline.transcribe };
}

function build({ engines, wake = vi.fn(async () => true) } = {}) {
  const { base, conv } = room();
  const svc = service(engines);
  const limb = createTranscribeLimb({ transcribe: svc.transcribe, getConfig: () => CFG });
  const logs = [];
  const ra = createReplyActions({ bridge: BRIDGE, resolveConvDir: async () => conv, limbs: { transcribe: limb.transcribe }, wake, onLog: (m) => logs.push(m) });
  const run = (text, being = 'egpt') => { const p = ra.parse(text, EV); return ra.execute(p.run, p.stripped, EV, { being }); };
  return { run, calls: svc.calls, wake, logs, limb, base, conv };
}
const summaries = (wake) => wake.mock.calls.map((c) => c[0].summaries);

describe('parse', () => {
  it('/transcribe <path> is an action, stripped from the prose', () => {
    const { prose, run, stripped } = parseReplyActions('Lo transcribo.\n/transcribe desktop/court.wma', EV);
    expect(prose).toBe('Lo transcribo.');
    expect(stripped).toEqual([]);
    expect(run).toEqual([{ type: 'transcribe', chatId: EV.chatId, path: 'desktop/court.wma' }]);
  });

  it('a path with spaces, quoted or not, is the whole rest of the line', () => {
    expect(parseReplyActions('/transcribe "desktop/audiencia 3.wma"', EV).run[0].path).toBe('desktop/audiencia 3.wma');
    expect(parseReplyActions('/transcribe desktop/audiencia 3.wma', EV).run[0].path).toBe('desktop/audiencia 3.wma');
  });

  it('an empty or placeholder line is stripped; mid-sentence prose stays prose; a streaming line is withheld', () => {
    for (const line of ['/transcribe', '/transcribe <path>']) {
      const { run, stripped } = parseReplyActions(line, EV);
      expect(run).toEqual([]);
      expect(stripped).toHaveLength(1);
    }
    expect(parseReplyActions('uso /transcribe para el audio', EV).run).toEqual([]);
    expect(partialProse('Listo.\n/transcr', EV)).toBe('Listo.');
  });
});

describe('execute — through the transcription service, outcome back through the wake', () => {
  it('the worker is used first: the text lands beside the file and the being is woken with where and how', async () => {
    const { run, calls, wake, conv } = build();
    const { ran } = await run('/transcribe desktop/court.wma');
    expect(ran).toEqual([{ type: 'transcribe', chatId: EV.chatId, path: 'desktop/court.wma', outcome: 'started' }]);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(calls).toEqual([['worker', join(conv, 'desktop', 'court.wma')]]);
    expect(readFileSync(join(conv, 'desktop', 'court.wma.transcript.txt'), 'utf8')).toBe('texto del tribunal\n');
    expect(wake.mock.calls[0][0]).toEqual({ being: 'egpt', surface: 'whatsapp', chatId: EV.chatId, summaries: ['/transcribe desktop/court.wma → done: desktop/court.wma.transcript.txt (9m12s of audio, via worker)'] });
  });

  it('the local cli runs ONLY when the worker fails', async () => {
    const { run, calls, wake, conv } = build({ engines: { worker: async () => { throw new Error('worker 500: boom'); } } });
    await run('/transcribe desktop/court.wma');
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(calls.map((c) => c[0])).toEqual(['worker', 'cli']);
    expect(readFileSync(join(conv, 'desktop', 'court.wma.transcript.txt'), 'utf8')).toBe('texto local\n');
    expect(summaries(wake)[0][0]).toBe('/transcribe desktop/court.wma → done: desktop/court.wma.transcript.txt (via cli)');
  });

  it('the turn is not held: execute returns while the decode runs, and the job is listed as the being\'s background work', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { run, wake, limb } = build({ engines: { worker: async () => { await gate; return 'ok'; } } });
    await run('/transcribe desktop/court.wma');
    await tick();
    expect(wake).not.toHaveBeenCalled();
    expect(limb.background('egpt', EV)).toEqual([{ description: 'transcribing desktop/court.wma on worker', since: expect.any(Number) }]);
    expect(limb.background('other', EV)).toEqual([]);
    release();
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(limb.background('egpt', EV)).toEqual([]);
  });

  it('when the chain falls back to decoding on this node, the status says so', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const { run, wake, limb } = build({ engines: { worker: async () => { throw new Error('down'); }, cli: async () => { await gate; return 'ok'; } } });
    await run('/transcribe desktop/court.wma');
    await vi.waitFor(() => expect(limb.background('egpt', EV).map((j) => j.description)).toEqual(['transcribing desktop/court.wma on kg']));
    release();
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
  });

  it('a path outside the conversation folder is refused: no decode, the being is woken with the reason', async () => {
    const { run, calls, wake, logs, base, conv } = build();
    symlinkSync(join(base, 'operator'), join(conv, 'link'), 'junction');
    for (const p of ['../operator/other.wma', join(base, 'operator', 'other.wma'), 'link/other.wma']) {
      const { ran } = await run(`/transcribe ${p}`);
      expect(ran).toEqual([]);
    }
    await tick();
    expect(calls).toEqual([]);
    expect(summaries(wake).map((s) => s[0])).toEqual([
      '/transcribe ../operator/other.wma → failed: parent traversal (..)',
      `/transcribe ${join(base, 'operator', 'other.wma')} → failed: absolute path`,
      '/transcribe link/other.wma → failed: leaves the conversation dir through a link',
    ]);
    expect(logs.filter((l) => l.startsWith('transcribe:'))).toHaveLength(3);
  });

  it('a missing file, or no engine producing a transcript, wakes the being with the error and writes nothing', async () => {
    const { run, wake, conv } = build({ engines: { worker: async () => { throw new Error('down'); }, cli: async () => null } });
    await run('/transcribe desktop/nope.wma');
    await run('/transcribe desktop/court.wma');
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(2));
    expect(summaries(wake).map((s) => s[0])).toEqual([
      '/transcribe desktop/nope.wma → failed: not found in the conversation dir',
      '/transcribe desktop/court.wma → failed: no engine produced a transcript',
    ]);
    expect(existsSync(join(conv, 'desktop', 'court.wma.transcript.txt'))).toBe(false);
  });

  it('enabled for every being: no agents.<name>.actions needed', async () => {
    const { run, wake } = build();
    const { ran } = await run('/transcribe desktop/court.wma', 'any-being');
    expect(ran).toHaveLength(1);
    await vi.waitFor(() => expect(wake).toHaveBeenCalledTimes(1));
    expect(wake.mock.calls[0][0].being).toBe('any-being');
  });

  it('the transcript stage-direction records the limb', () => {
    expect(limbAction({ type: 'transcribe', path: 'desktop/court.wma', outcome: 'started' })).toBe('/transcribe desktop/court.wma → started');
  });
});

// ── through the spine: the status shows the job, the result wakes the being, STOP suppresses it ──
const CHAT = 'chat-T@g.us';
function fakeBridge() {
  let cb = null;
  const streams = [];
  return {
    streams,
    onMessage(fn) { cb = fn; }, emit(msg) { return cb(msg); }, stop() {},
    send() { return { ok: true, confirmedId: null }; },
    startStream(chat, init, opts) {
      const h = { chat, init, opts, frames: [], finals: [], confirmedId: `${chat}#${streams.length + 1}`, update(t) { h.frames.push(t); }, async finish(t) { h.finals.push(t); } };
      streams.push(h);
      return h;
    },
  };
}
const mention = (body) => ({ surface: 'whatsapp', node: 'wa', chatId: CHAT, chatName: 'Caso', senderId: 'u', senderName: 'An', msgId: 'm1', ts: Date.now(), body, kind: 'text', raw: {} });

function spineWith({ stop = { present: false } } = {}) {
  const { conv } = room();
  let release;
  const gate = new Promise((r) => { release = r; });
  const svc = service({ worker: async () => { await gate; return 'texto del tribunal'; } });
  const limb = createTranscribeLimb({ transcribe: svc.transcribe, getConfig: () => CFG });
  const bridge = fakeBridge();
  const prompts = [];
  const brain = { async turn(being, ev) { prompts.push(ev.line); return { text: prompts.length === 1 ? 'Lo transcribo.\n/transcribe desktop/court.wma' : 'leído', sessionId: 's1' }; } };
  const notes = [];
  let spine = null;
  const actions = createReplyActions({ bridge, resolveConvDir: async () => conv, limbs: { transcribe: limb.transcribe }, wake: (r) => spine.wakeOnBackground(r), onLog: (m) => notes.push(m) });
  spine = createSpine({
    bridge, brain, actions, limbWork: limb.background,
    identity: { build: (m) => ({ ...m, line: m.body }) },
    router: { resolve: () => ({ being: 'egpt', mention: { atEStart: true, atEAnywhere: true } }) },
    gating: { async decide() { return { mode: 'mention', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: (d) => d.mayReply },
    sender: createSender({ bridge, bodyEmojiOf: () => '🎧', labelOf: () => 'E' }),
    transcript: { async log() {}, logStream() {} },
    heartbeats: { runDue() {} },
    stopSwitch: { present: () => stop.present, pull: async () => {} },
    labelOf: () => 'E',
    turnTimeoutMs: 0,
    log: { line: (s) => notes.push(s) },
  });
  spine.start();
  return { spine, bridge, prompts, notes, conv, release, stop };
}

describe('spine — /transcribe runs in the background and its result wakes the being', () => {
  it('the turn ends at once, a status shows the job, and the result wakes the being as a turn', async () => {
    const s = spineWith();
    await s.bridge.emit(mention('@e transcribe el audio de la audiencia'));
    await flush();
    expect(s.bridge.streams[0].finals).toEqual(['Lo transcribo.']);
    const status = s.bridge.streams[1];
    expect(status.init).toBe('⚙️ working in background: transcribing desktop/court.wma on worker ⏳');
    s.release();
    await vi.waitFor(() => expect(s.prompts).toHaveLength(2));
    expect(s.prompts[1]).toContain('/transcribe desktop/court.wma → done: desktop/court.wma.transcript.txt (9m12s of audio, via worker)');
    await vi.waitFor(() => expect(status.finals).toHaveLength(1));
    expect(status.finals[0]).toMatch(/^✓ background work done: \/transcribe desktop\/court\.wma → done/);
    s.spine.stop();
  });

  it('STOP suppresses the wake; the transcript is still written', async () => {
    const s = spineWith();
    await s.bridge.emit(mention('@e transcribe el audio'));
    await flush();
    s.stop.present = true;
    s.release();
    await vi.waitFor(() => expect(existsSync(join(s.conv, 'desktop', 'court.wma.transcript.txt'))).toBe(true));
    await vi.waitFor(() => expect(s.notes.some((n) => /wake .*STOP file present — not woken/.test(n))).toBe(true));
    expect(s.prompts).toHaveLength(1);
    s.spine.stop();
  });
});
