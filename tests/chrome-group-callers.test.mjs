// tests/chrome-group-callers.test.mjs — every SPINE-side browser caller drives ITS chat's browser-group
// Chrome (plans/2610091931 rev 2026-10-11, chunk 2). One resolver: commands.browserConversationOf
// (registry row → chromeConversationOf against browsers.yaml). brain → today's :9221 port client;
// unlisted → the `shared` pipe Chrome; ambiguous → no browser + one log line; conversation-less → brain.
// NO REAL CHROME: the brain port client is a fake, the pipe Chrome a fake child over two PassThroughs.
import { describe, it, expect } from 'vitest';
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';
import { join, dirname } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createCommands, CHROME_BRAIN_PROFILE, loginProfilePathOf } from '../src/spine/commands.mjs';
import { createRoomRelay } from '../src/spine/room-relay.mjs';

const MB = 1024 * 1024;
const REPO = join(dirname(fileURLToPath(import.meta.url)), '..');

function fakePipeSpawner() {
  const calls = [];
  const spawnChromePipe = async (opts) => {
    calls.push(opts);
    const toChrome = new PassThrough();
    const toClient = new PassThrough();
    let buf = Buffer.alloc(0);
    toChrome.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(0)) !== -1) {
        const frame = buf.subarray(0, i);
        buf = buf.subarray(i + 1);
        if (!frame.length) continue;
        const msg = JSON.parse(frame.toString('utf8'));
        const result = msg.method === 'Target.getTargets' ? { targetInfos: [{ targetId: 'P1', type: 'page', url: 'https://pipe.example/', title: 'PipeTab' }] } : {};
        toClient.write(JSON.stringify({ id: msg.id, result }) + '\0');
      }
    });
    const child = new EventEmitter();
    child.exitCode = null; child.killed = false; child.kill = () => {};
    return { child, writable: toChrome, readable: toClient, pid: 5000 + calls.length };
  };
  return { spawnChromePipe, calls };
}

const STATE = {
  contacts: {
    whatsapp: {
      '!admin': { slug: 'eGPT Admin-2609121344', conversation_path: '.egpt/conversations/whatsapp/eGPT Admin-2609121344' },
      '!reinie': { slug: 'Reinie Alvino-2607150057', conversation_path: '.egpt/conversations/whatsapp/Reinie Alvino-2607150057' },
      '!dup': { slug: 'Twice-2601010000', conversation_path: '.egpt/conversations/whatsapp/Twice-2601010000' },
    },
    room: { acim: { conversation_path: '.egpt/rooms/acim' } },
  },
};
const GROUPS = { brain: ['eGPT Admin', 'eGPT Rodz Lulu An', 'acim', 'tpoef'], work: ['Twice'] , other: ['Twice'] };

function build({ state = STATE, groups = GROUPS, requestLogin } = {}) {
  const { spawnChromePipe, calls } = fakePipeSpawner();
  const logs = [], sent = [], launches = [], brainActs = [], brainCloses = [];
  const brainCdp = {
    isRunning: async () => true,
    cdpHost: async () => 'localhost:9221',
    listTabs: async () => [{ id: 'B1', title: 'Gmail', url: 'https://mail.google.com/' }],
    openTab: async () => 'B2',
    activateTarget: async (id) => { brainActs.push(id); },
    closeTab: async (id) => { brainCloses.push(id); },
  };
  let t = 0;
  const cmds = createCommands({
    getConfig: () => ({ node_name: 'kg', agents: { e: {} }, whatsapp: { chat_id: '!admin' } }),
    cdp: brainCdp,
    launchChrome: (o) => { launches.push(o); return { ok: false }; },
    spawnChromePipe,
    freeMem: () => 8192 * MB,
    rssOf: () => null,
    onChromeLog: (m) => logs.push(m),
    browserGroups: async () => groups,
    loadState: state ? async () => state : null,
    writeState: async () => {},
    now: () => (t += 1),
    sleep: async () => {},
    send: async (chatId, text) => sent.push({ chatId, text }),
    brains: { resolve: (name) => ({ name, type: 'ccode' }) },
    ...(requestLogin ? { requestLogin } : {}),
  });
  return { cmds, calls, logs, sent, launches, brainCdp, brainActs, brainCloses };
}

const sharedDir = join(dirname(CHROME_BRAIN_PROFILE), 'shared');
const run = (cmds, chatId, body) => cmds.run({ chatId, surface: 'whatsapp', authorized: true, body });

describe('browserConversationOf — THE resolver every browser caller routes through', () => {
  it('a chat → its registry row → its group; unlisted → shared; listed twice → null + why', async () => {
    const { cmds } = build();
    expect(await cmds.browserConversationOf('whatsapp', '!admin')).toEqual({ key: 'eGPT Admin-2609121344', name: 'eGPT Admin', group: 'brain' });
    expect((await cmds.browserConversationOf('whatsapp', '!reinie')).group).toBe('shared');
    const dup = await cmds.browserConversationOf('whatsapp', '!dup');
    expect(dup.group).toBe(null);
    expect(dup.why).toMatch(/work, other/);
  });

  it('a ROOM is listed by its rooms.yaml slug: its row (conversation_path) or, with none, its fixed slug', async () => {
    const { cmds } = build();
    expect((await cmds.browserConversationOf('room', 'acim')).group).toBe('brain');   // .egpt/rooms/acim
    expect((await cmds.browserConversationOf('room', 'tpoef')).group).toBe('brain');  // no row → fixedSlugFor
    expect((await cmds.browserConversationOf('room', 'dj-son')).group).toBe('shared');
  });

  it('no registry wired (standalone construction) → null, the conversation-less brain path', async () => {
    const { cmds } = build({ state: null });
    expect(await cmds.browserConversationOf('whatsapp', '!admin')).toBe(null);
  });
});

describe('startBrowser(conversation)', () => {
  it('eGPT Admin (brain) → the brain port path, no pipe spawn', async () => {
    const { cmds, calls } = build();
    const r = await cmds.startBrowser(await cmds.browserConversationOf('whatsapp', '!admin'));
    expect(r).toMatchObject({ ok: true, alreadyRunning: true });
    expect(r.detail).toMatch(/localhost:9221/);
    expect(calls).toHaveLength(0);
  });

  it('an unlisted chat → its shared group pipe Chrome', async () => {
    const { cmds, calls } = build();
    const r = await cmds.startBrowser(await cmds.browserConversationOf('whatsapp', '!reinie'));
    expect(r).toMatchObject({ ok: true, launched: true });
    expect(calls.map((c) => c.userDataDir)).toEqual([sharedDir]);
  });

  it('ambiguous → no browser, one log line, never the brain', async () => {
    const { cmds, calls, logs, launches } = build();
    const r = await cmds.startBrowser(await cmds.browserConversationOf('whatsapp', '!dup'));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/work, other/);
    expect(calls).toHaveLength(0);
    expect(launches).toHaveLength(0);
    expect(logs.filter((l) => /no browser for "Twice"/.test(l))).toHaveLength(1);
  });

  it('conversation-less → the brain path, unchanged', async () => {
    const { cmds, calls } = build();
    expect(await cmds.startBrowser()).toEqual({ ok: true, alreadyRunning: true, detail: 'the browser is already answering on localhost:9221 — nothing was launched' });
    expect(calls).toHaveLength(0);
  });
});

describe('/chrome resolves the chat it was typed in', () => {
  it('in eGPT Admin → the brain port report', async () => {
    const { cmds, sent, calls } = build();
    await run(cmds, '!admin', '/chrome kg');
    expect(sent[0].text).toMatch(/attached: localhost:9221/);
    expect(sent[0].text).toMatch(/Gmail/);
    expect(calls).toHaveLength(0);
  });

  it('in an unlisted chat → the shared group Chrome\'s tabs, not the brain\'s', async () => {
    const { cmds, sent, calls } = build();
    await run(cmds, '!reinie', '/chrome kg');
    expect(sent[0].text).toMatch(/PipeTab/);
    expect(sent[0].text).not.toMatch(/Gmail|9221/);
    expect(calls).toHaveLength(1);
  });

  it('ambiguous → no browser, nothing launched', async () => {
    const { cmds, sent, calls, launches } = build();
    await run(cmds, '!dup', '/chrome kg');
    expect(sent[0].text).toMatch(/no browser/);
    expect(sent[0].text).not.toMatch(/Gmail/);
    expect(calls).toHaveLength(0);
    expect(launches).toHaveLength(0);
  });
});

describe('/tabs /close drive the chat\'s group Chrome', () => {
  it('/tabs in eGPT Admin lists the brain; in an unlisted chat the shared group', async () => {
    const { cmds, sent } = build();
    await run(cmds, '!admin', '/tabs');
    await run(cmds, '!reinie', '/tabs');
    expect(sent[0].text).toMatch(/1 · Gmail/);
    expect(sent[1].text).toMatch(/1 · PipeTab/);
    expect(sent[1].text).not.toMatch(/Gmail/);
  });

  it('/close 1 in an unlisted chat never touches a brain tab', async () => {
    const { cmds, sent, brainCloses } = build();
    await run(cmds, '!reinie', '/close 1');
    expect(sent[0].text).toMatch(/closed 1 · PipeTab/);
    expect(brainCloses).toEqual([]);
  });

  it('/tabs in an ambiguous chat → no tabs, nothing spawned', async () => {
    const { cmds, sent, calls } = build();
    await run(cmds, '!dup', '/tabs');
    expect(sent[0].text).not.toMatch(/Gmail|PipeTab/);
    expect(calls).toHaveLength(0);
  });
});

describe('/login follows the chat\'s group', () => {
  const recorder = () => { const seen = []; return { seen, requestLogin: async (site, o) => { seen.push({ site, ...o }); return 'logged-in'; } }; };

  it('eGPT Admin → the brain conversation + the brain port client', async () => {
    const rec = recorder();
    const { cmds, brainCdp } = build({ requestLogin: rec.requestLogin });
    await run(cmds, '!admin', '/login example.com');
    expect(rec.seen).toHaveLength(1);
    expect(rec.seen[0].conversation.group).toBe('brain');
    expect(rec.seen[0].client).toBe(brainCdp);
  });

  it('an unlisted chat → the shared conversation + the shared pipe client', async () => {
    const rec = recorder();
    const { cmds, brainCdp } = build({ requestLogin: rec.requestLogin });
    await run(cmds, '!reinie', '/login example.com');
    expect(rec.seen[0].conversation.group).toBe('shared');
    expect(rec.seen[0].client).not.toBe(brainCdp);
    expect(await rec.seen[0].client.listTabs()).toEqual([{ id: 'P1', type: 'page', url: 'https://pipe.example/', title: 'PipeTab' }]);
  });

  it('ambiguous → the limb is never asked', async () => {
    const rec = recorder();
    const { cmds, sent } = build({ requestLogin: rec.requestLogin });
    await run(cmds, '!dup', '/login example.com');
    expect(rec.seen).toHaveLength(0);
    expect(sent[0].text).toMatch(/no browser/);
  });
});

describe('loginProfilePathOf — the credential comes from the GROUP profile', () => {
  const cfg = { login: { chrome_profile_path: 'C:/x/brain-login' } };
  it('brain (or conversation-less) → the login override, as before', () => {
    expect(loginProfilePathOf(cfg)).toBe('C:/x/brain-login');
    expect(loginProfilePathOf(cfg, { name: 'eGPT Admin', group: 'brain' })).toBe('C:/x/brain-login');
    expect(loginProfilePathOf({})).toBe(CHROME_BRAIN_PROFILE);
  });
  it('another group → that group\'s profile dir, never the brain override', () => {
    expect(loginProfilePathOf(cfg, { name: 'Reinie Alvino', group: 'shared' })).toBe(sharedDir);
  });
  it('no group → null (no credential is read)', () => {
    expect(loginProfilePathOf(cfg, { name: 'Twice', group: null })).toBe(null);
  });
});

describe('room relay hands its seams the room event, so boot can pick the room\'s group Chrome', () => {
  it('activateTarget and streamFromTab both receive the event as their second argument', async () => {
    const seen = [];
    const relay = createRoomRelay({
      resolveMembers: async () => [{ kind: 'brain', id: 'chatgpt', adapter: 'chatgpt-cdp', state: 'active', targetId: 'T9' }],
      adapterOf: async () => ({ injectScript: (t) => t, pollScript: 'p' }),
      streamFromTab: async (o, ev) => { seen.push(['stream', o.targetId, ev]); return ''; },
      activateTarget: async (id, ev) => { seen.push(['activate', id, ev]); },
      openStream: () => ({ update() {}, async finish() {}, async fail() {} }),
    });
    const ev = { surface: 'room', chatId: 'acim', body: 'hi' };
    await relay.fanOut(ev);
    expect(seen).toEqual([['activate', 'T9', ev], ['stream', 'T9', ev]]);
  });
});

describe('boot wires the heartbeat and the room relay through the ONE resolver (source lock)', () => {
  const BOOT_SRC = readFileSync(join(REPO, 'src', 'spine', 'boot.mjs'), 'utf8');
  it('a browser: true beat starts its conversation\'s group Chrome', () => {
    expect(BOOT_SRC).toMatch(/startBrowser: async \(ns\) =>[^\n]*commands\.startBrowser\(await commands\.browserConversationOf\(/);
  });
  it('the relay drives the room\'s group Chrome via commands.chatChromeOf', () => {
    expect(BOOT_SRC).toMatch(/streamFromTab: async \(o, ev\) =>/);
    expect(BOOT_SRC).toMatch(/activateTarget: async \(id, ev\) =>/);
    expect(BOOT_SRC).toMatch(/commands\.chatChromeOf\(ev\?\.surface, ev\?\.chatId\)/);
  });
  it('commands gets the full cdp module (the brain client) and the chrome log', () => {
    expect(BOOT_SRC).toMatch(/^\s+cdp,\s/m);
    expect(BOOT_SRC).toMatch(/onChromeLog: \(m\) => log\.line/);
  });
});
