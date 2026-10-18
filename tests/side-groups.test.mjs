// tests/side-groups.test.mjs — side groups, the aligned spec (operator 2026-10-18 ~17:10).
//
// 1. No "SI chat …" trigger anywhere.
// 2. /join and /split from anyone in the group; /send and /end from anyone in the side group. With a
//    mouth (beeper.secondary) the SECONDARY creates "SI+<group>-<name>" inviting only the requester;
//    the operator's own request is made on the primary with Rodz (the same two members); no mouth →
//    the primary invites the requester.
// 3. `side_group: { automatic: true }` on the chat's own entry: the being never replies there; its first
//    reply opens "SI+<group>" (Rodz + the sender answered) and every reply goes there. Off → in place.
//    No admin siphon. One node creates (node_role primary); the other links the group from the intro's
//    canary frame.
// Never a real Beeper call: forkBridge is a fake that records which account each op rode.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const HOME = vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  const dir = `${tmp}/egpt-side-groups-home`;
  process.env.EGPT_HOME = dir;
  return dir;
});
import { rmSync } from 'node:fs';
import * as commandsModule from '../src/spine/commands.mjs';
import { createCommands } from '../src/spine/commands.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createSpine } from '../src/spine/spine.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createRouter } from '../src/spine/router.mjs';
import { ensureContact, recordThread, patchContact, patchBeing, getContact, aliasContact } from '../src/conversations-state.mjs';
import { shortChatId } from '../src/bridges/chat-id.mjs';
import { encodeNodeSignature, encodeChatCanary, decodeChatCanary } from '../src/node-signature.mjs';

const ORIGIN = 'palma1';
const TITLE = '🌴FAMILIA PALMA🌴';
const SIDE_FULL = '!side1:beeper.local';
const SIDE = shortChatId(SIDE_FULL);
const SIDE2_FULL = '!side2:beeper.local';
const SEC_ROOM = '!secRoom';           // the mouth's own room for a primary-made group
const ADMIN = 'admin1';
const AN = '+16468217865';
const RODZ = '+13472576794';
const RODZ_DIGITS = '13472576794';
const RODZ_USER_ID = '@whatsapp_lid-69433129173200:beeper.local';
const AN_ID = '@anrodriguez:beeper.com';
const LULU = '@whatsapp_lid-lulu42:beeper.local';
const LULU_DIGITS = '34600000000';
const LULU_ON_SEC = '@whatsapp_34600000000:beeper.local';   // the secondary's own id for Lulu
const PEPE = '@whatsapp_lid-pepe7:beeper.local';

const cfg = ({ node_role = 'primary', secondary = true, extra = {} } = {}) => ({
  beeper: { primary: { phone: AN }, ...(secondary ? { secondary: { phone: RODZ } } : {}) },
  node_name: 'kg', node_role, group_title: '{group}-{name}', admin_channel: ADMIN, ...extra,
});

function seedState({ entry = {} } = {}) {
  let st = ensureContact({ contacts: {} }, 'whatsapp', ORIGIN, { pushedName: TITLE }).state;
  st = recordThread(st, 'whatsapp', ORIGIN, 'palma-e-thread', '2026-10-01T00:00:00Z', 'e');
  if (Object.keys(entry).length) st = patchContact(st, 'whatsapp', ORIGIN, entry);
  return ensureContact(st, 'whatsapp', ADMIN, { pushedName: 'eGPT Admin' }).state;
}
const AUTOMATIC = { side_group: { automatic: true } };

const LIVE = { participants: { items: [{ id: RODZ_USER_ID, phoneNumber: RODZ }, { id: LULU, phoneNumber: '+34600000000' }] } };

// secIds: digits → the secondary's own id for that phone (its rosters); absent → no match there.
function harness({ config = cfg(), state, chatRaw = async () => LIVE, created = [SIDE_FULL, SIDE2_FULL], secIds = {} } = {}) {
  let st = state ?? seedState();
  const sent = [];
  const logs = [];
  const calls = { create: [], post: [], archive: [], edit: [], resolve: [] };
  const forkBridge = {
    editMessage: async (chatId, msgId, text) => { calls.edit.push({ chatId, msgId, text }); return true; },
    createGroup: async (opts, o = {}) => { calls.create.push({ ...opts, via: o.via ?? null }); return { success: true, chatID: created[calls.create.length - 1] }; },
    postReply: async (chatId, text, replyTo, opts = {}) => { calls.post.push({ chatId, text, via: opts.via ?? null, canary: opts.canary ?? null, unsigned: !!opts.unsigned }); return { ok: true }; },
    archiveChat: async (chatId, o = {}) => { calls.archive.push({ chatId, via: o.via ?? null }); return true; },
    chatAccountId: async () => 'whatsapp',
    chatRaw,
    chatTitle: async () => null,
    resolveUserIdByPhone: async (digits, o = {}) => {
      calls.resolve.push({ digits, via: o.via ?? null });
      return o.via === 'secondary' ? (secIds[digits] ?? null) : (digits === RODZ_DIGITS ? RODZ_USER_ID : null);
    },
    resolveSecondaryChatIdByTitle: async () => SEC_ROOM,
    listMessagesRaw: async () => [{ id: 'q1', text: 'la respuesta' }],
  };
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    defaultKey: 'e',
    forkBridge,
    sleep: async () => {},
    onLog: (m) => logs.push(m),
  });
  return { cmds, sent, logs, calls, config, getState: () => st, setState: (s) => { st = s; } };
}

// Lulu: a member of the group, not the operator, not on any allowed_users list.
const inOrigin = (body, extra = {}) => ({ chatId: ORIGIN, surface: 'whatsapp', chatName: TITLE, senderId: LULU, senderName: 'Lulu', msgId: 'm1', body, raw: { chatType: 'group' }, ...extra });
const asOperator = { senderId: AN_ID, senderName: 'An', isSender: true, authorized: true };
async function typed(h, ev) {
  if (!h.cmds.isCommand(ev)) return 'not a command';
  return h.cmds.run(ev);
}

beforeEach(() => { rmSync(HOME, { recursive: true, force: true }); });

// ── 1. "SI chat …" is out ────────────────────────────────────────────────────────────────────────
describe('"SI chat …" opens nothing anywhere', () => {
  const STRAY = { superchats: { triggers: ['SI chat'], prefix: 'SI+' } };
  for (const body of ['SI chat', 'SI chat viaje', 'si chat viaje']) {
    it(`"${body}" in a chat whose entry still carries a superchats block is an ordinary message`, async () => {
      const h = harness({ state: seedState({ entry: STRAY }) });
      for (const ev of [inOrigin(body), inOrigin(body, asOperator)]) {
        expect(await h.cmds.phraseCommand(ev)).toBe(null);
        expect(h.cmds.isCommand(ev)).toBe(false);
      }
      expect(h.calls.create).toEqual([]);
    });
  }

  it('a leftover global super_chats block summons nothing either', async () => {
    const h = harness({ config: cfg({ extra: { super_chats: { triggers: ['SI chat'], automatic: true } } }) });
    expect(await h.cmds.phraseCommand(inOrigin('SI chat'))).toBe(null);
    expect(h.calls.create).toEqual([]);
  });

  it('the SI chat machinery is gone from the module', () => {
    for (const k of ['superchatTrigger', 'SUPERCHAT_DIR', 'SUPERCHAT_PREFIX_DEFAULT', 'SUPERCHAT_INTRO', 'SUPERCHAT_HELP']) expect(commandsModule[k], k).toBeUndefined();
  });
});

// ── 2. /join and /split from any member ──────────────────────────────────────────────────────────
describe('who may run the side-group commands', () => {
  it('a member (not the operator) is admitted for /join /split /send /end, and still for nothing else', () => {
    const h = harness();
    for (const body of ['/join viaje', '/split viaje', '/send', '/end', '/JOIN', '/split']) expect(h.cmds.isCommand(inOrigin(body)), body).toBe(true);
    for (const body of ['/agents mode on e', '/status', '/config', '/restart', '/joinx']) expect(h.cmds.isCommand(inOrigin(body)), body).toBe(false);
  });

  it('a node-signed line is never a command from a member (being output is never input)', () => {
    const h = harness();
    for (const body of ['/join viaje', '/split viaje', '/send', '/end']) {
      expect(h.cmds.isCommand(inOrigin(`${body}${encodeNodeSignature('do', 'don')}`, { fromNode: 'do' })), body).toBe(false);
    }
  });

  it('a member the being would not answer (allowed_users) may still /join', async () => {
    let st = seedState();
    st = patchBeing(st, 'whatsapp', ORIGIN, 'e', { allowed_users: ['@someone-else:beeper.local'] });
    const h = harness({ state: st });
    await typed(h, inOrigin('/join viaje'));
    expect(h.calls.create).toHaveLength(1);
  });

  it('a non-operator in a 1:1 creates nothing', async () => {
    const h = harness();
    await typed(h, inOrigin('/join viaje', { raw: { chatType: 'single' } }));
    await typed(h, inOrigin('/split viaje', { raw: { chatType: 'single' } }));
    expect(h.calls.create).toEqual([]);
  });

  it('a non-primary node stands down for a member too', async () => {
    const h = harness({ config: cfg({ node_role: 'secondary' }) });
    await typed(h, inOrigin('/join viaje'));
    await typed(h, inOrigin('/split viaje'));
    expect(h.calls.create).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

describe('/join and /split: the secondary creates "SI+<group>-<name>" with only the requester', () => {
  it('/join viaje by a member: created on the secondary, members Rodz (the creator) + Lulu, aliased', async () => {
    const h = harness();
    await typed(h, inOrigin('/join viaje'));
    expect(h.calls.create).toEqual([{ accountID: 'whatsapp', participantIDs: [LULU], type: 'group', title: `SI+${TITLE}-viaje`, via: 'secondary' }]);
    expect(h.getState().contacts.whatsapp[SIDE]).toMatchObject({ aliasOf: ORIGIN, join_name: 'viaje', join_by_id: LULU });
  });

  it('its opener comes from the secondary, straight into the new group', async () => {
    const h = harness();
    await typed(h, inOrigin('/join viaje'));
    expect(h.calls.post).toHaveLength(1);
    expect(h.calls.post[0]).toMatchObject({ chatId: SIDE, via: 'secondary' });
  });

  it('/split viaje by a member: created on the secondary with only Lulu, a new conversation', async () => {
    const h = harness();
    await typed(h, inOrigin('/split viaje'));
    expect(h.calls.create).toEqual([{ accountID: 'whatsapp', participantIDs: [LULU], type: 'group', title: `SI+${TITLE}-viaje`, via: 'secondary' }]);
    const split = getContact(h.getState(), 'whatsapp', SIDE);
    expect(split.jid).toBe(SIDE);
    expect(split.entry.parent_chat).toBe(ORIGIN);
    expect(h.calls.post[0]).toMatchObject({ chatId: SIDE, via: 'secondary' });
  });

  it('no <name>: today\'s default name, with the SI+<group>- prefix', async () => {
    const h = harness();
    await typed(h, inOrigin('/join'));
    await typed(h, inOrigin('/split'));
    expect(h.calls.create.map((c) => c.title)).toEqual([`SI+${TITLE}-egpt super`, `SI+${TITLE}-egpt split`]);
    const named = harness({ config: cfg({ extra: { join: { default_name: 'charla' } } }) });
    await typed(named, inOrigin('/join'));
    expect(named.calls.create[0].title).toBe(`SI+${TITLE}-charla`);
  });

  it('no secondary configured: the primary creates it with only the requester', async () => {
    const h = harness({ config: cfg({ secondary: false }) });
    await typed(h, inOrigin('/join viaje'));
    await typed(h, inOrigin('/split viaje'));
    expect(h.calls.create.map((c) => [c.via, c.participantIDs])).toEqual([['primary', [LULU]], ['primary', [LULU]]]);
    expect(h.calls.post.map((p) => p.via)).toEqual(['primary', 'primary']);
  });

  it('the operator runs it: the same two members (Rodz + the operator), made on the primary', async () => {
    const h = harness();
    await typed(h, inOrigin('/join viaje', asOperator));
    expect(h.calls.create).toEqual([{ accountID: 'whatsapp', participantIDs: [RODZ_USER_ID], type: 'group', title: `SI+${TITLE}-viaje`, via: 'primary' }]);
    expect(h.calls.post[0]).toMatchObject({ chatId: SEC_ROOM, via: 'secondary' });   // the opener still comes from Rodz
  });

  it('a member whose id cannot be invited gets a one-line answer and nothing is created', async () => {
    const h = harness();
    await typed(h, inOrigin('/split viaje', { senderId: '+34600000000' }));
    expect(h.calls.create).toEqual([]);
    expect(h.sent).toHaveLength(1);
  });
});

describe('the requester is invited under the creating account\'s own id', () => {
  const ORIGIN_ROSTER = { participants: { items: [{ id: RODZ_USER_ID, phoneNumber: RODZ }, { id: LULU, phoneNumber: `+${LULU_DIGITS}` }] } };

  it('heard on the primary: the secondary invites the id its own rosters carry for that phone', async () => {
    const h = harness({ chatRaw: async () => ORIGIN_ROSTER, secIds: { [LULU_DIGITS]: LULU_ON_SEC } });
    await typed(h, inOrigin('/join viaje', { connection: 'primary' }));
    expect(h.calls.create[0]).toMatchObject({ participantIDs: [LULU_ON_SEC], via: 'secondary' });
    expect(h.calls.resolve).toContainEqual({ digits: LULU_DIGITS, via: 'secondary' });
  });

  it('heard on the secondary itself: invited as heard, nothing looked up', async () => {
    const h = harness({ chatRaw: async () => ORIGIN_ROSTER, secIds: { [LULU_DIGITS]: LULU_ON_SEC } });
    await typed(h, inOrigin('/split viaje', { connection: 'secondary' }));
    expect(h.calls.create[0]).toMatchObject({ participantIDs: [LULU], via: 'secondary' });
    expect(h.calls.resolve.filter((r) => r.via === 'secondary')).toEqual([]);
  });

  it('no match on the secondary: invited as heard', async () => {
    const h = harness({ chatRaw: async () => ORIGIN_ROSTER });
    await typed(h, inOrigin('/join viaje', { connection: 'primary' }));
    expect(h.calls.create[0].participantIDs).toEqual([LULU]);
  });

  it('/join again: the member is found in the room the secondary made, under its id for them', async () => {
    const sideRoster = { participants: { items: [{ id: '@dolly-egpt:beeper.com', isSelf: true }, { id: LULU_ON_SEC, phoneNumber: `+${LULU_DIGITS}` }] } };
    const h = harness({ chatRaw: async (id) => (id === ORIGIN ? ORIGIN_ROSTER : sideRoster), secIds: { [LULU_DIGITS]: LULU_ON_SEC } });
    await typed(h, inOrigin('/join viaje', { connection: 'primary' }));
    await typed(h, inOrigin('/join viaje', { connection: 'primary', msgId: 'm2' }));
    expect(h.calls.create).toHaveLength(1);
    expect(h.sent.map((m) => m.text)).toEqual(['🔗 joined group viaje. You can join too: send /join viaje', '🔗 joined group viaje. You can join too: send /join viaje']);
  });
});

describe('/send and /end work for whoever is in the side group', () => {
  const inSide = (body, extra = {}) => ({ chatId: SIDE, surface: 'whatsapp', chatName: `SI+${TITLE}-viaje`, senderId: LULU, senderName: 'Lulu', msgId: 's1', body, raw: { chatType: 'group' }, connection: 'secondary', ...extra });

  it('/send from a member: the secondary posts it in its room for the origin, signed, never as the operator', async () => {
    const h = harness();
    await typed(h, inOrigin('/join viaje'));
    h.calls.post.length = 0;
    await typed(h, inSide('/send', { replyToId: 'q1' }));
    expect(h.calls.post).toHaveLength(1);
    expect(h.calls.post[0]).toMatchObject({ chatId: SEC_ROOM, via: 'secondary', unsigned: false });
    expect(h.calls.post[0].text).toContain('la respuesta');
  });

  it('/send from a member with no secondary: the primary posts it, signed', async () => {
    const h = harness({ config: cfg({ secondary: false }) });
    await typed(h, inOrigin('/join viaje'));
    h.calls.post.length = 0;
    await typed(h, inSide('/send', { replyToId: 'q1', connection: null }));
    expect(h.calls.post).toEqual([expect.objectContaining({ chatId: ORIGIN, via: 'primary', unsigned: false })]);
  });

  it('the operator\'s /send is unchanged: post_back_from (primary), unsigned, into the origin', async () => {
    const h = harness();
    await typed(h, inOrigin('/join viaje'));
    h.calls.post.length = 0;
    await typed(h, inSide('/send', { replyToId: 'q1', ...asOperator, connection: 'primary' }));
    expect(h.calls.post).toEqual([expect.objectContaining({ chatId: ORIGIN, via: 'primary', unsigned: true })]);
  });

  it('/end from a member archives the group on the account it lives on and drops the alias', async () => {
    const h = harness();
    await typed(h, inOrigin('/join viaje'));
    await typed(h, inSide('/end'));
    expect(h.calls.archive).toEqual([{ chatId: SIDE, via: 'secondary' }]);
    expect(h.getState().contacts.whatsapp[SIDE]).toBeUndefined();
  });

  it('outside a side group a member\'s /send and /end do nothing', async () => {
    const h = harness();
    await typed(h, inOrigin('/send', { replyToId: 'q1' }));
    await typed(h, inOrigin('/end'));
    expect(h.calls.post).toEqual([]);
    expect(h.calls.archive).toEqual([]);
    expect(h.sent).toEqual([]);
  });
});

// ── 3. automatic ─────────────────────────────────────────────────────────────────────────────────
// The real spine, the real gating (its side-group seam wired to the real commands), a sender spy.
const AGENTS = { e: { default: true, handles: ['e'] } };
const SIG = encodeNodeSignature('kg', 'e');
function buildSpine(h, { mode = 'on', node = 'kg', actions = undefined } = {}) {
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, chatId: ev.chatId }); return { text: 'ok' }; } };
  const opened = [];
  const sender = { open(chatId, o = {}) { opened.push({ chatId, replyTo: o.replyTo ?? null, origin: o.origin ?? null }); return { activate() {}, update() {}, async finish() {}, fail() {} }; } };
  const config = { ...h.config, agents: AGENTS, dispatch: { auto_default_mode: mode } };
  const spine = createSpine({
    bridge: { onMessage() {}, send() {}, stop() {}, wasSentByUs: () => false },
    brain, identity: createIdentity({ now: () => 1000 }),
    router: createRouter({ getAgents: () => AGENTS, defaultBeing: 'e' }),
    gating: createGating({ getConfig: () => config, loadState: async () => h.getState(), defaultKey: 'e', sideGroupFor: (ev) => h.cmds.autoSideGroup(ev) }),
    commands: h.cmds, sender, actions, transcript: { async log() {} }, heartbeats: { runDue() {} },
    mesh: { isEnvelope: () => false, async handle() {} },
    fromThisNode: (ev) => ev?.fromNode != null && String(ev.fromNode).toLowerCase() === node,
    isSelfChat: () => false, clock: { now: () => 1000 }, defaultBeing: 'e',
  });
  return { spine, brain, opened };
}
const from = (over = {}) => ({ network: 'whatsapp', chatId: ORIGIN, chatName: TITLE, userId: LULU, senderName: 'Lulu', isSender: false, ...over });
const say = (spine, body, over = {}) => spine.handleInbound({ body, from: from({ msgKey: `k-${body}`, ...over }) });

describe('automatic ON: the being never replies in the group', () => {
  it('the first reply opens "SI+<group>" on the secondary (Rodz + the sender) and goes there', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const { spine, brain, opened } = buildSpine(h);
    await say(spine, 'hola a todos');
    expect(h.calls.create).toEqual([{ accountID: 'whatsapp', participantIDs: [LULU], type: 'group', title: `SI+${TITLE}`, via: 'secondary' }]);
    expect(h.getState().contacts.whatsapp[SIDE]).toMatchObject({ aliasOf: ORIGIN, automatic: true });
    expect(brain.calls).toEqual([{ being: 'e', chatId: ORIGIN }]);
    expect(opened).toEqual([{ chatId: SIDE, replyTo: null, origin: null }]);
  });

  it('nothing is posted in the origin; the intro goes into the new group carrying the origin as a canary', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const { spine } = buildSpine(h);
    await say(spine, 'hola a todos');
    expect(h.calls.post).toHaveLength(1);
    expect(h.calls.post[0]).toMatchObject({ chatId: SIDE, via: 'secondary', canary: ORIGIN });
    expect(h.sent).toEqual([]);
    expect(h.calls.edit).toEqual([]);
  });

  it('later replies reuse the same group; no second one', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const { spine, opened } = buildSpine(h);
    await say(spine, 'hola a todos');
    await say(spine, 'y mañana?', { userId: PEPE, senderName: 'Pepe' });
    expect(h.calls.create).toHaveLength(1);
    expect(opened.map((o) => o.chatId)).toEqual([SIDE, SIDE]);
  });

  it('a message inside the SI+ group is answered there (it is the side group, not another origin)', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const { spine, opened } = buildSpine(h);
    await say(spine, 'hola a todos');
    await say(spine, 'sigo aquí', { chatId: SIDE, chatName: `SI+${TITLE}` });
    expect(h.calls.create).toHaveLength(1);
    expect(opened.map((o) => o.chatId)).toEqual([SIDE, SIDE]);
  });

  it('the operator\'s own message: made on the primary with Rodz (the same two members)', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const { spine, opened } = buildSpine(h);
    await say(spine, 'e hola', { userId: AN_ID, senderName: 'An', isSender: true, authorized: true });
    expect(h.calls.create).toEqual([{ accountID: 'whatsapp', participantIDs: [RODZ_USER_ID], type: 'group', title: `SI+${TITLE}`, via: 'primary' }]);
    expect(opened.map((o) => o.chatId)).toEqual([SIDE]);
  });

  it('no secondary: the primary creates "SI+<group>" with the sender', async () => {
    const h = harness({ config: cfg({ secondary: false }), state: seedState({ entry: AUTOMATIC }) });
    const { spine, opened } = buildSpine(h);
    await say(spine, 'hola a todos');
    expect(h.calls.create.map((c) => [c.via, c.participantIDs, c.title])).toEqual([['primary', [LULU], `SI+${TITLE}`]]);
    expect(opened.map((o) => o.chatId)).toEqual([SIDE]);
  });

  it('the reply\'s limbs act in the SI+ group too, never in the origin', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const limbs = [];
    const actions = {
      parse: () => ({ prose: 'ok', run: [{ type: 'reply', targetId: 'm1', text: 'x' }], stripped: [] }),
      execute: async (run, stripped, ev) => { limbs.push(ev.chatId); return { ran: [] }; },
    };
    const { spine } = buildSpine(h, { actions });
    await say(spine, 'hola a todos');
    expect(limbs).toEqual([SIDE]);
  });

  it('a node-signed line it answers (another node\'s being, on Rodz): made on the primary with Rodz', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const { spine, opened } = buildSpine(h);
    await say(spine, `e, estas?${encodeNodeSignature('do', 'don')}`, { userId: RODZ_USER_ID, senderName: 'Rodz' });
    expect(h.calls.create.map((c) => [c.via, c.participantIDs])).toEqual([['primary', [RODZ_USER_ID]]]);
    expect(opened.map((o) => o.chatId)).toEqual([SIDE]);
  });

  it('a gone group is replaced on the next reply', async () => {
    let gone = false;
    const h = harness({ state: seedState({ entry: AUTOMATIC }), chatRaw: async (id) => (gone && id === SIDE ? false : LIVE) });
    const { spine, opened } = buildSpine(h);
    await say(spine, 'hola a todos');
    gone = true;
    await say(spine, 'otra vez');
    expect(h.calls.create).toHaveLength(2);
    expect(opened.map((o) => o.chatId)).toEqual([SIDE, shortChatId(SIDE2_FULL)]);
  });

  it('a creation that fails posts nothing anywhere', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }), created: [] });
    const { spine, opened } = buildSpine(h);
    await say(spine, 'hola a todos');
    expect(opened).toEqual([]);
    expect(h.calls.post).toEqual([]);
  });
});

describe('automatic OFF (the default): replies in place, nothing created, no siphon', () => {
  for (const entry of [{}, { side_group: { automatic: false } }, { side_group: {} }]) {
    it(`entry ${JSON.stringify(entry)}: the reply opens in the group itself`, async () => {
      const h = harness({ state: seedState({ entry }) });
      const { spine, opened } = buildSpine(h);
      await say(spine, 'hola a todos');
      expect(opened.map((o) => [o.chatId, o.origin])).toEqual([[ORIGIN, ORIGIN]]);
      expect(h.calls.create).toEqual([]);
    });
  }

  it('nothing reaches the admin channel, ON or OFF', async () => {
    for (const entry of [{}, AUTOMATIC]) {
      const h = harness({ state: seedState({ entry }) });
      const { spine, opened } = buildSpine(h);
      await say(spine, 'hola a todos');
      expect(opened.some((o) => o.chatId === ADMIN)).toBe(false);
      expect(h.calls.post.some((p) => p.chatId === ADMIN)).toBe(false);
      expect(h.sent.some((s) => s.chatId === ADMIN)).toBe(false);
    }
  });

  it('a `side_group` block on a config.yaml / alias entry is not read: only the chat\'s own entry', async () => {
    let st = seedState();
    st = aliasContact(st, 'whatsapp', 'joinroom', ORIGIN, { transcript: 'x', side_group: { automatic: true } });
    const h = harness({ state: st, config: cfg({ extra: { side_group: { automatic: true } } }) });
    const { spine, opened } = buildSpine(h);
    await say(spine, 'hola a todos');
    await say(spine, 'hola', { chatId: 'joinroom', chatName: 'x' });
    expect(h.calls.create).toEqual([]);
    expect(opened.map((o) => o.chatId)).toEqual([ORIGIN, 'joinroom']);
  });
});

describe('two nodes on the shared accounts: one creates, the other links', () => {
  it('a non-primary node never creates and posts nothing while no group is linked', async () => {
    const h = harness({ config: cfg({ node_role: 'secondary' }), state: seedState({ entry: AUTOMATIC }) });
    const { spine, brain, opened } = buildSpine(h, { node: 'do' });
    await say(spine, 'hola a todos');
    expect(h.calls.create).toEqual([]);
    expect(opened).toEqual([]);
    expect(brain.calls).toEqual([]);
  });

  it('the intro (canary + kg\'s frame) arriving in an unknown chat links it to this node\'s conversation', async () => {
    const h = harness({ config: cfg({ node_role: 'secondary' }), state: seedState({ entry: AUTOMATIC }) });
    const { spine, brain, opened } = buildSpine(h, { node: 'do' });
    await say(spine, `🔗 Side-room of ${TITLE}${SIG}${encodeChatCanary(ORIGIN)}`, { chatId: SIDE, chatName: `SI+${TITLE}`, userId: RODZ_USER_ID, senderName: 'Rodz' });
    expect(h.getState().contacts.whatsapp[SIDE]).toMatchObject({ aliasOf: ORIGIN, automatic: true });
    expect(brain.calls).toEqual([]);                          // the intro itself wakes nobody
    await say(spine, 'hola a todos');
    expect(h.calls.create).toEqual([]);
    expect(opened.map((o) => o.chatId)).toEqual([SIDE]);       // the peer replies in the linked group
  });

  it('the canary never re-links a chat with a conversation of its own (the creator\'s own intro coming back)', async () => {
    const h = harness({ state: recordThread(seedState({ entry: AUTOMATIC }), 'whatsapp', ADMIN, 'admin-e-thread', '2026-10-01T00:00:00Z', 'e') });
    const { spine } = buildSpine(h);
    await say(spine, 'hola a todos');
    const before = h.getState().contacts.whatsapp[SIDE];
    await say(spine, `intro${SIG}${encodeChatCanary(ORIGIN)}`, { chatId: SIDE, chatName: `SI+${TITLE}`, userId: RODZ_USER_ID, isSender: true });
    await say(spine, `intro${SIG}${encodeChatCanary(ORIGIN)}`, { chatId: ADMIN, chatName: 'eGPT Admin', userId: RODZ_USER_ID });
    expect(h.getState().contacts.whatsapp[SIDE]).toEqual(before);
    expect(h.getState().contacts.whatsapp[ADMIN].aliasOf).toBeUndefined();
  });

  it('a chat this node has only seen (no alias, no parent, no thread) is linked by the intro', async () => {
    const st = ensureContact(seedState({ entry: AUTOMATIC }), 'whatsapp', SIDE, { pushedName: `SI+${TITLE}` }).state;
    const h = harness({ config: cfg({ node_role: 'secondary' }), state: st });
    const { spine } = buildSpine(h, { node: 'do' });
    await say(spine, `🔗 intro${SIG}${encodeChatCanary(ORIGIN)}`, { chatId: SIDE, chatName: `SI+${TITLE}`, userId: RODZ_USER_ID, senderName: 'Rodz' });
    expect(h.getState().contacts.whatsapp[SIDE]).toMatchObject({ aliasOf: ORIGIN, automatic: true });
  });

  it('a canary for a conversation this node does not have links nothing', async () => {
    const h = harness({ config: cfg({ node_role: 'secondary' }) });
    const { spine } = buildSpine(h, { node: 'do' });
    await say(spine, `intro${SIG}${encodeChatCanary('unknown9')}`, { chatId: SIDE, chatName: 'SI+x', userId: RODZ_USER_ID });
    expect(h.getState().contacts.whatsapp[SIDE]?.aliasOf).toBeUndefined();
  });
});

describe('the canary frame', () => {
  it('round-trips beside the node frame and leaves the node and being readings alone', async () => {
    const { decodeNodeSignature, decodeBeingSignature, renderNodeSignature, stripNodeSignature } = await import('../src/node-signature.mjs');
    const text = `hola${SIG}${encodeChatCanary(ORIGIN)}`;
    expect(decodeChatCanary(text)).toBe(ORIGIN);
    expect(decodeNodeSignature(text)).toBe('kg');
    expect(decodeBeingSignature(text)).toBe('e');
    expect(renderNodeSignature(text)).toBe('hola<kg>');
    expect(stripNodeSignature(text)).toBe('hola');
    expect(decodeChatCanary(`hola${SIG}`)).toBe(null);
    expect(encodeChatCanary('')).toBe('');
  });
});

// ── 4. loop safety in the side groups ────────────────────────────────────────────────────────────
describe('no loop: the side group\'s own output wakes nobody', () => {
  it('the intro and E\'s signed reply coming back in the SI+ group wake nobody, even in mode on', async () => {
    const h = harness({ state: seedState({ entry: AUTOMATIC }) });
    const { spine, brain, opened } = buildSpine(h);
    await say(spine, 'hola a todos');
    brain.calls.length = 0; opened.length = 0;
    await say(spine, `🔗 intro${SIG}${encodeChatCanary(ORIGIN)}`, { chatId: SIDE, chatName: `SI+${TITLE}`, userId: RODZ_USER_ID, isSender: true });
    await say(spine, `🐶 E: aquí estoy${SIG}`, { chatId: SIDE, chatName: `SI+${TITLE}`, userId: RODZ_USER_ID, isSender: true });
    expect(brain.calls).toEqual([]);
    expect(opened).toEqual([]);
  });
});
