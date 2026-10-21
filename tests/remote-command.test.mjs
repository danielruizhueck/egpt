// remote-command.test.mjs — no command travels between nodes (operator 2026-10-19: "commands
// (all) are processed by beings only"). Until then a node-addressed command (`/chrome do`,
// `/tabs=do`, dispatch.default_node) said where its node could not hear it rode a MESH ENVELOPE
// and ran there. Now a command names its being (`/e tabs`): that being's node runs it, every
// other node records it; the console (the shell, node-local) keeps its bare commands, locally;
// and a command-shaped prompt arriving in an envelope is ordinary text for the being.
//
// Everything here runs the REAL services (commands + mesh + spine) against a fake bridge and
// a fake brain. No network, no Chrome, no Claude.
import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
// A PRIVATE profile for this file — the SAME fix, for the same reason, as
// tests/rooms-members.test.mjs and tests/list-entity-dirs.test.mjs.
//
// The room-scoped mesh tests below use a REAL Room, so /members writes go through
// Room.setMember → ONE process-global config/rooms.yaml (rooms-file.roomsFilePath). The
// suite's SHARED throwaway profile (tests/setup-egpt-home.mjs) is written CONCURRENTLY by
// tests/lobby.test.mjs, and vitest's `forks` pool puts the two in DIFFERENT PROCESSES — so
// their read-modify-writes lose each other's updates, and whichever file is mid-sequence
// reads back a roster missing the member it just added. Nothing prunes that shared file
// either (179 KB / 6.5k junk rows locally), so the window only ever widened.
//
// egpt-home.mjs freezes EGPT_HOME at module load, so the override must run BEFORE the imports
// below — vi.hoisted is what does that. The beforeAll below is the tripwire + the prune.
const TEST_HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-remote-command-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import { createCommands } from '../src/spine/commands.mjs';
import { fakePipeChrome } from './fake-pipe-chrome.mjs';
import { createMeshService } from '../src/spine/mesh.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { encodeMesh, parseMesh } from '../src/mesh/relay.mjs';
import { Room } from '../src/room-core.mjs';
import { EGPT_HOME } from '../src/egpt-home.mjs';


// Tripwire + prune: never the live profile, never the shared one, and never an accumulation
// of its own. Fails loudly rather than racing again.
beforeAll(() => {
  expect(join(EGPT_HOME)).toBe(join(TEST_HOME));
  expect(EGPT_HOME).not.toBe(join(homedir(), '.egpt'));
  expect(EGPT_HOME).not.toBe(join(homedir(), '.egpt-test-home'));
  rmSync(TEST_HOME, { recursive: true, force: true });
});

const flush = async () => { await new Promise((r) => setTimeout(r, 0)); await new Promise((r) => setTimeout(r, 0)); };
// Real fs I/O (the room-scoped mesh tests below use a REAL Room, config.yaml and all) takes a
// few more event-loop turns than the in-memory fakes elsewhere in this file — drain generously.
const drain = async () => { for (let i = 0; i < 10; i++) await flush(); };

// kg's REAL agent shape (REVE's live config, read 2026-07-26): `don` is the relay to node `do`,
// SURFACE-PINNED to the shell because on Beeper `do` hears the operator directly; `carol` is an
// UNPINNED multipath relay that also names do. Both are the routing table now — there is no
// mesh.nodes (evicted 2026-07-25, "we do agent-base routing").
const KG = () => ({
  node_name: 'kg',
  peer_nodes: ['kg', 'do'],
  networks: { whatsapp: { chat_ids: ['!self'] } },
  agents: {
    egpt: { configuration: 'claude', handles: ['e'], default: true },
    carol: { handles: ['carol'], paths: [{ path1: { relay_channel: 'rodz1', network: 'whatsapp', to: 'don.do' } }] },
    don: { surface: 'shell', to: 'don.do', relay_channel: 'egpt-mesh-do-kg' },
  },
});

// do's side: `don` is a LOCAL being here (that is what `to: don.do` points at).
const DO = () => ({
  node_name: 'do',
  peer_nodes: ['kg', 'do'],
  networks: { whatsapp: { chat_ids: ['!do-self'] } },
  agents: {
    egpt: { configuration: 'claude', handles: ['e'], default: true },
    don: { configuration: 'claude' },
  },
});

function fakeBridge() {
  const b = {
    sent: [], statusPosts: [], streams: [],
    async resolveChatId(nameOrId) { return nameOrId; },
    send(chat, text) { b.sent.push({ chat, text }); return { ok: true }; },
    async postStatus(chat, text) { const id = `post-${b.statusPosts.length + 1}`; b.statusPosts.push({ chat, text, id }); return id; },
    startStream(chat, init, opts = {}) {
      const h = { chat, init, opts, updates: [], finals: [], delivered: false, lastError: null };
      h.update = (t) => h.updates.push(t);
      h.finish = async (t) => { h.finals.push(t); h.delivered = true; };
      h.delete = async () => {};
      h.fail = () => {};
      b.streams.push(h);
      return h;
    },
    onMessage() {}, stop() {},
  };
  return b;
}

const LIVE_CDP = {
  isRunning: async () => true,
  listTabs: async () => [{ id: 't1', title: 'Claude', url: 'https://claude.ai/' }],
  cdpHost: async () => '127.0.0.1:9221',
  openTab: async () => 't2',
  activateTarget: async () => {},
  closeTab: async () => {},
};

// One node's full stack: real commands + real mesh + real spine over fakes.
// resolveConvRoom/loadAdapters are optional passthroughs (undefined = createCommands' own
// defaults, unchanged) — the room-scoped mesh tests below inject a real one.
function nodeStack({ config, cdp = LIVE_CDP, resolveConvRoom, loadAdapters } = {}) {
  const bridge = fakeBridge();
  const exits = [];
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, ev }); return { text: 'the being answers' }; } };
  let t = 0;
  const commands = createCommands({
    getConfig: () => config,
    send: (chatId, text) => bridge.send(chatId, text),
    exit: (code) => exits.push(code),
    chromeHost: fakePipeChrome(cdp).chromeHost,   // the node's group Chrome, answering like `cdp`
    profileHolder: () => null,
    now: () => t,
    sleep: async (ms) => { t += ms; },
    resolveConvRoom,
    loadAdapters,
  });
  const mesh = createMeshService({ bridge, brain, getConfig: () => config, setTimer: () => null, clearTimer: () => {} });
  const transcript = { entries: [], async log(ev) { this.entries.push(ev); } };
  const spine = createSpine({
    bridge, brain, commands, mesh,
    identity: { build: (m) => ({ ...m }) },
    router: { resolve: () => ({ being: 'e', mention: {} }) },
    gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
    sender: { open: () => ({ update() {}, fail() {}, async finish() {} }) },
    transcript, heartbeats: { runDue() {} },
    clock: { now: () => 1 },
  });
  return { bridge, brain, commands, mesh, spine, exits, transcript };
}

const envelopes = (bridge) => bridge.sent.filter((s) => parseMesh(s.text) != null);
const plain = (bridge) => bridge.sent.filter((s) => parseMesh(s.text) == null);

// The console's InboundEvent as identity.build actually stamps it since 2026-08-28: the shell
// is a TRANSPORT (node tag 'sh', network 'shell') onto surface `room`, seat `lobby`. The
// operator's `don: surface: shell` pin still routes here — it names a network, and both the
// router and agentRoutes resolve it through the SAME network->surface map identity used.
const SHELL = { surface: 'room', node: 'sh', chatId: 'lobby', chatName: 'shell', senderId: 'operator', senderName: 'operator', msgId: null, ts: 1, kind: 'text', authorized: true, raw: {} };
const FAM = { surface: 'whatsapp', node: 'wa', chatId: '!fam', chatName: 'fam', senderId: 'u-an', senderName: 'An', msgId: 'm1', ts: 1, kind: 'text', authorized: true, isSender: true, raw: {} };

// ── 1. THE CONSOLE: a bare command runs HERE, and nothing travels ──────────────────────────
describe('the shell console keeps its bare commands, locally — nothing becomes an envelope', () => {
  it('bare /status on the shell is answered by this node', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/status' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)).toHaveLength(1);
    expect(plain(bridge)[0]).toMatchObject({ chat: 'lobby' });
    expect(plain(bridge)[0].text).toContain('node_name: kg');
  });

  it('/chrome on the shell reports THIS node\'s browser', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/chrome' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toContain('attached: the "brain" browser');
  });

  it('a node name after /chrome addresses nothing: no envelope, no "no route" error — this node reports', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    for (const body of ['/chrome do', '/chrome mo']) await spine.handleInbound({ ...SHELL, body });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(bridge.statusPosts).toHaveLength(0);
    expect(plain(bridge).map((s) => s.text)).toEqual([expect.stringContaining('attached: the "brain" browser'), expect.stringContaining('attached: the "brain" browser')]);
  });

  it('the =<node> suffix is gone: /tabs=do /status=do /members=do on the shell travel nowhere and run nothing', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    for (const body of ['/tabs=do', '/status=do', '/members=do', '/open=do https://x.com', '/tab=do 1', '/close=do 1']) {
      await spine.handleInbound({ ...SHELL, body });
    }
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(bridge.statusPosts).toHaveLength(0);
    for (const s of plain(bridge)) expect(s.text).not.toMatch(/tabs: 1|node_name|opened:|no members/);   // none of them ran
  });

  it('a retired dispatch.default_node is inert: bare /tabs on the shell stays local', async () => {
    const config = { ...KG(), dispatch: { default_node: 'do' } };
    const { bridge, spine } = nodeStack({ config });
    for (const body of ['/tabs', '/open https://example.com', '/members add tab 3 cgpt']) await spine.handleInbound({ ...SHELL, body });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toContain('tabs: 1');
    expect(plain(bridge)[1].text).toContain('opened: https://example.com');
  });

  it('a query string is NEVER read as a node — /open https://x.com/?a=b stays local', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/open https://x.com/?a=b' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)[0].text).toContain('opened: https://x.com/?a=b');
  });
});

// ── 2. A SHARED BEEPER CHAT: the handle picks the node ─────────────────────────────────────
describe('in a shared Beeper chat a command names its being, and only that being\'s node runs it', () => {
  it('/e status is answered by kg (E is kg\'s)', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/e status' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)).toHaveLength(1);
    expect(plain(bridge)[0].text).toContain('node_name: kg');
  });

  it('/e members is answered by kg', async () => {
    const { bridge, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/e members' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(plain(bridge)).toHaveLength(1);
  });

  it('a handle kg has no being for (/d status, /don tabs, /carol chrome): recorded, silent, nothing travels', async () => {
    const { bridge, brain, spine, transcript } = nodeStack({ config: KG() });
    for (const body of ['/d status', '/don tabs', '/carol chrome']) await spine.handleInbound({ ...FAM, body });
    await flush();
    expect(bridge.sent).toHaveLength(0);
    expect(bridge.statusPosts).toHaveLength(0);
    expect(brain.calls).toHaveLength(0);
    expect(transcript.entries.map((e) => e.body)).toEqual(['/d status', '/don tabs', '/carol chrome']);
  });

  it('a bare /status in a chat is no command: the node answers nothing, the being gets the text', async () => {
    const { bridge, brain, spine } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...FAM, body: '/status' });
    await flush();
    expect(bridge.sent).toHaveLength(0);
    expect(brain.calls).toHaveLength(1);
  });
});

// ── 3. THE LOCK: lifecycle + the safe word are NOT remotely invocable ──────────────────────
describe('lock — lifecycle and STOP never travel', () => {
  it('/restart do on the shell forwards NOTHING (it is not node-addressable)', async () => {
    const { bridge, spine, exits } = nodeStack({ config: KG() });
    await spine.handleInbound({ ...SHELL, body: '/restart do' });
    await flush();
    expect(envelopes(bridge)).toHaveLength(0);
    expect(exits).toEqual([43]);        // local lifecycle, exactly as before
  });

  for (const line of ['/upgrade do', '/rewind do']) {
    it(`${line} forwards NOTHING`, async () => {
      const { bridge, spine } = nodeStack({ config: KG() });
      await spine.handleInbound({ ...SHELL, body: line });
      await flush();
      expect(envelopes(bridge)).toHaveLength(0);
    });
  }
});

describe('lock — the STOP safe word cannot be pulled from another machine', () => {
  it('an envelope carrying "stop" does NOT take the responder down', async () => {
    // Three independent reasons, all pre-existing and all preserved: the safe word is not a
    // command (no envelope prompt executes as one on the responder); the envelope BODY the
    // safe-word check sees is the encoded wire text, not
    // "stop"; and relay traffic is never a human turn, nor said in the Self chat.
    const pulls = [];
    const bridge = fakeBridge();
    const brain = { calls: [], async turn() { this.calls.push(1); return { text: 'ok' }; } };
    const config = DO();
    const commands = createCommands({ getConfig: () => config, send: (c, t) => bridge.send(c, t), exit: () => {} });
    const mesh = createMeshService({ bridge, brain, getConfig: () => config, setTimer: () => null, clearTimer: () => {} });
    const spine = createSpine({
      bridge, brain, commands, mesh,
      identity: { build: (m) => ({ ...m }) },
      router: { resolve: () => ({ being: 'e', mention: {} }) },
      gating: { async decide() { return { mode: 'on', receives: true, mayReply: true, sendToEgpt: 'mode' }; }, surfaces: () => true },
      sender: { open: () => ({ update() {}, fail() {}, async finish() {} }) },
      transcript: { async log() {} }, heartbeats: { runDue() {} },
      stopSwitch: { present: () => false, async pull(why) { pulls.push(why); } },
      isSelfChat: () => true,          // even in the most permissive case
      clock: { now: () => 1 },
    });
    await spine.handleInbound({
      surface: 'whatsapp', node: 'wa', chatId: 'egpt-mesh-do-kg', chatName: 'mesh', senderId: 'u-an', senderName: 'An',
      msgId: 's1', ts: 4, kind: 'text', raw: {}, authorized: true, isSender: true,
      body: encodeMesh({ by: 'An', body: 'stop', from: 'shell', from_node: 'kg', to: 'don.do', post_id: 'post-1' }),
    });
    await flush();
    expect(pulls).toEqual([]);
    expect(brain.calls).toHaveLength(1);   // ordinary relayed text
  });
});

// ── 4. THE RESPONDER: an envelope's command-shaped prompt is text for the being ────────────
describe('responder — an arriving envelope carrying a command-shaped prompt', () => {
  const request = (body, extra = {}) => ({
    surface: 'whatsapp', node: 'wa', chatId: 'egpt-mesh-do-kg', chatName: 'mesh',
    senderId: 'u-an', senderName: 'An', msgId: 'q1', ts: 3, kind: 'text', raw: {},
    authorized: true, isSender: true, ...extra,
    body: encodeMesh({ by: 'An', body, from: 'shell', from_node: 'kg', to: 'don.do', post_id: 'post-1' }),
  });

  for (const prompt of ['/chrome do', '/tabs=do', '/members=do add tab 1 c1', '/don tabs']) {
    it(`"${prompt}" runs no command here: the being gets it and its reply streams home`, async () => {
      const { brain, spine, bridge } = nodeStack({ config: DO() });
      await spine.handleInbound(request(prompt));
      await flush();
      expect(brain.calls).toHaveLength(1);
      expect(brain.calls[0].ev.body).toBe(prompt);
      const relayStream = bridge.streams.filter((s) => s.chat === 'egpt-mesh-do-kg');
      expect(relayStream).toHaveLength(1);                       // the being path opens the placeholder
      expect(parseMesh(relayStream[0].finals.at(-1)).body).toContain('the being answers');
    });
  }

  it('/restart can never arrive — the node does not restart', async () => {
    const { brain, spine, exits } = nodeStack({ config: DO() });
    await spine.handleInbound(request('/restart do'));
    await flush();
    expect(exits).toEqual([]);                                 // the node did NOT restart
    expect(brain.calls).toHaveLength(1);                       // ordinary relayed text, as today
  });
});

// ── 5. A room-scoped command resolves to THE CHAT'S OWN ROOM ────────────────────────────────
class TmpRoom extends Room {
  constructor(dir, slug) { super(); this._dir = dir; this.slug = slug; }
  baseDir() { return this._dir; }
}
const ADAPTERS = [{ name: 'chatgpt-cdp', urlMatch: /chatgpt\.com|chat\.openai\.com/, homeUrl: 'https://chatgpt.com/' }];
const oneTab = [{ id: 'GPT1', title: 'ChatGPT', url: 'https://chatgpt.com/c/abc' }];

describe("a room-scoped command resolves to the chat's own room", () => {
  let base;
  beforeEach(() => { base = mkdtempSync(join(tmpdir(), 'egpt-mesh-room-')); });
  afterEach(() => { rmSync(base, { recursive: true, force: true }); });

  // A resolveConvRoom keyed EXACTLY on the (surface, chatId) pair it's called with; records every call.
  function keyedResolveConvRoom() {
    const rooms = new Map();
    const calls = [];
    const resolve = async (surface, chatId) => {
      calls.push([surface, chatId]);
      const key = `${surface}:${chatId}`;
      if (!rooms.has(key)) rooms.set(key, new TmpRoom(join(base, 'conv', surface, String(chatId)), String(chatId)));
      return rooms.get(key);
    };
    return { resolve, calls };
  }

  it('a command that arrives on a REAL Beeper chat resolves to THAT chat\'s own room, unchanged', async () => {
    const { resolve, calls } = keyedResolveConvRoom();
    const commands = createCommands({
      getConfig: () => DO(),
      send: () => {},
      chromeHost: fakePipeChrome({ listTabs: async () => oneTab }).chromeHost, profileHolder: () => null,
      loadAdapters: async () => ADAPTERS,
      resolveConvRoom: resolve,
    });
    await commands.run({ chatId: '!fam-chat', surface: 'whatsapp', body: '/members add tab 1 c1', authorized: true });
    await commands.run({ chatId: '!fam-chat', surface: 'whatsapp', body: '/members', authorized: true });
    expect(calls).toEqual([['whatsapp', '!fam-chat'], ['whatsapp', '!fam-chat']]);
  });
});
