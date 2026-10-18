// tests/superchats.test.mjs — per-conversation SI chats (operator 2026-10-18).
//
// A chat whose OWN conversations.yaml entry carries `superchats: { triggers: [...] }` opens a side
// group on "<phrase> [<label>]": "SI+<chat title>+<label>", the mouth and the sender invited at
// creation, aliased to the chat's conversation (the /join kind) with its own transcript-si-<label>.md
// and the being in accum. The link is SI Chats/<label>.yaml in the ORIGIN folder, keyed by chat ids;
// /send /end /help read it. Never a real Beeper call: forkBridge is a fake that records.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-superchats-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { rmSync, existsSync, readFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import * as YAML from 'yaml';
import { createCommands, superchatTrigger, SUPERCHAT_DIR } from '../src/spine/commands.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createContacts } from '../src/spine/contacts.mjs';
import { createTranscript } from '../src/spine/transcript.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { ensureContact, recordThread, patchContact, getContact, getBeing } from '../src/conversations-state.mjs';
import { Room } from '../src/room-core.mjs';
import { shortChatId } from '../src/bridges/chat-id.mjs';
import { encodeNodeSignature } from '../src/node-signature.mjs';
import { helpText } from '../src/interpreter.mjs';

const ORIGIN = 'palma1';
const TITLE = '🌴FAMILIA PALMA🌴';
const OTHER = 'other1';
const SIDE_FULL = '!side1:beeper.local';
const SIDE = shortChatId(SIDE_FULL);
const SEC_SIDE = '!secSide';           // the mouth's own room for the new group
const AN = '+16468217865';
const RODZ = '+13472576794';
const RODZ_DIGITS = '13472576794';
const RODZ_USER_ID = '@whatsapp_lid-69433129173200:beeper.local';
const LULU = '@whatsapp_lid-lulu42:beeper.local';
const BLOCK = { triggers: ['SI chat', 'abre SI'] };
const AT = new Date(2026, 9, 18, 14, 30).getTime();   // local, so the default label is fixed
const AT_ISO = new Date(AT).toISOString();

const cfg = ({ node_role = 'primary', secondary = true, superChats } = {}) => ({
  beeper: { primary: { phone: AN }, ...(secondary ? { secondary: { phone: RODZ } } : {}) },
  node_name: 'kg', node_role,
  ...(superChats ? { super_chats: superChats } : {}),
});

function seedState({ block = BLOCK } = {}) {
  let st = ensureContact({ contacts: {} }, 'whatsapp', ORIGIN, { pushedName: TITLE }).state;
  st = recordThread(st, 'whatsapp', ORIGIN, 'palma-e-thread', '2026-10-01T00:00:00Z', 'e');
  if (block) st = patchContact(st, 'whatsapp', ORIGIN, { superchats: block });
  st = ensureContact(st, 'whatsapp', OTHER, { pushedName: 'Otro' }).state;
  return recordThread(st, 'whatsapp', OTHER, 'other-e-thread', '2026-10-01T00:00:00Z', 'e');
}

const LIVE = { participants: { items: [
  { id: '@anrodriguez:beeper.com', isSelf: true },
  { id: RODZ_USER_ID, phoneNumber: RODZ },
  { id: LULU, phoneNumber: '+34600000000' },
] } };

function harness({ config = cfg(), state, rodzUserId = RODZ_USER_ID, chatRaw = async () => LIVE, created = [SIDE_FULL], messages = null, now = () => AT } = {}) {
  let st = state ?? seedState();
  const sent = [];
  const logs = [];
  const calls = { create: [], post: [], archive: [] };
  const forkBridge = {
    editMessage: async () => true,
    createGroup: async (opts) => { calls.create.push(opts); return { success: true, chatID: created[calls.create.length - 1] ?? SIDE_FULL }; },
    postReply: async (chatId, text, replyTo, opts = {}) => { calls.post.push({ chatId, text, via: opts.via ?? null, unsigned: !!opts.unsigned }); return { ok: true }; },
    archiveChat: async (chatId) => { calls.archive.push(chatId); return true; },
    chatAccountId: async () => 'whatsapp',
    chatRaw,
    chatTitle: async () => null,
    resolveUserIdByPhone: async (digits) => (digits === RODZ_DIGITS ? rodzUserId : null),
    resolveSecondaryChatIdByTitle: async () => SEC_SIDE,
    ...(messages ? { listMessagesRaw: async () => messages } : {}),
  };
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    defaultKey: 'e',
    forkBridge,
    sleep: async () => {},
    now,
    onLog: (m) => logs.push(m),
  });
  return { cmds, sent, logs, calls, getState: () => st, setState: (s) => { st = s; } };
}

const originDir = (st) => Room.forChat('whatsapp', getContact(st, 'whatsapp', ORIGIN).slug).baseDir();
const linkPath = (st, key) => join(originDir(st), SUPERCHAT_DIR, `${key}.yaml`);
const readLink = (st, key) => YAML.parse(readFileSync(linkPath(st, key), 'utf8'));

// Lulu (a member, not the operator) in the origin group.
const inOrigin = (body, extra = {}) => ({ chatId: ORIGIN, surface: 'whatsapp', chatName: TITLE, senderId: LULU, senderName: 'Lulu', msgId: 'm1', body, raw: { chatType: 'group' }, ...extra });
const inSide = (body, extra = {}) => ({ chatId: SIDE, surface: 'whatsapp', chatName: `SI+${TITLE}+viaje`, senderId: '@anrodriguez:beeper.com', isSender: true, authorized: true, msgId: 's1', body, raw: { chatType: 'group' }, ...extra });

async function open(h, body = 'SI chat viaje', extra = {}) {
  const ev = inOrigin(body, extra);
  const cmd = await h.cmds.phraseCommand(ev);
  if (cmd) await h.cmds.runPhrase(ev, cmd);
  return cmd;
}

beforeEach(() => { rmSync(HOME, { recursive: true, force: true }); });

describe('superchatTrigger — the phrase list, whole message, any case, optional label', () => {
  it('each phrase as the whole message (trimmed, any case) → empty label', () => {
    for (const body of ['SI chat', 'si chat', '  SI CHAT  ', 'abre si', 'ABRE SI ']) expect(superchatTrigger(BLOCK, body)).toEqual({ label: '' });
  });
  it('a phrase followed by whitespace and a label → the label (whitespace collapsed)', () => {
    expect(superchatTrigger(BLOCK, 'SI chat viaje')).toEqual({ label: 'viaje' });
    expect(superchatTrigger(BLOCK, 'si CHAT   Viaje a  Mérida ')).toEqual({ label: 'Viaje a Mérida' });
    expect(superchatTrigger(BLOCK, 'abre SI\ncumple')).toEqual({ label: 'cumple' });
  });
  it('not a trigger: glued, prefixed, contained, typo', () => {
    for (const body of ['SI chatviaje', 'mira SI chat', 'el SI chat viaje', 'SI cha', '', 'hola']) expect(superchatTrigger(BLOCK, body)).toBe(null);
  });
  it('the longest phrase wins', () => {
    expect(superchatTrigger({ triggers: ['SI', 'SI chat'] }, 'SI chat viaje')).toEqual({ label: 'viaje' });
  });
  it('no phrase → never a trigger', () => {
    for (const block of [null, {}, { triggers: [] }, { triggers: ['', '  ', null] }, { triggers: 'SI chat' }]) expect(superchatTrigger(block, 'SI chat')).toBe(null);
  });
  it('a label over 60 characters is not a trigger (an ordinary sentence)', () => {
    expect(superchatTrigger(BLOCK, `SI chat ${'x'.repeat(61)}`)).toBe(null);
    expect(superchatTrigger(BLOCK, `SI chat ${'x'.repeat(60)}`)).toEqual({ label: 'x'.repeat(60) });
  });
});

describe('phraseCommand — only where the chat\'s own entry has the block', () => {
  it('the enabled chat: a trigger from a member → superchat', async () => {
    const h = harness();
    expect(await h.cmds.phraseCommand(inOrigin('SI chat viaje'))).toBe('superchat');
    expect(await h.cmds.phraseCommand(inOrigin('abre si'))).toBe('superchat');
  });
  it('another chat (no block): ordinary message', async () => {
    const h = harness();
    expect(await h.cmds.phraseCommand(inOrigin('SI chat viaje', { chatId: OTHER }))).toBe(null);
  });
  it('a side group of the enabled chat (its alias) opens nothing', async () => {
    const h = harness();
    await open(h);
    expect(await h.cmds.phraseCommand(inSide('SI chat otra'))).toBe(null);
  });
  it('a being\'s signed line never triggers (being output is never input)', async () => {
    const h = harness();
    expect(await h.cmds.phraseCommand(inOrigin(`SI chat viaje${encodeNodeSignature('kg', 'e')}`, { fromNode: 'kg' }))).toBe(null);
    expect(await h.cmds.phraseCommand(inOrigin('SI chat viaje', { fromNode: 'do' }))).toBe(null);
  });
  it('a block with no phrase: ordinary message', async () => {
    const h = harness({ state: seedState({ block: { triggers: [] } }) });
    expect(await h.cmds.phraseCommand(inOrigin('SI chat'))).toBe(null);
  });
});

describe('opening an SI chat', () => {
  it('creates "SI+<title>+<label>" on the ear, inviting the mouth and the sender', async () => {
    const h = harness();
    await open(h);
    expect(h.calls.create).toHaveLength(1);
    expect(h.calls.create[0]).toMatchObject({ accountID: 'whatsapp', type: 'group', title: `SI+${TITLE}+viaje`, participantIDs: [RODZ_USER_ID, LULU] });
  });

  it('the prefix is the block\'s preference', async () => {
    const h = harness({ state: seedState({ block: { ...BLOCK, prefix: 'Side · ' } }) });
    await open(h);
    expect(h.calls.create[0].title).toBe(`Side · ${TITLE}+viaje`);
  });

  it('no label → a short timestamp label (HHMM-MMDDYYYY, local)', async () => {
    const h = harness();
    await open(h, 'SI chat');
    expect(h.calls.create[0].title).toBe(`SI+${TITLE}+1430-10182026`);
    expect(existsSync(linkPath(h.getState(), '1430-10182026'))).toBe(true);
  });

  it('aliases the group to the conversation: its own transcript key, the being in accum, the origin unchanged', async () => {
    const h = harness();
    await open(h);
    const st = h.getState();
    expect(st.contacts.whatsapp[SIDE]).toEqual({ aliasOf: ORIGIN, transcript: 'si-viaje', agents: { e: { mode: 'accum' } } });
    expect(getContact(st, 'whatsapp', SIDE).slug).toBe(getContact(st, 'whatsapp', ORIGIN).slug);
    expect(getBeing(st, 'whatsapp', SIDE, 'e').mode).toBe('accum');
    expect(getBeing(st, 'whatsapp', ORIGIN, 'e').mode).toBe(null);
    expect(getBeing(st, 'whatsapp', ORIGIN, 'e').threadId).toBe('palma-e-thread');
  });

  it('gating reads accum in the side group', async () => {
    const h = harness();
    await open(h);
    const g = createGating({ getConfig: () => cfg(), loadState: async () => h.getState(), defaultKey: 'e' });
    expect((await g.decide('e', { surface: 'whatsapp', chatId: SIDE, kind: 'message' })).mode).toBe('accum');
  });

  it('posts one intro line from the mouth, naming the exact command to switch to on', async () => {
    const h = harness();
    await open(h);
    expect(h.calls.post).toHaveLength(1);
    expect(h.calls.post[0]).toMatchObject({ chatId: SEC_SIDE, via: 'secondary' });
    expect(h.calls.post[0].text).toContain('/agents mode on e');
    expect(h.calls.post[0].text.split('\n')).toHaveLength(1);
  });

  it('writes the link in the ORIGIN folder: SI Chats/<label>.yaml with both chat ids', async () => {
    const h = harness();
    await open(h);
    const link = readLink(h.getState(), 'viaje');
    expect(link).toMatchObject({ origin_chat: ORIGIN, chat: SIDE, label: 'viaje', created_by: 'Lulu', created_by_id: LULU, created_at: AT_ISO });
    expect(dirname(dirname(linkPath(h.getState(), 'viaje')))).toBe(originDir(h.getState()));
  });

  it('the trigger runs no being turn and edits nothing in the origin', async () => {
    const h = harness();
    await open(h);
    expect(h.sent).toEqual([]);
  });

  it('the operator (the account itself) triggers: only the mouth is invited', async () => {
    const h = harness();
    await open(h, 'SI chat viaje', { senderId: '@anrodriguez:beeper.com', isSender: true, authorized: true });
    expect(h.calls.create[0].participantIDs).toEqual([RODZ_USER_ID]);
  });

  it('no mouth configured: only the sender, the intro from the ear', async () => {
    const h = harness({ config: cfg({ secondary: false }) });
    await open(h);
    expect(h.calls.create[0].participantIDs).toEqual([LULU]);
    expect(h.calls.post).toHaveLength(1);
  });

  it('a configured mouth that does not resolve: nothing created', async () => {
    const h = harness({ rodzUserId: null });
    await open(h);
    expect(h.calls.create).toEqual([]);
  });

  it('a non-primary node stands down silently (the shared account hears it twice)', async () => {
    const h = harness({ config: cfg({ node_role: 'secondary' }) });
    await open(h);
    expect(h.calls.create).toEqual([]);
    expect(h.sent).toEqual([]);
  });

  it('a sender the being would not answer (allowed_users) creates nothing', async () => {
    let st = seedState();
    st = patchContact(st, 'whatsapp', ORIGIN, { agents: { ...getContact(st, 'whatsapp', ORIGIN).entry.agents, e: { ...getContact(st, 'whatsapp', ORIGIN).entry.agents.e, allowed_users: ['@someone-else:beeper.local'] } } });
    const h = harness({ state: st });
    await open(h);
    expect(h.calls.create).toEqual([]);
  });

  it('the same label while its group is open: no second group', async () => {
    const h = harness({ created: [SIDE_FULL, '!side2:beeper.local'] });
    await open(h);
    await open(h, 'si chat VIAJE');
    expect(h.calls.create).toHaveLength(1);
  });

  it('a label whose chat was ended: a new group, the old record kept', async () => {
    const h = harness({ created: [SIDE_FULL, '!side2:beeper.local'] });
    await open(h);
    await h.cmds.run(inSide('/end'));
    await open(h);
    expect(h.calls.create).toHaveLength(2);
    expect(h.calls.create[1].title).toBe(`SI+${TITLE}+viaje 1430-10182026`);
    expect(existsSync(linkPath(h.getState(), 'viaje 1430-10182026'))).toBe(true);
    expect(readLink(h.getState(), 'viaje').ended_at).toBeTruthy();
    expect(h.getState().contacts.whatsapp.side2.aliasOf).toBe(ORIGIN);
  });
});

describe('the side group\'s transcript', () => {
  it('transcript-si-<label>.md in the ORIGIN folder receives the side group\'s lines', async () => {
    const h = harness();
    await open(h);
    const files = new Map();
    const io = { appendFile: async (p, d) => { files.set(p, (files.get(p) ?? '') + d); }, mkdir: async () => {}, existsSync: (p) => files.has(p) };
    const contacts = createContacts({ loadState: async () => h.getState(), writeState: async (s) => h.setState(s), io: { rename: async () => {}, appendFile: async () => {} } });
    const t = createTranscript({ contacts, io });
    const line = (chatId, chatName, id, body) => ({ surface: 'whatsapp', node: 'wa', chatId, chatName, senderId: LULU, ts: Date.UTC(2026, 9, 18, 14, 0), line: `Lulu@[${chatName}].wa (14:00) #${id}: ${body}`, body });
    await t.log(line(SIDE, `SI+${TITLE}+viaje`, 's1', 'en el side'));
    await t.log(line(ORIGIN, TITLE, 'o1', 'en el grupo'));
    const sidePath = join(originDir(h.getState()), 'transcript-si-viaje.md');
    expect(files.get(sidePath)).toContain('en el side');
    expect(files.get(sidePath)).not.toContain('en el grupo');
    expect(files.get(join(originDir(h.getState()), 'transcript.md'))).toContain('en el grupo');
  });
});

describe('commands in the side group', () => {
  it('/send posts the replied-to message into the origin chat, with the origin line', async () => {
    const h = harness({ messages: [{ id: 'q1', text: 'la lista del viaje' }] });
    await open(h);
    await h.cmds.run(inSide('/send', { replyToId: 'q1' }));
    expect(h.calls.post.at(-1)).toEqual({ chatId: ORIGIN, text: `↪ from SI+${TITLE}+viaje:\nla lista del viaje`, via: 'primary', unsigned: true });
  });

  it('/help lists /send /end /help; elsewhere /help is the usual list', async () => {
    const h = harness();
    await open(h);
    await h.cmds.run(inSide('/help'));
    const text = h.sent.at(-1).text;
    for (const c of ['/send', '/end', '/help']) expect(text).toContain(c);
    expect(text).not.toBe(helpText([], 'shell'));
    await h.cmds.run({ ...inSide('/help'), chatId: OTHER });
    expect(h.sent.at(-1).text).toBe(helpText([], 'shell'));
  });

  it('/end closes the link: ended in the file, the alias gone, nothing archived or deleted', async () => {
    const h = harness();
    await open(h);
    await h.cmds.run(inSide('/end'));
    const st = h.getState();
    expect(st.contacts.whatsapp[SIDE]).toBeUndefined();
    expect(h.calls.archive).toEqual([]);
    const link = readLink(st, 'viaje');
    expect(link).toMatchObject({ origin_chat: ORIGIN, chat: SIDE, label: 'viaje' });
    expect(link.ended_at).toBe(AT_ISO);
    expect(getBeing(st, 'whatsapp', ORIGIN, 'e').threadId).toBe('palma-e-thread');
  });

  it('after /end the group is not an SI chat: /send and /help no longer treat it as one', async () => {
    const h = harness({ messages: [{ id: 'q1', text: 'x' }] });
    await open(h);
    await h.cmds.run(inSide('/end'));
    const posts = h.calls.post.length;
    await h.cmds.run(inSide('/send', { replyToId: 'q1' }));
    expect(h.calls.post).toHaveLength(posts);
    await h.cmds.run(inSide('/help'));
    expect(h.sent.at(-1).text).toBe(helpText([], 'shell'));
  });
});

describe('the link is the record: chat ids, never names', () => {
  it('renaming both groups changes nothing', async () => {
    const h = harness({ messages: [{ id: 'q1', text: 'hola' }] });
    await open(h);
    await h.cmds.run(inSide('/send', { replyToId: 'q1', chatName: 'Viaje renombrado' }));
    expect(h.calls.post.at(-1)).toMatchObject({ chatId: ORIGIN, text: '↪ from Viaje renombrado:\nhola' });
    await h.cmds.run(inSide('/help', { chatName: 'Viaje renombrado' }));
    expect(h.sent.at(-1).text).toContain('/end');
  });

  it('the origin folder moving with a rename keeps the link', async () => {
    const h = harness({ messages: [{ id: 'q1', text: 'hola' }] });
    await open(h);
    const st = h.getState();
    const from = originDir(st);
    const slug = 'familia-renombrada';
    const to = Room.forChat('whatsapp', slug).baseDir();
    mkdirSync(dirname(to), { recursive: true });
    renameSync(from, to);
    h.setState(patchContact(st, 'whatsapp', ORIGIN, { slug, pushedName: 'Familia renombrada' }));
    await h.cmds.run(inSide('/send', { replyToId: 'q1' }));
    expect(h.calls.post.at(-1)).toMatchObject({ chatId: ORIGIN });
    await h.cmds.run(inSide('/end'));
    expect(YAML.parse(readFileSync(join(to, SUPERCHAT_DIR, 'viaje.yaml'), 'utf8')).ended_at).toBeTruthy();
  });
});

describe('the legacy global super_chats block is inactive', () => {
  it('its triggers summon nothing, here or in any chat', async () => {
    const h = harness({ config: cfg({ superChats: { triggers: ['hola super'], automatic: true } }) });
    expect(await h.cmds.phraseCommand(inOrigin('hola super'))).toBe(null);
    expect(await h.cmds.phraseCommand(inOrigin('hola super', { chatId: OTHER }))).toBe(null);
  });
});

// The REAL spine, identity, router, gating and commands over one in-memory registry.
describe('no loop: side-group output wakes nobody, and nothing crosses to the origin', () => {
  const AGENTS = { e: { default: true, handles: ['e'] }, codex: { handles: ['codex'], mode: 'off' } };
  const SIG = encodeNodeSignature('kg', 'e');
  function buildSpine(h, { mode = null } = {}) {
    const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, chatId: ev.chatId, body: ev.body }); return { text: 'ok' }; } };
    const opened = [];
    const sender = { open(chatId) { opened.push(chatId); return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
    const config = { ...cfg(), agents: AGENTS, ...(mode ? { dispatch: { auto_default_mode: mode } } : {}) };
    const spine = createSpine({
      bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
      brain, identity: createIdentity({ now: () => 1000 }),
      router: createRouter({ getAgents: () => AGENTS, defaultBeing: 'e' }),
      gating: createGating({ getConfig: () => config, loadState: async () => h.getState(), defaultKey: 'e' }),
      commands: h.cmds, sender, transcript: { async log() {} }, heartbeats: { runDue() {} },
      mesh: { isEnvelope: () => false, async handle() {} },
      fromThisNode: (ev) => ev?.fromNode != null && String(ev.fromNode).toLowerCase() === 'kg',
      isSelfChat: () => false, clock: { now: () => 1000 }, defaultBeing: 'e',
    });
    return { spine, brain, opened };
  }
  const from = (over = {}) => ({ network: 'whatsapp', userId: '@anrodriguez:beeper.com', senderName: 'An', ...over });

  it('the operator\'s trigger opens the group and runs no being turn', async () => {
    const h = harness();
    const { spine, brain } = buildSpine(h, { mode: 'on' });
    await spine.handleInbound({ body: 'SI chat viaje', from: from({ chatId: ORIGIN, chatName: TITLE, msgKey: 't1', isSender: true, authorized: true }) });
    expect(h.calls.create).toHaveLength(1);
    expect(brain.calls).toEqual([]);
  });

  it('E\'s signed reply and the intro coming back in the side group wake nobody — even with the group switched to on', async () => {
    const h = harness();
    await open(h);
    const st = h.getState();
    h.setState({ ...st, contacts: { ...st.contacts, whatsapp: { ...st.contacts.whatsapp, [SIDE]: { ...st.contacts.whatsapp[SIDE], agents: { e: { mode: 'on' } } } } } });
    const { spine, brain, opened } = buildSpine(h);
    await spine.handleInbound({ body: `${h.calls.post[0].text}${SIG}`, from: from({ chatId: SIDE, chatName: `SI+${TITLE}+viaje`, msgKey: 'i1', isSender: true }) });
    await spine.handleInbound({ body: `🐶 E: aquí estoy${SIG}`, from: from({ chatId: SIDE, chatName: `SI+${TITLE}+viaje`, msgKey: 'r1', isSender: true }) });
    expect(brain.calls).toEqual([]);
    expect(opened).toEqual([]);
  });

  it('a person in the side group (accum, called) gets the reply in the side group, never the origin', async () => {
    const h = harness();
    await open(h);
    const { spine, brain, opened } = buildSpine(h);
    await spine.handleInbound({ body: '@e qué llevamos?', from: from({ chatId: SIDE, chatName: `SI+${TITLE}+viaje`, msgKey: 'h1', userId: LULU, senderName: 'Lulu', isSender: false, atEAnywhere: true }) });
    expect(brain.calls.map((c) => c.chatId)).toEqual([SIDE]);
    expect(opened).toEqual([SIDE]);
  });

  it('only the conversation\'s own being is pinned to accum: a being with mode off stays off in the SI+ group', async () => {
    const h = harness();
    await open(h);
    expect(h.getState().contacts.whatsapp[SIDE].agents).toEqual({ e: { mode: 'accum' } });
    const { spine, brain } = buildSpine(h, { mode: 'on' });
    await spine.handleInbound({ body: '@codex revisa esto', from: from({ chatId: SIDE, chatName: `SI+${TITLE}+viaje`, msgKey: 'h2', userId: LULU, senderName: 'Lulu', isSender: false }) });
    await spine.handleInbound({ body: 'y tú qué opinas', from: from({ chatId: SIDE, chatName: `SI+${TITLE}+viaje`, msgKey: 'h3', userId: LULU, senderName: 'Lulu', isSender: false }) });
    expect(brain.calls).toEqual([]);
  });
});
