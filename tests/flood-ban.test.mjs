// flood-ban.test.mjs — the media-flood auto-ban (src/flood-ban.mjs). A sender who dumps a
// burst of media (GIFs/stickers/images, "a whatsapp virus") into one chat is muted for a
// cooldown so NOTHING of theirs enters the accumulator or hits disk; the ban lifts lazily.
// Injected `now` drives the sliding window, the same style as guard-rate-repetition.test.mjs.
import { describe, it, expect } from 'vitest';
import { createFloodBan } from '../src/flood-ban.mjs';

const S = 'whatsapp', CH = 'chat-1';
const media = (senderName = 'Flooder', chatName = 'La Familia') => ({ isMedia: true, senderName, chatName });
const text = (senderName = 'Flooder', chatName = 'La Familia') => ({ isMedia: false, senderName, chatName });

describe('flood-ban: a media burst from one sender auto-mutes them', () => {
  it('`count` media within window → A banned; the NEXT message (media OR text) reports banned, notice once', () => {
    let t = 0;
    const notices = [];
    const fb = createFloodBan({ count: 5, windowMs: 20_000, cooldownMs: 600_000, now: () => t, onLog: (m) => notices.push(m) });
    let last;
    for (let i = 0; i < 5; i++) { t += 2_000; last = fb.observe(S, CH, 'A', media()); }
    expect(last).toEqual({ banned: true, justBanned: true });          // the 5th tips it
    expect(fb.isBanned(S, CH, 'A')).toBe(true);
    // the next media is banned, and so is the next plain text
    t += 2_000;
    expect(fb.observe(S, CH, 'A', media())).toEqual({ banned: true, justBanned: false });
    expect(fb.observe(S, CH, 'A', text())).toEqual({ banned: true, justBanned: false });
    expect(notices.filter((m) => /^flood-ban: /.test(m))).toHaveLength(1);   // exactly one ban notice
    expect(notices[0]).toMatch(/flood-ban: Flooder in La Familia — 5 media in 20s, muted 10m/);
  });

  it('A\'s plain TEXT during the cooldown is dropped (banned) too', () => {
    let t = 0;
    const fb = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, now: () => t });
    for (let i = 0; i < 3; i++) { t += 1_000; fb.observe(S, CH, 'A', media()); }
    expect(fb.isBanned(S, CH, 'A')).toBe(true);
    t += 5 * 60_000;   // well within the 10-min cooldown
    expect(fb.isBanned(S, CH, 'A')).toBe(true);
    expect(fb.observe(S, CH, 'A', text()).banned).toBe(true);
  });

  it('after cooldownMs the ban lifts (lazy), with a lift notice', () => {
    let t = 0;
    const notices = [];
    const fb = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, now: () => t, onLog: (m) => notices.push(m) });
    for (let i = 0; i < 3; i++) { t += 1_000; fb.observe(S, CH, 'A', media()); }
    expect(fb.isBanned(S, CH, 'A')).toBe(true);
    t += 600_001;   // past the cooldown
    expect(fb.isBanned(S, CH, 'A')).toBe(false);
    expect(notices.some((m) => /^flood-ban lifted: Flooder in La Familia/.test(m))).toBe(true);
  });

  it('a slow drip never bans — fewer than count, or media spread beyond the window', () => {
    let t = 0;
    const slow = createFloodBan({ count: 5, windowMs: 20_000, cooldownMs: 600_000, now: () => t });
    // count-1 media, fast → not enough
    for (let i = 0; i < 4; i++) { t += 1_000; expect(slow.observe(S, CH, 'A', media()).banned).toBe(false); }
    expect(slow.isBanned(S, CH, 'A')).toBe(false);

    // 5 media but each > windowMs apart → the window never holds `count` at once
    let u = 0;
    const drip = createFloodBan({ count: 5, windowMs: 20_000, cooldownMs: 600_000, now: () => u });
    for (let i = 0; i < 5; i++) { u += 25_000; expect(drip.observe(S, CH, 'A', media()).banned).toBe(false); }
    expect(drip.isBanned(S, CH, 'A')).toBe(false);
  });

  it('a DIFFERENT sender B is unaffected while A is banned', () => {
    let t = 0;
    const fb = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, now: () => t });
    for (let i = 0; i < 3; i++) { t += 1_000; fb.observe(S, CH, 'A', media('A')); }
    expect(fb.isBanned(S, CH, 'A')).toBe(true);
    expect(fb.isBanned(S, CH, 'B')).toBe(false);
    // B may flood media of its own without A's ban touching it
    t += 1_000; expect(fb.observe(S, CH, 'B', media('B')).banned).toBe(false);
    expect(fb.isBanned(S, CH, 'B')).toBe(false);
  });

  it('a never_ban sender never bans even while flooding (matched by id OR display name)', () => {
    let t = 0;
    const byId = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, neverBan: ['op-id'], now: () => t });
    for (let i = 0; i < 6; i++) { t += 1_000; expect(byId.observe(S, CH, 'op-id', media('Operator')).banned).toBe(false); }
    expect(byId.isBanned(S, CH, 'op-id')).toBe(false);

    let u = 0;
    const byName = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, neverBan: ['Operator'], now: () => u });
    for (let i = 0; i < 6; i++) { u += 1_000; expect(byName.observe(S, CH, 'xyz', media('Operator')).banned).toBe(false); }
    expect(byName.isBanned(S, CH, 'xyz')).toBe(false);
  });

  it('unban() lifts the ban early; list() reports active bans; unban by name filters', () => {
    let t = 0;
    const fb = createFloodBan({ count: 3, windowMs: 20_000, cooldownMs: 600_000, now: () => t });
    for (let i = 0; i < 3; i++) { t += 1_000; fb.observe(S, CH, 'A', media('Alice')); }
    for (let i = 0; i < 3; i++) { t += 1_000; fb.observe(S, CH, 'B', media('Bob')); }
    expect(fb.list().map((b) => b.senderName).sort()).toEqual(['Alice', 'Bob']);

    // name filter clears only the match
    expect(fb.unban(S, CH, 'Alice')).toBe(1);
    expect(fb.isBanned(S, CH, 'A')).toBe(false);
    expect(fb.isBanned(S, CH, 'B')).toBe(true);

    // bare unban clears the rest in this chat
    expect(fb.unban(S, CH)).toBe(1);
    expect(fb.isBanned(S, CH, 'B')).toBe(false);
    expect(fb.list()).toEqual([]);
  });

  it('count <= 0 disables the whole guard', () => {
    let t = 0;
    const off = createFloodBan({ count: 0, windowMs: 20_000, cooldownMs: 600_000, now: () => t });
    for (let i = 0; i < 10; i++) { t += 100; off.observe(S, CH, 'A', media()); }
    expect(off.isBanned(S, CH, 'A')).toBe(false);
  });
});
