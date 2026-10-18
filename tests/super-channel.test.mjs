// tests/super-channel.test.mjs — the SUPER CHANNEL, CHUNK 1 (operator 2026-10-08).
//
// A super channel is the SAME KIND of thing as a /join side-room: an ALIAS of the original
// conversation (shares its folder/thread/transcript — conversations-state aliasOf), NOT a /split
// diverging copy. Chunk 1 builds its config + lifecycle + the manual summon; it does NOT yet
// reroute any replies (chunk 2) or implement respect-exit / mention-reinvite (chunk 3).
//
// WHAT THIS LOCKS:
//   · an inbound super_chats.triggers phrase from ANY participant (not operator-only) summons the
//     channel through the EXISTING phraseCommand → runPhrase path;
//   · a first summon CREATES <chat>-super, ALIASES it to the conversation (same alias kind /join
//     writes), INVITES Rodz + the summoner, posts config.super.opener ONCE, and sets the channel's
//     auto-mode to config.super.mode;
//   · a second summon REUSES it (no re-create, no duplicate opener);
//   · no trigger phrase ⇒ SI is off: ordinary chat (phraseCommand returns null);
//   · the mode lands on the SHARED entry (a super channel is an alias; mode resolves THROUGH aliasOf
//     to the primary — there is no per-alias mode slot).
//
// THE HARD CONSTRAINT (as in fork-command.test.mjs): never a real Beeper call. forkBridge is an
// injected fake that only RECORDS the call; state is one in-memory object.
import { describe, it, expect, vi } from 'vitest';

// egpt-home.mjs freezes EGPT_HOME at module load (slugDir reads CONVERSATIONS_ROOT off it), so this
// must run BEFORE the imports — vi.hoisted does that. A private temp profile, never ~/.egpt.
vi.hoisted(() => {
  const tmp = process.env.TEMP || process.env.TMP || process.env.TMPDIR || '/tmp';
  process.env.EGPT_HOME = `${tmp}/egpt-super-channel-home`;
});
import { createCommands, SUPER_SUFFIX_DEFAULT, SUPER_OPENER_DEFAULT } from '../src/spine/commands.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { ensureContact, recordThread, getContact, getBeing, aliasTargetOf, aliasContact, superChannelFor, patchBeing } from '../src/conversations-state.mjs';
import { sanitizeSlug } from '../src/sanitize.mjs';
import { shortChatId } from '../src/bridges/chat-id.mjs';
import { encodeChatCanary, decodeChatCanary, stripNodeSignature, renderNodeSignature, decodeNodeSignature } from '../src/node-signature.mjs';
import { makeWrapPersona } from '../src/bridges/persona-wrap.mjs';

const C_CHAT = '!chatC';
// createGroup returns the FULL matrix id; the spine keys every conversation by the SHORT id. The
// alias MUST be keyed short or a short-form incoming misses it (the 2026-10-04 "no context" bug).
const SUPER_CHAT_FULL = '!chatSuper:beeper.local';
const SUPER_CHAT = shortChatId(SUPER_CHAT_FULL);
// The SECONDARY (Rodz) account's own room id for the new group — the opener posts here (FROM RODZ).
const SEC_SUPER_ROOM = '!secSuper';
const AN = '+16468217865';
const RODZ = '+13472576794';
const RODZ_DIGITS = '13472576794';
const RODZ_USER_ID = '@whatsapp_lid-69433129173200:beeper.local';
// The summoner — a plain participant (NOT the operator): their inbound "…" is what summons.
const SUMMONER = '@whatsapp_lid-summoner42:beeper.local';
const CHAT_TITLE = 'Proyecto X';
const ADMIN_CHAT = '!egptAdmin';   // the resolved admin_channel (eGPT Admin) the siphon routes to (PART C)
const SUPER_TITLE = `${CHAT_TITLE}${SUPER_SUFFIX_DEFAULT}`;   // 'Proyecto X-super'

const ON = { triggers: ['SI chat'] };
// Every shape that leaves SI OFF: no non-blank phrase, whatever else is set.
const OFF_SHAPES = [null, {}, { triggers: [] }, { triggers: [''] }, { triggers: ['  ', null] }, { enabled: true }, { enabled: true, automatic: true, triggers: [] }];

function cfg({ superBlock = ON, node_role = 'primary', node_name = 'kg' } = {}) {
  return {
    beeper: { primary: { phone: AN }, secondary: { phone: RODZ } },
    node_name, node_role,
    ...(superBlock === null ? {} : { super_chats: superBlock }),   // renamed from `super` (migration 0040)
  };
}

// C's contact with a resident being 'e' holding a thread — a KNOWN conversation to alias.
function seedState() {
  let st = ensureContact({ contacts: {} }, 'whatsapp', C_CHAT, { pushedName: CHAT_TITLE }).state;
  st = recordThread(st, 'whatsapp', C_CHAT, 'src-e-thread', '2026-10-01T00:00:00Z', 'e');
  return st;
}

// The PRIMARY's GET /v1/chats/{id} payload for a live super channel (shape measured on reve 2026-10-11):
// self (the primary, no phone), Rodz (secondary.phone) and one human.
const LIVE_ROSTER = { participants: { items: [
  { id: '@anrodriguez:beeper.com', isSelf: true },
  { id: RODZ_USER_ID, phoneNumber: RODZ, isSelf: false },
  { id: SUMMONER, phoneNumber: '+34667928959', isSelf: false },
] } };

function harness({ config, state, resolveSecondaryChatIdByTitle = () => SEC_SUPER_ROOM, rodzUserId = RODZ_USER_ID, chatOtherPartyId = async () => null, chatRaw = async () => LIVE_ROSTER, resolvePrimaryChatIdByTitle = null, createdChatIds = null, now = null, defaultKey = 'e', adminChatId = ADMIN_CHAT } = {}) {
  let st = state ?? seedState();
  const sent = [];
  const logs = [];
  const adminPosts = [];
  const calls = { create: [], post: [], resolve: [], resolveTitle: [], archive: [], chatRaw: [] };
  const forkBridge = {
    editMessage: async () => true,
    createGroup: async (opts) => { calls.create.push(opts); return { success: true, chatID: createdChatIds?.[calls.create.length - 1] ?? SUPER_CHAT_FULL }; },
    postReply: async (chatId, text, replyToMessageID, opts = {}) => { calls.post.push({ chatId, text, replyToMessageID, via: opts.via ?? null }); return { ok: true }; },
    archiveChat: async (chatId) => { calls.archive.push(chatId); return true; },
    chatAccountId: async () => 'whatsapp',
    chatRaw: async (chatId) => { calls.chatRaw.push(chatId); return chatRaw(chatId); },
    chatTitle: async () => null,
    chatOtherPartyId,
    resolveUserIdByPhone: async (digits, opts) => { calls.resolve.push({ digits, opts }); return digits === RODZ_DIGITS ? rodzUserId : null; },
    resolveSecondaryChatIdByTitle: async (title, opts) => { calls.resolveTitle.push({ title, opts }); return resolveSecondaryChatIdByTitle(title, opts); },
    ...(resolvePrimaryChatIdByTitle ? { resolvePrimaryChatIdByTitle: async (title, opts) => resolvePrimaryChatIdByTitle(title, opts) } : {}),
  };
  const cmds = createCommands({
    getConfig: () => config,
    send: async (chatId, text) => sent.push({ chatId, text }),
    loadState: async () => st,
    writeState: async (s) => { st = s; },
    defaultKey,
    forkBridge,
    sleep: async () => {},   // instant opener poll
    ...(now ? { now } : {}),
    noticeToAdmin: async (text) => { adminPosts.push(text); return true; },   // SI siphon warning sink (PART C)
    resolveAdminChatId: async () => adminChatId,                             // admin_channel → chat id (PART C)
    onLog: (m) => logs.push(m),
  });
  return { cmds, sent, logs, adminPosts, calls, getState: () => st };
}

// An INBOUND message (no `authorized`/`isSender`, chat is not a configured Self-DM ⇒ NOT operator).
const inbound = (body = '…', extra = {}) => ({ chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE, senderId: SUMMONER, body, ...extra });

// ── super_chats.triggers: a LIST of exact phrases, ANY sender; no phrase ⇒ SI off (operator 2026-10-18) ──
describe('phraseCommand — super_chats.triggers are the summon phrases', () => {
  const TWO = cfg({ superBlock: { triggers: ['SI chat', 'abre SI'] } });

  it('each phrase, as the whole message (any case, trimmed), summons from a NON-operator', async () => {
    const { cmds } = harness({ config: TWO });
    for (const body of ['si chat', 'SI CHAT', '  SI chat  ', 'abre si', ' ABRE SI ']) expect(await cmds.phraseCommand(inbound(body))).toBe('super');
  });

  it('EXACT whole-message only: prefix / contains / typo do not summon, nor does "…"', async () => {
    const { cmds } = harness({ config: TWO });
    for (const body of ['SI chat now', 'say SI chat', 'SI cha', 'abre SI ya', '…', '...', '']) expect(await cmds.phraseCommand(inbound(body))).toBe(null);
  });

  it('no phrase ⇒ OFF: nothing summons, a leftover enabled: true included', async () => {
    for (const superBlock of OFF_SHAPES) {
      const { cmds } = harness({ config: cfg({ superBlock }) });
      for (const body of ['…', '...', '', '   ', 'SI chat']) expect(await cmds.phraseCommand(inbound(body))).toBe(null);
    }
  });

  it('REGRESSION: the operator fork triggers are unchanged beside it', async () => {
    const config = { ...TWO, join: { triggers: ['dame un segundo'] } };
    const { cmds } = harness({ config });
    const op = (body) => ({ ...inbound(body), authorized: true });
    expect(await cmds.phraseCommand(op('Dame un segundo'))).toBe('join');
    expect(await cmds.phraseCommand(inbound('dame un segundo'))).toBe(null);   // non-operator: ordinary message
    expect(await cmds.phraseCommand(op('SI chat'))).toBe('super');
  });
});

// ── the summon: create + alias + invite + opener + mode ─────────────────────────────────────────────
describe('ensureSuperChannel via the "…" summon — a first summon with NO existing channel', () => {
  it('creates <chat>-super (Rodz + the summoner, type group, no inline messageText) and ALIASES it to the conversation', async () => {
    const { cmds, calls, getState } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…'), 'super');

    expect(calls.create).toHaveLength(1);
    const c = calls.create[0];
    expect(c.title).toBe(SUPER_TITLE);
    expect(c.type).toBe('group');
    expect(c.participantIDs).toEqual([RODZ_USER_ID, SUMMONER]);   // Rodz + the summoner
    expect(c.accountID).toBe('whatsapp');
    expect('messageText' in c).toBe(false);

    const st = getState();
    const primaryJid = getContact(st, 'whatsapp', C_CHAT).jid;
    // THE /join alias kind PLUS the one marker chunk 2 adds — { aliasOf, transcript, super: true }.
    // `super: true` is what the reply path (gate + routing) keys on; /join never carries it.
    expect(st.contacts.whatsapp[SUPER_CHAT]).toEqual({ aliasOf: primaryJid, transcript: sanitizeSlug(SUPER_TITLE), super: true });
    expect(aliasTargetOf(st, 'whatsapp', SUPER_CHAT)).toBe(primaryJid);
    expect(getContact(st, 'whatsapp', SUPER_CHAT).slug).toBe(getContact(st, 'whatsapp', C_CHAT).slug);   // shared folder/thread
  });

  it('posts config.super.opener ONCE, FROM the secondary, into the secondary room, {chat}/{group} filled', async () => {
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…'), 'super');
    const expected = SUPER_OPENER_DEFAULT.replaceAll('{chat}', CHAT_TITLE).replaceAll('{group}', CHAT_TITLE);
    expect(calls.resolveTitle).toEqual([{ title: SUPER_TITLE, opts: { accountID: 'whatsapp' } }]);
    expect(calls.post).toEqual([{ chatId: SEC_SUPER_ROOM, text: expected, replyToMessageID: null, via: 'secondary' }]);
  });

  it('stores NO mode on summon (CHUNK 2): the origin\'s stored mode is UNCHANGED, the resident thread is intact (the channel\'s mode is intrinsic, read live at the gate)', async () => {
    const { cmds, getState } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…'), 'super');
    const st = getState();
    // Summoning must mutate NO stored mode — the old chunk-1 patchBeing flipped the SHARED entry
    // (and never reverted on /end). The seed set no mode, so it stays unset (null) on both surfaces.
    expect(getBeing(st, 'whatsapp', C_CHAT, 'e').mode).toBeNull();       // origin mode UNCHANGED
    expect(getBeing(st, 'whatsapp', SUPER_CHAT, 'e').mode).toBeNull();   // alias resolves through → same (none)
    expect(getBeing(st, 'whatsapp', C_CHAT, 'e').threadId).toBe('src-e-thread');   // resident thread intact
  });

  it('without a summoner id, invites only Rodz', async () => {
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…', { senderId: undefined }), 'super');
    expect(calls.create[0].participantIDs).toEqual([RODZ_USER_ID]);
  });

  // The live bug (2026-10-09): the operator in a 1:1 summons as a MATRIX id (@anrodriguez:beeper.com),
  // which the whatsapp createGroup rejects (M_INVALID_PARAM) — the whole channel aborted, nothing posted.
  // A non-surface-native summoner must be DROPPED (createGroup handed ONLY valid ids), channel still
  // created + aliased + opener posted. FAILS pre-fix (the bad id passes through → createGroup 400s/aborts).
  it('a MATRIX-form summoner (@…:beeper.com) is DROPPED; the channel still creates + aliases + posts the opener', async () => {
    const OWNER_MATRIX = '@anrodriguez:beeper.com';
    const { cmds, calls, getState } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…', { senderId: OWNER_MATRIX }), 'super');

    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].participantIDs).toEqual([RODZ_USER_ID]);   // ONLY Rodz — the bad id dropped, NOT passed through
    const st = getState();
    const primaryJid = getContact(st, 'whatsapp', C_CHAT).jid;
    expect(st.contacts.whatsapp[SUPER_CHAT]).toEqual({ aliasOf: primaryJid, transcript: sanitizeSlug(SUPER_TITLE), super: true });
    expect(aliasTargetOf(st, 'whatsapp', SUPER_CHAT)).toBe(primaryJid);
    expect(calls.post).toHaveLength(1);                               // opener still posted
    expect(calls.post[0].via).toBe('secondary');
  });

  // Companion: a surface-native summoner id (@…:beeper.local) IS included (so a real counterparty reads E's reply).
  it('a surface-valid summoner id (@…:beeper.local) IS invited', async () => {
    const COUNTERPARTY = '@whatsapp_lid-99887766:beeper.local';
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…', { senderId: COUNTERPARTY }), 'super');
    expect(calls.create[0].participantIDs).toEqual([RODZ_USER_ID, COUNTERPARTY]);
  });
});

// ── 1:1: invite the COUNTERPARTY, whoever summoned (operator 2026-10-10) ──────────────────────────────
// In a 1:1 the super group must invite the OTHER party so they can read E's reply — regardless of who
// summoned. chatOtherPartyId resolves that counterparty; it overrides the summoner. A group answers null
// (no single "other party") so the summoner stays the invitee, exactly as before.
describe('ensureSuperChannel in a 1:1 — the COUNTERPARTY is invited regardless of summoner', () => {
  const COUNTERPARTY = '@whatsapp_lid-99887766:beeper.local';

  it('the OPERATOR summons as a matrix id (@…:beeper.com) — the counterparty is invited, not dropped to only-Rodz', async () => {
    const { cmds, calls } = harness({ config: cfg(), chatOtherPartyId: async () => COUNTERPARTY });
    await cmds.runPhrase(inbound('…', { senderId: '@anrodriguez:beeper.com' }), 'super');
    expect(calls.create[0].participantIDs).toEqual([RODZ_USER_ID, COUNTERPARTY]);
  });

  it('the COUNTERPARTY summons — invited ONCE, no duplicate', async () => {
    const { cmds, calls } = harness({ config: cfg(), chatOtherPartyId: async () => COUNTERPARTY });
    await cmds.runPhrase(inbound('…', { senderId: COUNTERPARTY }), 'super');
    expect(calls.create[0].participantIDs).toEqual([RODZ_USER_ID, COUNTERPARTY]);
  });

  it('no 1:1 counterparty and no group roster → the summoner is invited, unchanged', async () => {
    const SUMMONER_LOCAL = '@whatsapp_lid-summoner42:beeper.local';
    const { cmds, calls } = harness({ config: cfg(), chatOtherPartyId: async () => null });
    await cmds.runPhrase(inbound('…', { senderId: SUMMONER_LOCAL }), 'super');
    expect(calls.create[0].participantIDs).toEqual([RODZ_USER_ID, SUMMONER_LOCAL]);
  });
});

// ── GROUP: invite the origin group's members (reve 2026-10-11 14:26:51, SPOILER ALERT) ────────────────
// Live: "super: SPOILER ALERT: chat de EyAy -> channel j7084… aliased to UuY6…, invited (none)" — the
// summoner was the operator (a @…:beeper.com id, dropped) and a group has no single other party. Members
// can only be set at createGroup, so the group's own roster (the primary's view) is the invite list,
// minus every config.beeper account (the operator creates it; Rodz is added as the mouth).
describe('ensureSuperChannel from a GROUP — the origin group\'s members are invited at creation', () => {
  const H1 = '@whatsapp_lid-111:beeper.local';
  const H2 = '@whatsapp_lid-222:beeper.local';
  const GROUP_ROSTER = { type: 'group', participants: { items: [
    { id: '@anrodriguez:beeper.com', isSelf: true },
    { id: RODZ_USER_ID, phoneNumber: RODZ, isSelf: false },
    { id: H1, phoneNumber: '+34667928959', isSelf: false },
    { id: H2, isSelf: false },                                                    // no phone (LID-only member)
    { id: '@whatsapp_lid-999:beeper.local', phoneNumber: AN, isSelf: false },    // the operator's own puppet
  ] } };
  const chatRaw = async (id) => (id === C_CHAT ? GROUP_ROSTER : LIVE_ROSTER);

  it('the operator summons in a group → createGroup carries Rodz + every human member, and the log names them', async () => {
    const { cmds, calls, logs } = harness({ config: cfg(), chatRaw });
    await cmds.runPhrase(inbound('…', { senderId: '@anrodriguez:beeper.com' }), 'super');
    expect(calls.create[0].participantIDs).toEqual([RODZ_USER_ID, H1, H2]);
    expect(logs.find((l) => /aliased to/.test(l))).toMatch(new RegExp(`invited ${H1}, ${H2}$`));
  });

  it('a member summons → still the whole roster, the summoner not duplicated', async () => {
    const { cmds, calls } = harness({ config: cfg(), chatRaw });
    await cmds.runPhrase(inbound('…', { senderId: H1 }), 'super');
    expect(calls.create[0].participantIDs).toEqual([RODZ_USER_ID, H1, H2]);
  });
});

// ── reuse: a second "…" when the channel already exists ──────────────────────────────────────────────
describe('ensureSuperChannel — an existing channel is REUSED', () => {
  it('a second "…" does NOT re-create and does NOT post a duplicate opener', async () => {
    const { cmds, calls } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…'), 'super');
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create).toHaveLength(1);   // reused, not re-created
    expect(calls.post).toHaveLength(1);     // no duplicate opener
  });
});

// ── liveness: a stale super alias is dropped and replaced (reve 2026-10-10, Reencuentro pjcOWW…) ──────
// The operator LEFT the -super room: the primary's GET 404s (chatRaw → false) and Rodz's view has only
// Rodz. The alias stayed `super: true`, so every summon logged "already exists … reusing" and replies
// kept routing into the dead room. Only a DEFINITE answer kills it; a failed read keeps it.
describe('ensureSuperChannel — reuse only a LIVE channel', () => {
  const STALE = 'pjcOWWstale';
  const NEW_FULL = '!chatSuperNew:beeper.local';
  const stateWithStaleSuper = () => {
    const st = seedState();
    return aliasContact(st, 'whatsapp', STALE, getContact(st, 'whatsapp', C_CHAT).jid, { transcript: sanitizeSlug(SUPER_TITLE), super: true });
  };
  const SELF_AND_RODZ_ONLY = { participants: { items: LIVE_ROSTER.participants.items.slice(0, 2) } };
  const RODZ_ONLY = { participants: { items: LIVE_ROSTER.participants.items.slice(1, 2) } };

  for (const [why, chatRaw] of [['the primary 404s (chatRaw → false)', async () => false], ['the roster holds only our mouth account', async () => RODZ_ONLY]]) {
    it(`${why} → the stale alias is dropped and a NEW channel is created + aliased`, async () => {
      const { cmds, calls, getState } = harness({ config: cfg(), state: stateWithStaleSuper(), chatRaw, createdChatIds: [NEW_FULL] });
      await cmds.runPhrase(inbound('…'), 'super');
      expect(calls.chatRaw).toEqual([STALE, C_CHAT]);   // liveness of the stale channel, then the origin's roster (invitees)
      expect(calls.create).toHaveLength(1);
      const st = getState();
      expect(st.contacts.whatsapp[STALE]).toBeUndefined();
      expect(superChannelFor(st, 'whatsapp', C_CHAT)).toBe(shortChatId(NEW_FULL));
      expect(calls.post).toHaveLength(1);   // the new channel's opener
    });
  }

  for (const [why, chatRaw] of [
    ['a channel with a human still in it', async () => LIVE_ROSTER],
    ['an operator-only room (self + Rodz — the operator is a human)', async () => SELF_AND_RODZ_ONLY],
    ['a failed read (chatRaw → null, UNKNOWN)', async () => null],
  ]) {
    it(`${why} is reused (no create, alias kept)`, async () => {
      const { cmds, calls, getState } = harness({ config: cfg(), state: stateWithStaleSuper(), chatRaw });
      await cmds.runPhrase(inbound('…'), 'super');
      expect(calls.create).toHaveLength(0);
      expect(superChannelFor(getState(), 'whatsapp', C_CHAT)).toBe(STALE);
    });
  }

  it('a failed read logs ONE line saying liveness is unknown', async () => {
    const { cmds, logs } = harness({ config: cfg(), state: stateWithStaleSuper(), chatRaw: async () => null });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(logs.filter((l) => /unknown/i.test(l))).toHaveLength(1);
  });
});

// ── unique title: a re-summon after /end must not reuse the old group's title (reve 2026-10-10 09:10) ──
// 08:42 channel TstFyzz created, 08:55 /end dropped it (archived, still on the primary), 09:10 a new
// summon created pjcOWW under the SAME title and the opener's by-title lookup on Rodz's side landed in
// the OLD group (no1QNPs) — the new channel stayed empty.
describe('ensureSuperChannel — the title is made unique (the /join uniqueTitle)', () => {
  it('summon → /end → summon: distinct titles, and the second opener lands in the NEW group', async () => {
    const FIXED = () => new Date(2026, 9, 10, 9, 10, 0).getTime();   // → " 0910-10102026"
    const SECOND_FULL = '!chatSuper2:beeper.local';
    const onPrimary = new Set();
    const OLD_SEC = '!no1QNPs', NEW_SEC = '!secSuper2';
    const { cmds, calls } = harness({
      config: cfg(), now: FIXED, createdChatIds: [SUPER_CHAT_FULL, SECOND_FULL],
      resolvePrimaryChatIdByTitle: (title) => (onPrimary.has(title) ? '!onPrimary' : null),
      resolveSecondaryChatIdByTitle: (title) => (title === SUPER_TITLE ? OLD_SEC : NEW_SEC),
    });
    await cmds.runPhrase(inbound('…'), 'super');
    onPrimary.add(calls.create[0].title);                                  // the ended group stays on the primary
    await cmds.run({ chatId: SUPER_CHAT, surface: 'whatsapp', msgId: 'end1', body: '/end' });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create.map((c) => c.title)).toEqual([SUPER_TITLE, `${SUPER_TITLE} 0910-10102026`]);
    expect(calls.post.map((p) => p.chatId)).toEqual([OLD_SEC, NEW_SEC]);
  });
});

// ── /end closes a super channel through the /join alias path ─────────────────────────────────────────
describe('/end in a super channel', () => {
  it('archives it and drops the alias — replies revert to the main chat', async () => {
    const { cmds, calls, getState } = harness({ config: cfg() });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(superChannelFor(getState(), 'whatsapp', C_CHAT)).toBe(SUPER_CHAT);
    await cmds.run({ chatId: SUPER_CHAT, surface: 'whatsapp', msgId: 'end1', body: '/end' });
    expect(calls.archive).toEqual([SUPER_CHAT]);
    expect(getState().contacts.whatsapp[SUPER_CHAT]).toBeUndefined();
    expect(superChannelFor(getState(), 'whatsapp', C_CHAT)).toBe(null);
  });
});

// ── config: suffix/opener overrides, and NO stored mode whatever config.super.mode says ───────────────
// The mode is no longer stored on summon (CHUNK 2); its coercion (quoted vs YAML-boolean, invalid →
// default) is unit-tested as superModeOf in auto-mode.test.mjs and applied live at the gate in
// gating-dispatch.test.mjs. Here we only lock the create-time title/opener and that summon stores NOTHING.
describe('config.super — suffix / opener overrides, mode never stored', () => {
  it('config.super.suffix and config.super.opener override the built-in fallbacks', async () => {
    const { cmds, calls } = harness({ config: cfg({ superBlock: { ...ON, suffix: ' ⭐', opener: 'hola {chat}' } }) });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create[0].title).toBe(`${CHAT_TITLE} ⭐`);
    expect(calls.post[0].text).toBe(`hola ${CHAT_TITLE}`);
  });

  it('a configured mode (string, YAML-boolean, or invalid) still stores NOTHING — the mode is intrinsic', async () => {
    for (const mode of ['mute', true, false, 'bogus']) {
      const { cmds, getState } = harness({ config: cfg({ superBlock: { ...ON, mode } }) });
      await cmds.runPhrase(inbound('…'), 'super');
      expect(getBeing(getState(), 'whatsapp', C_CHAT, 'e').mode).toBeNull();       // origin never flipped
      expect(getBeing(getState(), 'whatsapp', SUPER_CHAT, 'e').mode).toBeNull();   // alias resolves through → same
    }
  });
});

// ── gates: node role, known conversation, Rodz ───────────────────────────────────────────────────────
describe('ensureSuperChannel — the create gates (like a nameless /join)', () => {
  it('SILENT on a non-primary-role node (both co-account nodes hear the "…"; only the primary creates)', async () => {
    const { cmds, calls, getState } = harness({ config: cfg({ node_role: 'secondary', node_name: 'do' }) });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create).toHaveLength(0);
    expect(aliasTargetOf(getState(), 'whatsapp', SUPER_CHAT)).toBe(null);
  });

  it('an UNKNOWN conversation (nothing to alias) creates nothing', async () => {
    const { cmds, calls } = harness({ config: cfg(), state: { contacts: {} } });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create).toHaveLength(0);
  });

  it('Rodz unresolvable → creates nothing', async () => {
    const { cmds, calls } = harness({ config: cfg(), rodzUserId: null });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create).toHaveLength(0);
  });
});

// ── /agents mode IN an alias room sets THAT room's mode (reve 2026-10-11 14:28/14:30, SPOILER ALERT) ──
// Live: `/agents mode accum all` and `/agents mode accum e` typed IN the super channel j7084… answered
// "✅ … mode here → accum", wrote `mode: accum` onto the ORIGIN UuY6…'s agents, and E kept gating `on`
// in the super channel. "mode here" is the room it was typed in: the alias entry's own per-being mode,
// else (super) config.super.mode, else (/join) the origin's.
describe('/agents mode in an alias room — stored on the alias, read by the gate and by /agents', () => {
  const ORIGIN = 'UuY6K6ly3BV3Ye7QqIne';
  const SUPER_LIVE = 'j7084JKL7ZP7yjpcwCSJ';
  const JOIN_LIVE = 'joinRoom0000000000000';
  const TITLE = 'SPOILER ALERT: chat de EyAy';
  const SUPER_ALIAS = { aliasOf: ORIGIN, transcript: 'SPOILER ALERT chat de EyAy-super', super: true };
  const liveCfg = {
    ...cfg({ superBlock: { ...ON, mode: 'on' } }),
    agents: { egpt: { default: true, handles: ['e', 'egpt'] }, codex: { handles: ['c', 'codex'] }, ken: { handles: ['k', 'ken'] } },
  };
  const seed = () => {
    let st = ensureContact({ contacts: {} }, 'whatsapp', ORIGIN, { pushedName: TITLE }).state;
    for (const b of ['egpt', 'codex', 'ken']) st = recordThread(st, 'whatsapp', ORIGIN, `thr-${b}`, '2026-10-11T12:00:00Z', b);
    st = aliasContact(st, 'whatsapp', SUPER_LIVE, ORIGIN, { transcript: SUPER_ALIAS.transcript, super: true });
    return aliasContact(st, 'whatsapp', JOIN_LIVE, ORIGIN, { transcript: 'SPOILER-join' });
  };
  const at = (chatId, body) => ({ chatId, surface: 'whatsapp', chatName: TITLE, body });
  const live = (state = seed()) => harness({ config: liveCfg, state, defaultKey: 'egpt' });
  const gateMode = async (st, chatId) => (await createGating({ getConfig: () => liveCfg, loadState: async () => st, defaultKey: 'egpt' })
    .decide('egpt', { surface: 'whatsapp', chatId, kind: 'message' })).mode;

  it('`/agents mode accum e` in the super channel writes the ALIAS entry and never the origin', async () => {
    const { cmds, sent, getState } = live();
    await cmds.run(at(SUPER_LIVE, '/agents mode accum e'));
    const st = getState();
    expect(sent.at(-1).text).toBe('✅ e (egpt) mode here → accum');
    expect(st.contacts.whatsapp[ORIGIN].agents.egpt.mode).toBeUndefined();
    expect(st.contacts.whatsapp[SUPER_LIVE]).toEqual({ ...SUPER_ALIAS, agents: { egpt: { mode: 'accum' } } });
  });

  it('`/agents mode accum force all` in the super channel: every resident on the alias, the origin untouched', async () => {
    const { cmds, getState } = live();
    await cmds.run(at(SUPER_LIVE, '/agents mode accum force all'));
    const st = getState();
    for (const b of ['egpt', 'codex', 'ken']) expect(st.contacts.whatsapp[ORIGIN].agents[b].mode).toBeUndefined();
    expect(st.contacts.whatsapp[SUPER_LIVE].agents).toEqual({ egpt: { mode: 'accum' }, codex: { mode: 'accum' }, ken: { mode: 'accum' } });
  });

  it('the GATE: the super channel runs super.mode until a mode is set there, then that mode; the origin keeps its own', async () => {
    const { cmds, getState } = live();
    expect(await gateMode(getState(), SUPER_LIVE)).toBe('on');
    await cmds.run(at(SUPER_LIVE, '/agents mode accum e'));
    expect(await gateMode(getState(), SUPER_LIVE)).toBe('accum');
    expect(await gateMode(getState(), ORIGIN)).toBe('mention');
  });

  it('`/agents e` in the super channel reports that room\'s effective mode', async () => {
    const { cmds, sent } = live();
    await cmds.run(at(SUPER_LIVE, '/agents e'));
    expect(sent.at(-1).text).toMatch(/^mode: on \(super\)$/m);
    await cmds.run(at(SUPER_LIVE, '/agents mode accum e'));
    await cmds.run(at(SUPER_LIVE, '/agents e'));
    expect(sent.at(-1).text).toMatch(/^mode: accum$/m);
  });

  it('a /join side-room inherits the origin\'s mode until one is set there; the set stays on the side-room', async () => {
    const { cmds, getState } = live(patchBeing(seed(), 'whatsapp', ORIGIN, 'egpt', { mode: 'mention-direct' }));
    expect(await gateMode(getState(), JOIN_LIVE)).toBe('mention-direct');
    await cmds.run(at(JOIN_LIVE, '/agents mode on e'));
    expect(await gateMode(getState(), JOIN_LIVE)).toBe('on');
    expect(await gateMode(getState(), ORIGIN)).toBe('mention-direct');
    expect(getState().contacts.whatsapp[ORIGIN].agents.egpt.mode).toBe('mention-direct');
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// SI CORE (operator 2026-10-13): auto-create-on-reply, create-on-the-EAR, the canary intro, peer-link.
// This EXTENDS the chunk-1/2 machinery — the SAME ensureSuperChannel/createAliasedSideGroup/postOpener/
// superChannelFor/aliasContact and the SAME node-signature TAGS encoder. No parallel path.
// ════════════════════════════════════════════════════════════════════════════════════════════════

// ── (1) AUTO-CREATE ON REPLY: gating.decide creates + routes when automatic is ON (PART B) ──────────
describe('SI core — auto-create on reply, gated on super_chats.automatic (PART B)', () => {
  const AUTO = { ...ON, automatic: true };
  // Gating wired WITH the create seam, reading/writing the SAME harness state. chatRaw → LIVE_ROSTER so
  // the just-created channel reads ALIVE and routing honours it (superChannelAlive).
  const mkGate = (h, superBlock = AUTO) => createGating({
    getConfig: () => cfg({ superBlock }),
    loadState: async () => h.getState(),
    defaultKey: 'e',
    chatRaw: async () => LIVE_ROSTER,
    ensureSuperChannel: (ev) => h.cmds.ensureSuperChannel(ev),
  });
  // A being ABOUT TO REPLY: an @mention (mode 'mention' ⇒ atEAnywhere wakes it) in the BASE chat.
  const replyEv = { chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE, kind: 'message', mention: { atEStart: true, atEAnywhere: true } };

  it('automatic ON: a being replies with NO channel → ensureSuperChannel CREATES it and the reply ROUTES there; a 2nd reply REUSES', async () => {
    const h = harness({ config: cfg({ superBlock: AUTO }) });
    const g = mkGate(h);
    const d1 = await g.decide('e', replyEv);
    expect(h.calls.create).toHaveLength(1);                  // auto-created through the EXISTING path
    expect(d1.replyChatId).toBe(SUPER_CHAT);                 // the reply routes to the just-created channel
    expect(superChannelFor(h.getState(), 'whatsapp', C_CHAT)).toBe(SUPER_CHAT);
    const d2 = await g.decide('e', replyEv);
    expect(h.calls.create).toHaveLength(1);                  // reused, not re-created
    expect(d2.replyChatId).toBe(SUPER_CHAT);
  });

  it('automatic OFF (default): on + reply + no channel → NO auto-create (siphon handles it, PART C)', async () => {
    const h = harness({ config: cfg({ superBlock: ON }) });   // automatic unset ⇒ false
    const g = mkGate(h, ON);
    await g.decide('e', replyEv);
    expect(h.calls.create).toHaveLength(0);                  // the automatic gate held
  });

  it('automatic ON but NOT about to reply (unmentioned in a mention chat) → no create, reply stays in base', async () => {
    const h = harness({ config: cfg({ superBlock: AUTO }) });
    const g = mkGate(h);
    const d = await g.decide('e', { chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE, kind: 'message', mention: {} });
    expect(d.mayReply).toBe(false);
    expect(h.calls.create).toHaveLength(0);
    expect(d.replyChatId).toBe(C_CHAT);
  });

  it('automatic ON + a backlog wake (would-reach-a-being check) never creates', async () => {
    const h = harness({ config: cfg({ superBlock: AUTO }) });
    const g = mkGate(h);
    await g.decide('e', { ...replyEv, backlog: true });
    expect(h.calls.create).toHaveLength(0);
  });

  it('SI DISABLED → decide never creates (even automatic:true), reply stays in base', async () => {
    const h = harness({ config: cfg({ superBlock: { triggers: [], automatic: true } }) });
    const g = mkGate(h, { triggers: [], automatic: true });
    const d = await g.decide('e', replyEv);
    expect(h.calls.create).toHaveLength(0);
    expect(d.replyChatId).toBe(C_CHAT);
  });

  it('REGRESSION: an EXISTING super alias but no trigger phrase → reply reverts to the base group (the IF gate)', async () => {
    const h = harness({ config: cfg({ superBlock: AUTO }) });
    const dOn = await mkGate(h, AUTO).decide('e', replyEv);          // SI on: auto-create + route to the side-room
    expect(dOn.replyChatId).toBe(SUPER_CHAT);
    expect(superChannelFor(h.getState(), 'whatsapp', C_CHAT)).toBe(SUPER_CHAT);   // alias now stored
    const dOff = await mkGate(h, { triggers: [] }).decide('e', replyEv);        // SI off: alias still stored
    expect(dOff.replyChatId).toBe(C_CHAT);                           // reply goes to the group, NOT the side-room
    expect(dOff.siReaction).toBe(null);
  });

  it('REGRESSION: ensureSuperChannel UNWIRED (standalone gating) is a no-op', async () => {
    const h = harness({ config: cfg({ superBlock: AUTO }) });
    const g = createGating({ getConfig: () => cfg({ superBlock: AUTO }), loadState: async () => h.getState(), defaultKey: 'e', chatRaw: async () => LIVE_ROSTER });  // no seam
    const d = await g.decide('e', replyEv);
    expect(h.calls.create).toHaveLength(0);
    expect(d.replyChatId).toBe(C_CHAT);
  });
});

// ── (2) CREATE ON THE EAR: works with NO secondary/mouth (the one-account baseline) ─────────────────
describe('SI core — create on the EAR (one-account baseline: no secondary/mouth)', () => {
  const baseCfg = (over = {}) => ({ beeper: { primary: { phone: AN } }, node_name: 'kg', node_role: 'primary', super_chats: ON, ...over });

  it('the create targets the EAR account (chatAccountId), NOT a resolveRodz-gated secondary', async () => {
    const { cmds, calls } = harness({ config: baseCfg() });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].accountID).toBe('whatsapp');       // the ear
  });

  it('no secondary configured → Rodz is NOT invited (only the summoner), and the opener still posts', async () => {
    const { cmds, calls } = harness({ config: baseCfg() });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create[0].participantIDs).toEqual([SUMMONER]);   // baseline: no mouth member
    expect(calls.resolve).toHaveLength(0);                       // secondary phone unset → never resolved
    expect(calls.post).toHaveLength(1);                          // the ear posts the opener
  });

  it('WITH a secondary, the EAR still creates AND Rodz is invited (chunk-1 behavior preserved)', async () => {
    const { cmds, calls } = harness({ config: cfg() });          // cfg() carries secondary
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create[0].accountID).toBe('whatsapp');
    expect(calls.create[0].participantIDs).toEqual([RODZ_USER_ID, SUMMONER]);
  });
});

// ── (3) THE CANARY INTRO: the base id rides an invisible frame; visible opener unchanged ────────────
describe('SI core — the intro carries the base id in a node-signature canary frame', () => {
  it('encode → decode round-trips the shared-account base id', () => {
    for (const base of [SUPER_CHAT, 'Abc123_xyz', 'a/b:weird', '26087681749235@lid']) {
      expect(decodeChatCanary(encodeChatCanary(base))).toBe(base);
    }
  });

  it('persona-wrap appends the canary BESIDE the node frame: peer decodes it, node attribution intact, VISIBLE TEXT UNCHANGED', () => {
    const wrap = makeWrapPersona({ nodeName: 'kg' });
    const opener = SUPER_OPENER_DEFAULT.replaceAll('{chat}', CHAT_TITLE).replaceAll('{group}', CHAT_TITLE);
    const out = wrap({ canary: C_CHAT }, opener);
    expect(decodeChatCanary(out)).toBe(C_CHAT);                 // the peer reads the base id
    expect(decodeNodeSignature(out)).toBe('kg');                // the FIRST frame is still the NODE — attribution intact
    expect(stripNodeSignature(out)).toBe(opener);               // every invisible frame strips → the plain opener
    expect(renderNodeSignature(out)).toBe(`${opener}<kg>`);     // the canary renders to NOTHING; only <kg> shows
  });

  it('a send with NO canary is unchanged (no extra frame, decode → null)', () => {
    const wrap = makeWrapPersona({ nodeName: 'kg' });
    const out = wrap({}, 'hola');
    expect(decodeChatCanary(out)).toBe(null);
    expect(renderNodeSignature(out)).toBe('hola<kg>');
  });
});

// ── (4) PEER-LINK: a canary intro links the SAME channel with no RPC (symmetric to auto-create) ─────
describe('SI core — peer-link from the intro canary', () => {
  // The intro as THIS (co-account) node receives it: in the side-group (full matrix id), carrying the
  // base chat's shared-account id in ev.canary, decoded by identity.build on the real path.
  const intro = (canary, extra = {}) => ({ chatId: SUPER_CHAT_FULL, surface: 'whatsapp', chatName: SUPER_TITLE, canary, body: '🌟 …', ...extra });

  it('an inbound SI-group message carrying the canary, with NO local alias, WRITES the super alias; superChannelFor then returns it', async () => {
    const { cmds, getState } = harness({ config: cfg() });
    const primaryJid = getContact(getState(), 'whatsapp', C_CHAT).jid;
    await cmds.linkSuperChannel(intro(primaryJid));
    const st = getState();
    // SAME alias shape the creating node writes ({ aliasOf, transcript, super:true }).
    expect(st.contacts.whatsapp[SUPER_CHAT]).toEqual({ aliasOf: primaryJid, transcript: sanitizeSlug(SUPER_TITLE), super: true });
    expect(superChannelFor(st, 'whatsapp', C_CHAT)).toBe(SUPER_CHAT);
  });

  it('idempotent: a re-sight of an already-linked channel writes nothing new', async () => {
    const { cmds, getState } = harness({ config: cfg() });
    const primaryJid = getContact(getState(), 'whatsapp', C_CHAT).jid;
    await cmds.linkSuperChannel(intro(primaryJid));
    const before = getState().contacts.whatsapp[SUPER_CHAT];
    await cmds.linkSuperChannel(intro(primaryJid));
    expect(getState().contacts.whatsapp[SUPER_CHAT]).toEqual(before);
  });

  it('no canary → nothing linked', async () => {
    const { cmds, getState } = harness({ config: cfg() });
    await cmds.linkSuperChannel(intro(null));
    expect(getState().contacts.whatsapp[SUPER_CHAT]).toBeUndefined();
  });

  it('SI disabled → nothing linked even with a canary', async () => {
    const { cmds, getState } = harness({ config: cfg({ superBlock: { triggers: [] } }) });
    const primaryJid = getContact(getState(), 'whatsapp', C_CHAT).jid;
    await cmds.linkSuperChannel(intro(primaryJid));
    expect(getState().contacts.whatsapp[SUPER_CHAT]).toBeUndefined();
  });

  it('a canary for a base conversation this node does NOT know → not linked (logged, no throw)', async () => {
    const { cmds, getState } = harness({ config: cfg() });
    await cmds.linkSuperChannel(intro('!unknownBase'));
    expect(getState().contacts.whatsapp[SUPER_CHAT]).toBeUndefined();
  });
});

// ── (5) PART C — SIPHON to admin: automatic OFF + no channel ⇒ the reply goes to eGPT Admin ──────────
describe('SI PART C — siphonReplyToAdmin (automatic off, no channel): reply to admin, base chat clean', () => {
  const OFF = ON;                                         // automatic unset ⇒ false

  it('returns the admin chat id (so gating routes the reply THERE) and posts the warning once per chat', async () => {
    const { cmds, adminPosts } = harness({ config: cfg({ superBlock: OFF }) });
    const ev = { chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE };
    expect(await cmds.siphonReplyToAdmin(ev)).toBe(ADMIN_CHAT);   // the reply is routed to eGPT Admin
    expect(adminPosts).toHaveLength(1);                           // warning posted once
    expect(adminPosts[0]).toMatch(/super_chats.*enabled.*no SI channel.*automatic is off/i);
    expect(adminPosts[0]).toContain(CHAT_TITLE);                  // names the chat
    // RATE-LIMIT: a second reply still routes to admin, but the blurb is NOT repeated.
    expect(await cmds.siphonReplyToAdmin(ev)).toBe(ADMIN_CHAT);
    expect(adminPosts).toHaveLength(1);
  });

  it('the warning names the first trigger phrase', async () => {
    const { cmds, adminPosts } = harness({ config: cfg({ superBlock: { triggers: ['', ' SI chat ', 'abre SI'] } }) });
    await cmds.siphonReplyToAdmin({ chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE });
    expect(adminPosts[0]).toContain('send "SI chat" in that chat');
  });

  it('admin_channel UNRESOLVABLE → returns null (gating falls back to the base chat), nothing posted', async () => {
    const { cmds, adminPosts } = harness({ config: cfg({ superBlock: OFF }), adminChatId: null });
    expect(await cmds.siphonReplyToAdmin({ chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE })).toBe(null);
    expect(adminPosts).toHaveLength(0);
  });

  // THE WIRED ROUTING through gating.decide: automatic off + no channel + reply ⇒ replyChatId = admin,
  // never the base chat; the siphon seam is what gating calls.
  it('gating routes the reply to admin (not the base chat) when automatic is off and there is no channel', async () => {
    const h = harness({ config: cfg({ superBlock: OFF }) });
    const g = createGating({
      getConfig: () => cfg({ superBlock: OFF }),
      loadState: async () => h.getState(),
      defaultKey: 'e',
      chatRaw: async () => LIVE_ROSTER,
      ensureSuperChannel: (ev) => h.cmds.ensureSuperChannel(ev),
      siphonReplyToAdmin: (ev) => h.cmds.siphonReplyToAdmin(ev),
    });
    const d = await g.decide('e', { chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE, kind: 'message', mention: { atEAnywhere: true } });
    expect(d.replyChatId).toBe(ADMIN_CHAT);                  // reply siphoned to admin
    expect(h.calls.create).toHaveLength(0);                  // NOT auto-created (automatic off)
    expect(h.adminPosts).toHaveLength(1);                    // warning posted
  });

  it('automatic ON ⇒ NO siphon (it auto-creates instead); a channel that EXISTS ⇒ NO siphon', async () => {
    // automatic ON: the create branch runs, siphon never called.
    const h1 = harness({ config: cfg({ superBlock: { ...ON, automatic: true } }) });
    const g1 = createGating({ getConfig: () => cfg({ superBlock: { ...ON, automatic: true } }), loadState: async () => h1.getState(), defaultKey: 'e', chatRaw: async () => LIVE_ROSTER, ensureSuperChannel: (ev) => h1.cmds.ensureSuperChannel(ev), siphonReplyToAdmin: (ev) => h1.cmds.siphonReplyToAdmin(ev) });
    const d1 = await g1.decide('e', { chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE, kind: 'message', mention: { atEAnywhere: true } });
    expect(d1.replyChatId).toBe(SUPER_CHAT);
    expect(h1.adminPosts).toHaveLength(0);
    // a channel already exists: routing goes to it (chunk 2), siphon never called.
    const withChan = aliasContact(seedState(), 'whatsapp', SUPER_CHAT, getContact(seedState(), 'whatsapp', C_CHAT).jid, { transcript: 'x', super: true });
    const h2 = harness({ config: cfg({ superBlock: OFF }), state: withChan });
    const g2 = createGating({ getConfig: () => cfg({ superBlock: OFF }), loadState: async () => h2.getState(), defaultKey: 'e', chatRaw: async () => LIVE_ROSTER, siphonReplyToAdmin: (ev) => h2.cmds.siphonReplyToAdmin(ev) });
    const d2 = await g2.decide('e', { chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE, kind: 'message', mention: { atEAnywhere: true } });
    expect(d2.replyChatId).toBe(SUPER_CHAT);
    expect(h2.adminPosts).toHaveLength(0);
  });
});

// ── (6) PART D — the ACCESS GATE: a non-member of an existing SI group does not wake the bot ─────────
describe('SI PART D — superMemberGate (membership of an existing SI channel)', () => {
  const MEMBER = SUMMONER;                                  // in LIVE_ROSTER (phone +34667928959)
  const OUTSIDER = '@whatsapp_lid-leftuser:beeper.local';   // NOT in LIVE_ROSTER
  // A conversation that already HAS a super channel (SUPER_CHAT), whose live roster is LIVE_ROSTER.
  const withChannel = () => aliasContact(seedState(), 'whatsapp', SUPER_CHAT, getContact(seedState(), 'whatsapp', C_CHAT).jid, { transcript: sanitizeSlug(SUPER_TITLE), super: true });
  const at = (senderId, extra = {}) => ({ chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE, senderId, ...extra });
  const inSuper = (senderId, extra = {}) => ({ chatId: SUPER_CHAT, surface: 'whatsapp', chatName: SUPER_TITLE, senderId, ...extra });
  const OPERATOR = '@anrodriguez:beeper.com';               // the own account — the isSelf entry in LIVE_ROSTER

  it('a NON-member trigger → BLOCKED (returns true) + the fixed reply to the chat they triggered from', async () => {
    const { cmds, sent } = harness({ config: cfg(), state: withChannel() });
    expect(await cmds.superMemberGate(at(OUTSIDER))).toBe(true);
    expect(sent).toEqual([{ chatId: C_CHAT, text: 'User must be member of SI group to interact with it.' }]);
  });

  it('rate-limit: a second non-member trigger is still blocked but does NOT repeat the reply', async () => {
    const { cmds, sent } = harness({ config: cfg(), state: withChannel() });
    await cmds.superMemberGate(at(OUTSIDER));
    expect(await cmds.superMemberGate(at(OUTSIDER))).toBe(true);
    expect(sent).toHaveLength(1);
  });

  it('a CURRENT member → NOT blocked (returns false), nothing posted', async () => {
    const { cmds, sent } = harness({ config: cfg(), state: withChannel() });
    expect(await cmds.superMemberGate(at(MEMBER))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('NO channel → no gate (returns false), nothing posted', async () => {
    const { cmds, sent } = harness({ config: cfg() });        // seedState has no super alias
    expect(await cmds.superMemberGate(at(OUTSIDER))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('SI disabled → no gate even with a channel', async () => {
    const { cmds, sent } = harness({ config: cfg({ superBlock: { triggers: [] } }), state: withChannel() });
    expect(await cmds.superMemberGate(at(OUTSIDER))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('roster unreadable (chatRaw → false) → fail-open (returns false), nothing posted', async () => {
    const { cmds, sent } = harness({ config: cfg(), state: withChannel(), chatRaw: async () => false });
    expect(await cmds.superMemberGate(at(OUTSIDER))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // ── PROD BUG FIXES (2026-10-13) ───────────────────────────────────────────────────────────────────
  // FIX A — a message that ARRIVED IN the SI group is NEVER gated (the sender posts there ⇒ a member).
  // RED before the fix: superChannelFor is self-referential in-group, and an outsider id fails the
  // roster match, so the old gate BLOCKED Diego + the operator posting inside the -super group.
  it('FIX A — ANY sender posting INSIDE the SI group is NOT blocked, no warning (even an id not in the roster)', async () => {
    const { cmds, sent } = harness({ config: cfg(), state: withChannel() });
    expect(await cmds.superMemberGate(inSuper(OUTSIDER))).toBe(false);   // posting in the group ⇒ a member
    expect(await cmds.superMemberGate(inSuper(MEMBER))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // FIX B — the OPERATOR (own account) is always a member: its roster entry is isSelf, and its
  // @…:beeper.com id must match it. RED before the fix: the old `!p?.isSelf` filter excluded that entry,
  // so the operator could never pass — blocked from a BASE chat.
  it('FIX B — the operator (a :beeper.com id matching the isSelf roster entry) is NOT blocked from the base chat', async () => {
    const { cmds, sent } = harness({ config: cfg(), state: withChannel() });
    expect(await cmds.superMemberGate(at(OPERATOR))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('FIX B — the operator is NOT blocked in the SI group either (fix A covers it, fix B is the base-chat half)', async () => {
    const { cmds, sent } = harness({ config: cfg(), state: withChannel() });
    expect(await cmds.superMemberGate(inSuper(OPERATOR))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  it('FIX B — the account owner by provenance (ev.isSender) is NOT blocked, whatever id form it arrives as', async () => {
    const { cmds, sent } = harness({ config: cfg(), state: withChannel() });
    expect(await cmds.superMemberGate(at(OUTSIDER, { isSender: true }))).toBe(false);
    expect(sent).toHaveLength(0);
  });

  // REGRESSION LOCK — the gate STILL works for its real purpose: a genuine non-member @mentioning from
  // the BASE chat (not in the SI roster, not isSelf, not isSender) is still blocked.
  it('REGRESSION — a genuine non-member triggering from the BASE chat is STILL blocked', async () => {
    const { cmds, sent } = harness({ config: cfg(), state: withChannel() });
    expect(await cmds.superMemberGate(at(OUTSIDER))).toBe(true);
    expect(sent).toEqual([{ chatId: C_CHAT, text: 'User must be member of SI group to interact with it.' }]);
  });
});

// ── (7) THE ✓/❌ SI-STATE REACTION — decide resolves which emoji; the spine places it (end-to-end below) ──
describe('SI — the ✓/❌ state reaction decision (gating.decide → d.siReaction)', () => {
  const withChannel = () => aliasContact(seedState(), 'whatsapp', SUPER_CHAT, getContact(seedState(), 'whatsapp', C_CHAT).jid, { transcript: 'x', super: true });
  const gate = (st, superBlock) => createGating({ getConfig: () => cfg({ superBlock }), loadState: async () => st, defaultKey: 'e', chatRaw: async () => LIVE_ROSTER });
  const replyEv = { chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE, kind: 'message', mention: { atEAnywhere: true } };

  it('a channel EXISTS (superChannelFor set) → ✅', async () => {
    expect((await gate(withChannel(), ON).decide('e', replyEv)).siReaction).toBe('✅');
  });

  it('on + NO channel → ❌', async () => {
    expect((await gate(seedState(), ON).decide('e', replyEv)).siReaction).toBe('❌');
  });

  // PROD FIX (2026-10-13): a message arriving IN the SI channel gets NO auto-reaction — not ✅, not ❌.
  // Everyone in the group is already a member; there is nothing to signal. The ✅/❌ is a BASE-chat signal.
  it('a message arriving IN the SI channel → NO reaction (null), neither ✅ nor ❌', async () => {
    const inSuperEv = { chatId: SUPER_CHAT, surface: 'whatsapp', chatName: SUPER_TITLE, kind: 'message', mention: { atEAnywhere: true } };
    expect((await gate(withChannel(), ON).decide('e', inSuperEv)).siReaction).toBe(null);
  });

  it('a channel AUTO-CREATED this turn (automatic on) → ✅ (superId is set after the create)', async () => {
    const h = harness({ config: cfg({ superBlock: { ...ON, automatic: true } }) });
    const g = createGating({ getConfig: () => cfg({ superBlock: { ...ON, automatic: true } }), loadState: async () => h.getState(), defaultKey: 'e', chatRaw: async () => LIVE_ROSTER, ensureSuperChannel: (ev) => h.cmds.ensureSuperChannel(ev) });
    expect((await g.decide('e', replyEv)).siReaction).toBe('✅');
  });

  it('SI DISABLED → no reaction (null)', async () => {
    expect((await gate(withChannel(), { triggers: [] }).decide('e', replyEv)).siReaction).toBe(null);
  });

  it('a being that is NOT about to reply (unmentioned in a mention chat) → no reaction (null)', async () => {
    expect((await gate(withChannel(), ON).decide('e', { ...replyEv, mention: {} })).siReaction).toBe(null);
  });
});

// ── (8) SI OFF (no trigger phrase) — today's disabled behaviour everywhere (operator 2026-10-18) ──────
describe('SI OFF — no phrase: no summon, siphon, member gate, SI reaction, auto-create or peer-link', () => {
  const OUTSIDER = '@whatsapp_lid-leftuser:beeper.local';   // NOT in LIVE_ROSTER
  const withChannel = () => aliasContact(seedState(), 'whatsapp', SUPER_CHAT, getContact(seedState(), 'whatsapp', C_CHAT).jid, { transcript: sanitizeSlug(SUPER_TITLE), super: true });
  const replyEv = { chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE, kind: 'message', senderId: OUTSIDER, mention: { atEAnywhere: true } };
  const shapes = OFF_SHAPES.flatMap((s) => [true, false].map((automatic) => (s === null ? null : { ...s, automatic })));

  it('decide: the reply stays in the base chat, no ✅/❌, nothing created or siphoned, with or without a channel', async () => {
    for (const superBlock of shapes) {
      for (const state of [seedState(), withChannel()]) {
        const h = harness({ config: cfg({ superBlock }), state });
        const g = createGating({
          getConfig: () => cfg({ superBlock }), loadState: async () => h.getState(), defaultKey: 'e', chatRaw: async () => LIVE_ROSTER,
          ensureSuperChannel: (ev) => h.cmds.ensureSuperChannel(ev), siphonReplyToAdmin: (ev) => h.cmds.siphonReplyToAdmin(ev),
        });
        const d = await g.decide('e', replyEv);
        expect(d.mayReply).toBe(true);
        expect(d.replyChatId).toBe(C_CHAT);
        expect(d.siReaction).toBe(null);
        expect(h.calls.create).toHaveLength(0);
        expect(h.adminPosts).toHaveLength(0);
      }
    }
  });

  it('no member gate on an existing channel, and a canary intro links nothing', async () => {
    for (const superBlock of shapes) {
      const h = harness({ config: cfg({ superBlock }), state: withChannel() });
      expect(await h.cmds.superMemberGate(replyEv)).toBe(false);
      expect(h.sent).toHaveLength(0);
      const h2 = harness({ config: cfg({ superBlock }) });
      await h2.cmds.linkSuperChannel({ chatId: SUPER_CHAT_FULL, surface: 'whatsapp', chatName: SUPER_TITLE, canary: getContact(h2.getState(), 'whatsapp', C_CHAT).jid, body: '🌟 …' });
      expect(h2.getState().contacts.whatsapp[SUPER_CHAT]).toBeUndefined();
    }
  });
});
