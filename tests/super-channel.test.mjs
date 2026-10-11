// tests/super-channel.test.mjs — the SUPER CHANNEL, CHUNK 1 (operator 2026-10-08).
//
// A super channel is the SAME KIND of thing as a /join side-room: an ALIAS of the original
// conversation (shares its folder/thread/transcript — conversations-state aliasOf), NOT a /split
// diverging copy. Chunk 1 builds its config + lifecycle + the manual "…" summon; it does NOT yet
// reroute any replies (chunk 2) or implement respect-exit / mention-reinvite (chunk 3).
//
// WHAT THIS LOCKS:
//   · an inbound "…"/"..." from ANY participant (not operator-only), when config.super.enabled,
//     summons the channel through the EXISTING phraseCommand → runPhrase path;
//   · a first summon CREATES <chat>-super, ALIASES it to the conversation (same alias kind /join
//     writes), INVITES Rodz + the summoner, posts config.super.opener ONCE, and sets the channel's
//     auto-mode to config.super.mode;
//   · a second summon REUSES it (no re-create, no duplicate opener);
//   · super disabled/unset ⇒ the "…" is ordinary chat (phraseCommand returns null);
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
const SUPER_TITLE = `${CHAT_TITLE}${SUPER_SUFFIX_DEFAULT}`;   // 'Proyecto X-super'

function cfg({ superBlock = { enabled: true }, node_role = 'primary', node_name = 'kg' } = {}) {
  return {
    beeper: { primary: { phone: AN }, secondary: { phone: RODZ } },
    node_name, node_role,
    ...(superBlock === null ? {} : { super: superBlock }),
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

function harness({ config, state, resolveSecondaryChatIdByTitle = () => SEC_SUPER_ROOM, rodzUserId = RODZ_USER_ID, chatOtherPartyId = async () => null, chatRaw = async () => LIVE_ROSTER, resolvePrimaryChatIdByTitle = null, createdChatIds = null, now = null, defaultKey = 'e' } = {}) {
  let st = state ?? seedState();
  const sent = [];
  const logs = [];
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
    onLog: (m) => logs.push(m),
  });
  return { cmds, sent, logs, calls, getState: () => st };
}

// An INBOUND message (no `authorized`/`isSender`, chat is not a configured Self-DM ⇒ NOT operator).
const inbound = (body = '…', extra = {}) => ({ chatId: C_CHAT, surface: 'whatsapp', chatName: CHAT_TITLE, senderId: SUMMONER, body, ...extra });

// ── the "…" trigger: ANY sender, gated only on super.enabled ───────────────────────────────────────
describe('phraseCommand — the "…" super summon is any-sender and super.enabled-gated', () => {
  it('an inbound "…"/"..." from a NON-operator returns "super" when super.enabled (trim-tolerant)', () => {
    const { cmds } = harness({ config: cfg() });
    expect(cmds.phraseCommand(inbound('…'))).toBe('super');
    expect(cmds.phraseCommand(inbound('...'))).toBe('super');
    expect(cmds.phraseCommand(inbound('  …  '))).toBe('super');   // whole trimmed body
    expect(cmds.phraseCommand(inbound('……'))).toBe('super');      // a run of ellipsis
  });

  it('super disabled OR unset ⇒ an inbound "…" does NOTHING special (falls through as ordinary chat)', () => {
    expect(harness({ config: cfg({ superBlock: { enabled: false } }) }).cmds.phraseCommand(inbound('…'))).toBe(null);
    expect(harness({ config: cfg({ superBlock: null }) }).cmds.phraseCommand(inbound('…'))).toBe(null);
  });

  it('only a WHOLE deliberate-silence body triggers (never prefix/contains)', () => {
    const { cmds } = harness({ config: cfg() });
    expect(cmds.phraseCommand(inbound('hola'))).toBe(null);
    expect(cmds.phraseCommand(inbound('… y algo más'))).toBe(null);
    expect(cmds.phraseCommand(inbound('..'))).toBe(null);   // two dots is not the silence shape (needs 3+)
  });
});

// ── config.super.triggers: the summon PHRASE is configurable, still ANY-SENDER (operator 2026-10-08) ──
// A non-empty config.super.triggers LIST replaces the "…"/"..." default with EXACT whole-message
// phrases — the SAME matching the operator join/split/send/end triggers use, but ANY-SENDER (the super
// summon is never operator-gated). UNSET / empty ⇒ the deliberate-silence default, byte-for-byte as before.
describe('phraseCommand — config.super.triggers makes the summon phrase configurable', () => {
  const withTriggers = (triggers, enabled = true) => cfg({ superBlock: { enabled, triggers } });

  it('triggers UNSET ⇒ the "…"/"..." default still summons (any-sender preserved)', () => {
    const { cmds } = harness({ config: cfg() });              // super.enabled, NO triggers key
    expect(cmds.phraseCommand(inbound('…'))).toBe('super');
    expect(cmds.phraseCommand(inbound('...'))).toBe('super');
  });

  it('triggers=["beep"] ⇒ a whole-message "beep" (any case, trim-tolerant) summons; "…" no longer does', () => {
    const { cmds } = harness({ config: withTriggers(['beep']) });
    expect(cmds.phraseCommand(inbound('beep'))).toBe('super');
    expect(cmds.phraseCommand(inbound('BEEP'))).toBe('super');     // case-insensitive
    expect(cmds.phraseCommand(inbound('  Beep  '))).toBe('super'); // whole TRIMMED body
    expect(cmds.phraseCommand(inbound('…'))).toBe(null);           // the default is REPLACED, not added
  });

  it('EXACT whole-message only — prefix / contains / typo do NOT summon', () => {
    const { cmds } = harness({ config: withTriggers(['beep']) });
    expect(cmds.phraseCommand(inbound('beeep'))).toBe(null);   // typo
    expect(cmds.phraseCommand(inbound('say beep'))).toBe(null);
    expect(cmds.phraseCommand(inbound('beep now'))).toBe(null);
  });

  it('an EMPTY triggers list falls back to the "…" default (not "match nothing")', () => {
    const { cmds } = harness({ config: withTriggers([]) });
    expect(cmds.phraseCommand(inbound('…'))).toBe('super');
  });

  it('triggers set but super.enabled FALSE ⇒ nothing summons', () => {
    const { cmds } = harness({ config: withTriggers(['beep'], false) });
    expect(cmds.phraseCommand(inbound('beep'))).toBe(null);
    expect(cmds.phraseCommand(inbound('…'))).toBe(null);
  });

  it('a configured trigger from a NON-operator summons (ANY-SENDER, unlike the fork triggers)', () => {
    const { cmds } = harness({ config: withTriggers(['beep']) });
    // inbound() is a plain participant (SUMMONER), never the operator — it still fires.
    expect(cmds.phraseCommand(inbound('beep'))).toBe('super');
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
    const { cmds, calls } = harness({ config: cfg({ superBlock: { enabled: true, suffix: ' ⭐', opener: 'hola {chat}' } }) });
    await cmds.runPhrase(inbound('…'), 'super');
    expect(calls.create[0].title).toBe(`${CHAT_TITLE} ⭐`);
    expect(calls.post[0].text).toBe(`hola ${CHAT_TITLE}`);
  });

  it('a configured mode (string, YAML-boolean, or invalid) still stores NOTHING — the mode is intrinsic', async () => {
    for (const mode of ['mute', true, false, 'bogus']) {
      const { cmds, getState } = harness({ config: cfg({ superBlock: { enabled: true, mode } }) });
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
    ...cfg({ superBlock: { enabled: true, mode: 'on' } }),
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
