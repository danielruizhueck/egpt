// gating.mjs — the §2c gating service: resolve a being's per-CONVERSATION policy
// (mode + send_to_egpt, both read from conversations.yaml — the per-conversation
// home, operator 2026-06-30) and turn it into the loop's decisions. The
// mode→decision LOGIC is the kept, test-locked auto-mode.mjs; this service only
// resolves WHICH mode/policy applies and packages the per-message decision:
//
//   decide(being, ev, mention?)  -> { mode, receives, mayReply, sendToEgpt }   (ONE conv-state read)
//   surfaces(decision, replyText)-> boolean    POST-brain: mayReply + the 'on'-'...' silence cosmetic
//
// `mode` resolves down ONE chain, most specific first (operator 2026-07-25):
//   conversations.yaml  <conv>.agents.<name>.mode   per-conversation override (an alias room's own first)
//   conversations.yaml  <conv>.<name>.mode          per-conversation block    (getBeing reads both)
//   config.yaml         agents.<name>.mode          the AGENT's own default
//   config.yaml         dispatch.auto_default_mode  node-wide (persona; legacy whatsapp.auto_e_default)
//   built-in            'mention'
// `sendToEgpt` is the conversation's `<being>.send_to_egpt` override, else the global
// config default (dispatch.send_to_egpt, legacy whatsapp.send_to_egpt), else 'mode'. The
// absolute kill is dispatch.auto_paused (legacy whatsapp.auto_e_paused). The routing globals
// moved OUT of the whatsapp transport block into `dispatch:` (operator 2026-06-25 —
// E is a sibling, not a network); the whatsapp.* reads stay as back-compat fallbacks
// so an un-migrated config is a no-op. The old config.auto_modes route is GONE —
// modes live in the agents registry + conversations.yaml.
import { getBeing, isSuperChannel, superChannelFor } from '../conversations-state.mjs';
import { receives, replyAllowed, mayEmitChat, isSilenceReply, isAutoMode, DEFAULT_AUTO_MODE, superModeOf } from '../auto-mode.mjs';

const _send = (v) => (v === 'always' || v === 'mode') ? v : null;

// The mode an agent takes when its conversation says nothing. PER-AGENT FIRST (operator
// 2026-07-25: "better to have in config.yaml the configuration per agent on its mode"): an
// agent may declare its own default as `agents.<name>.mode` in the SAME registry entry that
// already carries its configuration/handles/relay_channel — that is what lets @don be
// mention-direct while @e is mention in the very same chat. Keyed lowercase, boot's own
// convention for that map. Below it (phase 2, operator 2026-08-14: "remove the concept of
// siblings" — every being's un-configured default gate resolves the SAME way now, no more
// being === defaultKey branch): the node's dispatch.auto_default_mode (legacy
// whatsapp.auto_e_default), falling back to DEFAULT_AUTO_MODE ('mention') when that's also
// unset — which is today's ultimate fallback for every being anyway, so this is a no-op for
// a node that never configured auto_default_mode.
//
// THE MODE A BEING RUNS UNDER, and which tier set it: the conversation's own mode when it names a
// real one, else that ladder. Exported (operator 2026-09-24) so the room's config.readonly.yaml
// states the mode decide() uses, and where it came from, without a second copy of this order.
// `bv` is getBeing's view of the conversation (only `.mode` is read), null for "none".
export function resolveMode(bv, being, c = {}) {
  if (isAutoMode(bv?.mode)) return { mode: bv.mode, source: 'conversation' };
  const own = c.agents?.[String(being ?? '').toLowerCase()]?.mode;
  if (isAutoMode(own)) return { mode: own, source: 'agent' };
  const def = c.dispatch?.auto_default_mode ?? c.whatsapp?.auto_e_default;
  return isAutoMode(def) ? { mode: def, source: 'node' } : { mode: DEFAULT_AUTO_MODE, source: 'default' };
}

// Is super channel `chatId` still read by a human? true | false (DEFINITE: the GET 404'd, or the roster
// holds only our mouth accounts) | null (unknown — keep using it). The operator counts as a human; a
// mouth is any config.beeper phone other than the primary's. Shared by ensureSuperChannel and decide.
export async function superChannelAlive(chatId, { chatRaw, config = {} }) {
  const raw = await chatRaw(chatId);
  if (raw === false) return false;
  const items = raw?.participants?.items;
  if (!Array.isArray(items)) return null;
  const digits = (v) => String(v ?? '').replace(/\D/g, '');
  const operator = digits(config.beeper?.primary?.phone);
  const mouths = new Set(Object.values(config.beeper ?? {}).map((a) => digits(a?.phone)).filter((d) => d && d !== operator));
  return items.some((p) => !mouths.has(digits(p?.phoneNumber)));
}

export function createGating({ getConfig = () => ({}), loadState = null, defaultKey = 'e', chatRaw = async () => null, ensureSuperChannel = null, siphonReplyToAdmin = null } = {}) {
  const cfg = () => getConfig() ?? {};

  // The single per-message decision. ONE conversations.yaml read resolves the conversation's
  // mode + send_to_egpt AND the two super-channel facts the reply path needs (CHUNK 2), so there
  // is still exactly one state load per message. `mention` is passed explicitly by the loop (it's
  // the ROUTED being's mention — a sibling routed by its own @name is mentioned for ITS gate, not
  // @e's); default to ev.mention for direct callers.
  async function decide(being, ev, mention = ev.mention) {
    const c = cfg();
    let state = null;
    if (loadState) { try { state = await loadState(); } catch { state = null; } }
    let bv = null;
    if (state) { try { bv = getBeing(state, ev.surface, ev.chatId, being); } catch { bv = null; } }
    let { mode, source } = resolveMode(bv, being, c);
    // Did this message ARRIVE IN a super channel? (an SI group is an alias carrying super:true.) Read
    // once — it drives both the per-surface mode gate AND the ✅ reaction (we ARE in an SI channel).
    const inSuper = !!(state && isSuperChannel(state, ev.surface, ev.chatId));
    // PER-SURFACE SUPER GATE (operator 2026-10-08, CHUNK 2): a message that ARRIVED in a super
    // channel is gated by config.super_chats.mode, NOT the origin's stored mode — unless `/agents mode`
    // was set IN that channel (stored on its alias entry, getBeing's room mode; operator
    // 2026-10-11). /end drops the alias, so it reverts for free.
    if (source !== 'conversation' && inSuper) mode = superModeOf(c.super_chats?.mode);
    const paused = !!(c.dispatch?.auto_paused ?? c.whatsapp?.auto_e_paused);
    const allowed = replyAllowed(mode, mention ?? {});
    const mayReply = mayEmitChat({ paused, mode, replyAllowed: allowed, isReaction: ev.kind === 'reaction' });
    // send_to_egpt keeps the persona in a chat's context even when it won't reply — that's a
    // persona concern. A sibling is an engineer, not a context-follower: it runs ONLY when it
    // may reply, so force 'mode' for any non-persona being (never 'always').
    const sendToEgpt = being !== defaultKey
      ? 'mode'
      : (_send(bv?.send_to_egpt) ?? _send(c.dispatch?.send_to_egpt) ?? _send(c.whatsapp?.send_to_egpt) ?? 'mode');
    // REPLY ROUTING (operator 2026-10-08, CHUNK 2): when this conversation HAS a super channel
    // right now, the reply is posted THERE instead of the main chat (the Mouth "pinned" to the
    // super channel). LIVE lookup off the same state read — /end drops the alias, so this reverts
    // to the arrival chat automatically with no un-pin to undo. No super channel, or a DEFINITELY dead
    // one (superChannelAlive → false) → ev.chatId.
    let superId = state && superChannelFor(state, ev.surface, ev.chatId);
    let replyChatId = null;   // resolved below (siphon may set it first)
    // SI ON-REPLY, NO CHANNEL YET (super_chats.enabled + a being ABOUT TO REPLY + !backlog):
    //   · automatic ON  → AUTO-CREATE through the EXISTING ensureSuperChannel (node-role gate,
    //     idempotency, invite-the-members, AND the canary intro the peer links from), then re-resolve
    //     off a FRESH read → the reply routes to the just-created channel (the chunk-2 line below).
    //   · automatic OFF → SIPHON the reply to admin_channel (eGPT Admin) so the base chat stays clean
    //     (the SI principle); siphonReplyToAdmin returns that chat id (and posts a rate-limited warning
    //     + recovery blurb), or null when admin is unresolvable → fall through to the base chat.
    // Skipped for a backlog wake (wouldReachABeing reuses decide but dispatches nothing). A create
    // failure NEVER blocks the reply. Both seams unwired (standalone gating/tests) → inert.
    if (!superId && mayReply && !ev.backlog && c.super_chats?.enabled) {
      if (c.super_chats?.automatic && ensureSuperChannel) {
        try {
          await ensureSuperChannel(ev);
          const s2 = loadState ? await loadState() : null;
          if (s2) { state = s2; superId = superChannelFor(s2, ev.surface, ev.chatId); }
        } catch { /* create failed — fall through to the arrival chat, same as no channel */ }
      } else if (!c.super_chats?.automatic && siphonReplyToAdmin) {
        try { replyChatId = (await siphonReplyToAdmin(ev)) ?? null; } catch { replyChatId = null; }
      }
    }
    if (replyChatId == null) replyChatId = (superId && (await superChannelAlive(superId, { chatRaw, config: c })) !== false) ? superId : ev.chatId;
    // SI-STATE REACTION (2026-10-13): a BASE-CHAT signal only — ✅ this conversation HAS an SI channel
    // (superChannelFor set, incl. one auto-created above → the reply routed to SI), ❌ none (reply went
    // to the base chat / was siphoned to admin). INSIDE an SI group there is nothing to signal — everyone
    // is already a member — so NO auto-reaction (inSuper → null); the being may place its own if it wishes.
    // null also when SI is off or the being isn't replying.
    const siReaction = (mayReply && c.super_chats?.enabled && !inSuper) ? (superId ? '✅' : '❌') : null;
    return { mode, receives: receives(mode), mayReply, sendToEgpt, replyChatId, siReaction };
  }

  // POST-brain surfacing: the reply surfaces when mayReply held AND it isn't an
  // 'on'-mode '...' silence (E free to post but declining to add noise — recorded,
  // not surfaced). Every other mode is already fully decided by mayReply.
  function surfaces(decision, replyText) {
    if (!decision?.mayReply) return false;
    // 'auto' gates like 'on' — its free-post silence ('…') is likewise recorded, not surfaced.
    return !((decision.mode === 'on' || decision.mode === 'auto') && isSilenceReply(replyText));
  }

  return { decide, surfaces };
}
