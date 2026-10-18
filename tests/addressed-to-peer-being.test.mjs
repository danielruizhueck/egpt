// addressed-to-peer-being.test.mjs — a line addressed to a being on ANOTHER node wakes nobody here
// (live 2026-10-18 14:00, eGPT Admin: "don you there?" woke kg's E in mode on; don lives on do).
// kg names do's beings with a route-less relay (configuration: relay, handles only, no
// relay_channel): the line is recorded, nothing is forwarded, no local being runs, in any mode.
// Real spine + identity + router + gating, as in clean-ingest.test.mjs.
import { describe, it, expect } from 'vitest';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';

const agentsWith = (peer = {}) => ({
  egpt: { default: true, handles: ['e', 'egpt'] },
  ken: { handles: ['k', 'ken'] },
  'do-beings': { configuration: 'relay', handles: ['d', 'don', 'den'], ...peer },
});

function buildSpine({ mode = 'on', peer = {} } = {}) {
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, body: ev.body }); return { text: 'x' }; } };
  const logs = [];
  const router = createRouter({ getAgents: () => agentsWith(peer), defaultBeing: 'egpt', onLog: (m) => logs.push(m) });
  const gating = createGating({ getConfig: () => ({ agents: agentsWith(peer), dispatch: { auto_default_mode: mode } }), loadState: null, defaultKey: 'egpt' });
  const transcript = { logged: [], async log(ev) { this.logged.push(ev); } };
  const sender = { opened: 0, open() { this.opened++; return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const mesh = { forwarded: [], isEnvelope: () => false, async handle() {}, async forward(ev, t) { this.forwarded.push(t); return true; } };
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
    brain, identity: createIdentity({ now: () => 1000 }), router, gating, sender, transcript,
    heartbeats: { runDue() {} }, mesh, fromThisNode: () => false, isSelfChat: () => false,
    clock: { now: () => 1000 }, defaultBeing: 'egpt',
  });
  return { spine, brain, transcript, sender, mesh, logs };
}

const from = (over = {}) => ({ chatId: 'admin', chatName: 'eGPT Admin', network: 'whatsapp', userId: 'op', senderName: 'An', msgKey: 'm1', isSender: true, authorized: true, ...over });
const say = (s, body, over = {}) => s.spine.handleInbound({ body, from: from(over) });
const woke = (s) => s.brain.calls.map((c) => c.being);

describe('a line addressed to a being on another node', () => {
  it('LIVE: "don you there?" with E on is recorded, forwards nothing, wakes nobody', async () => {
    const s = buildSpine({ mode: 'on' });
    await say(s, 'don you there?');
    expect(woke(s)).toEqual([]);
    expect(s.sender.opened).toBe(0);
    expect(s.mesh.forwarded).toEqual([]);
    expect(s.transcript.logged.at(-1)?.body).toBe('don you there?');
    expect(s.logs.some((l) => /"don".*another node/.test(l))).toBe(true);
  });

  it('every peer handle form: bare at the start, @ anywhere, @being.node', async () => {
    for (const [i, body] of ['d hola', 'mira esto @den', '@don.do hola'].entries()) {
      const s = buildSpine({ mode: 'on' });
      await say(s, body, { msgKey: `p${i}` });
      expect(woke(s), body).toEqual([]);
      expect(s.mesh.forwarded, body).toEqual([]);
      expect(s.transcript.logged.at(-1)?.body, body).toBe(body);
    }
  });

  it("the declaration's own mode does not matter: a resting (off) one is still recorded", async () => {
    const s = buildSpine({ mode: 'on', peer: { mode: 'off' } });
    await say(s, 'don you there?');
    expect(woke(s)).toEqual([]);
    expect(s.transcript.logged.at(-1)?.body).toBe('don you there?');
  });

  it('"e hola" wakes E (on)', async () => {
    const s = buildSpine({ mode: 'on' });
    await say(s, 'e hola', { atEStart: true, atEAnywhere: true });
    expect(woke(s)).toEqual(['egpt']);
  });

  it('an unaddressed line wakes E (on), and a bare peer handle mid-sentence is not an address', async () => {
    for (const [i, body] of ['hola a todos', 'hola don, qué tal'].entries()) {
      const s = buildSpine({ mode: 'on' });
      await say(s, body, { msgKey: `u${i}` });
      expect(woke(s), body).toEqual(['egpt']);
    }
  });

  it('a local mention still works, also beside a peer handle', async () => {
    const s1 = buildSpine({ mode: 'on' });
    await say(s1, 'k hola');
    expect(woke(s1)).toEqual(['ken']);
    const s2 = buildSpine({ mode: 'on' });
    await say(s2, '@don y @e, hola', { atEAnywhere: true });
    expect(woke(s2)).toEqual(['egpt']);
    expect(s2.mesh.forwarded).toEqual([]);
  });

  it('mention mode is unchanged', async () => {
    const cases = [['don hola', {}, []], ['e hola', { atEStart: true, atEAnywhere: true }, ['egpt']], ['hola', {}, []], ['k hola', {}, ['ken']]];
    for (const [i, [body, over, want]] of cases.entries()) {
      const s = buildSpine({ mode: 'mention' });
      await say(s, body, { msgKey: `n${i}`, ...over });
      expect(woke(s), body).toEqual(want);
      expect(s.transcript.logged.at(-1)?.body, body).toBe(body);
    }
  });

  it("an 'off' conversation still records nothing", async () => {
    const s = buildSpine({ mode: 'off' });
    await say(s, 'don you there?');
    expect(woke(s)).toEqual([]);
    expect(s.transcript.logged).toEqual([]);
  });
});

describe('router: a route-less relay is a peer being', () => {
  it('resolves to the persona fall-through, denied (recorded, no turn)', async () => {
    const router = createRouter({ getAgents: () => agentsWith(), defaultBeing: 'egpt' });
    const r = await router.resolve({ body: 'don you there?', surface: 'whatsapp', chatId: 'admin' });
    expect(r.targets).toEqual([expect.objectContaining({ being: 'egpt', fallthrough: true, denied: true })]);
    expect(r.mesh).toBeUndefined();
  });

  it('a relay WITH a route still forwards', async () => {
    const router = createRouter({ getAgents: () => agentsWith({ relay_channel: 'egpt-mesh-do-kg', to: 'don.do' }), defaultBeing: 'egpt' });
    const r = await router.resolve({ body: 'don hola', surface: 'whatsapp', chatId: 'admin' });
    expect(r.mesh).toMatchObject({ being: 'do-beings', route: { room_id: 'egpt-mesh-do-kg' } });
  });
});
