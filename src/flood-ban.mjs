// flood-ban.mjs — auto-mute a sender who dumps a BURST OF MEDIA into one chat (the
// "whatsapp virus": GIFs/stickers/images that pollute E's accumulated context and bloat
// the chat's media/ folder). A single sender posting >= `count` media attachments inside
// `windowMs`, in one (surface, chatId), is BANNED for `cooldownMs`. The bridge consults
// this BEFORE it saves or dispatches: while banned, EVERY message of that sender in that
// chat — media AND plain text — is dropped before persistMedia + onIncoming, so nothing of
// theirs reaches disk or the spine. The ban lifts LAZILY on the next observe/isBanned past
// the cooldown (no timer). In-memory per (surface, chatId, senderId): a restart re-arms
// detection, exactly like stop-guard.mjs. `neverBan` (match senderId OR display name) is
// exempt. Modeled on src/stop-guard.mjs — injected `now`, directly unit-testable.

const SEP = '\u0000';
const KEY = (surface, chatId, senderId) => `${surface}${SEP}${chatId}${SEP}${senderId}`;
const lc = (x) => String(x ?? '').toLowerCase();

export function createFloodBan({
  count = 5, windowMs = 20_000, cooldownMs = 600_000,
  neverBan = [], now = () => Date.now(), onLog = () => {},
} = {}) {
  const hits = new Map();   // key -> [t,...] recent MEDIA timestamps (the sliding window)
  const bans = new Map();   // key -> { until, senderName, chatName }
  const never = new Set(neverBan.map(lc).filter(Boolean));

  const isNever = (senderId, senderName) => never.has(lc(senderId)) || never.has(lc(senderName));

  // Lazily expire a stale ban, emitting the lift notice once. Returns whether still banned.
  function live(key) {
    const b = bans.get(key);
    if (!b) return false;
    if (now() >= b.until) {
      bans.delete(key);
      onLog(`flood-ban lifted: ${b.senderName} in ${b.chatName}`);
      return false;
    }
    return true;
  }

  return {
    isBanned(surface, chatId, senderId) { return live(KEY(surface, chatId, senderId)); },

    // Record one inbound message; transition into banned when media crosses `count` in
    // `windowMs`. Only MEDIA advances the window; a non-media turn is a no-op on the count.
    observe(surface, chatId, senderId, { isMedia = false, senderName = '', chatName = '' } = {}) {
      const key = KEY(surface, chatId, senderId);
      if (live(key)) return { banned: true, justBanned: false };
      if (!(count > 0)) return { banned: false, justBanned: false };       // disabled
      if (!isMedia) return { banned: false, justBanned: false };
      if (isNever(senderId, senderName)) return { banned: false, justBanned: false };
      const t = now();
      const arr = (hits.get(key) || []).filter((x) => t - x < windowMs);
      arr.push(t);
      if (arr.length >= count) {
        hits.delete(key);
        bans.set(key, { until: t + cooldownMs, senderName: String(senderName || senderId), chatName: String(chatName || chatId) });
        onLog(`flood-ban: ${senderName || senderId} in ${chatName || chatId} — ${arr.length} media in ${Math.round(windowMs / 1000)}s, muted ${Math.round(cooldownMs / 60_000)}m`);
        return { banned: true, justBanned: true };
      }
      hits.set(key, arr);
      return { banned: false, justBanned: false };
    },

    // A ban decided by a caller rather than the media counter (commands.mjs: the /agents flood).
    // Same mute, cooldown, never_ban, /bans and /unban. Returns whether the sender is banned now.
    ban(surface, chatId, senderId, { reason = 'flood', senderName = '', chatName = '' } = {}) {
      if (isNever(senderId, senderName)) return false;
      const key = KEY(surface, chatId, senderId);
      if (live(key)) return true;
      hits.delete(key);
      bans.set(key, { until: now() + cooldownMs, senderName: String(senderName || senderId), chatName: String(chatName || chatId), reason });
      onLog(`flood-ban: ${senderName || senderId} in ${chatName || chatId} — ${reason}, muted ${Math.round(cooldownMs / 60_000)}m`);
      return true;
    },

    // Clear active ban(s) in a (surface, chatId); optional name filter matches senderId OR
    // display name (case-insensitive). Returns how many were cleared.
    unban(surface, chatId, senderName) {
      const want = senderName != null && String(senderName).trim() !== '' ? lc(senderName) : null;
      let n = 0;
      for (const [key, b] of [...bans]) {
        const [s, c, sid] = key.split(SEP);
        if (s !== surface || c !== chatId) continue;
        if (want != null && lc(b.senderName) !== want && lc(sid) !== want) continue;
        bans.delete(key); hits.delete(key); n++;
        onLog(`flood-ban cleared: ${b.senderName} in ${b.chatName}`);
      }
      return n;
    },

    // Active bans (for /bans), stale ones expired first.
    list() {
      const out = [];
      for (const key of [...bans.keys()]) {
        if (!live(key)) continue;
        const b = bans.get(key);
        const [surface, chatId, senderId] = key.split(SEP);
        out.push({ surface, chatId, senderId, senderName: b.senderName, chatName: b.chatName, until: b.until, ...(b.reason ? { reason: b.reason } : {}) });
      }
      return out;
    },
  };
}
