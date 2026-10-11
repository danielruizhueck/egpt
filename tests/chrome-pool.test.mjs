// tests/chrome-pool.test.mjs — the PURE launch-admission decision + the browser-group lookup for the
// per-profile Chrome pool (plans/2610091931 chunk 2, rev 2026-10-11). No Chrome, no OS, no fs, no clock: every
// measurement is a plain number fed in, so the same inputs always give the same answer — the
// operator's "deterministic estimate as if to launch a new one".
import { describe, it, expect } from 'vitest';
import { join, basename } from 'node:path';
import { estimateChromeBytes, admitLaunch, chromeConversationOf, MB } from '../src/spine/chrome-pool.mjs';

describe('admitLaunch() — the pure memory-admission table', () => {
  // A fixed frame: a 500 MB estimate, a 1024 MB margin. available is what varies.
  const estimateBytes = 500 * MB;
  const marginBytes = 1024 * MB;
  const at = (availableMb, extra = {}) => admitLaunch({ availableBytes: availableMb * MB, estimateBytes, marginBytes, ...extra });

  it('LAUNCHES when available - estimate is well above the margin', () => {
    const d = at(4096);   // 4096 - 500 = 3596 free >= 1024
    expect(d).toMatchObject({ ok: true, action: 'launch' });
  });

  it('LAUNCHES at the EXACT boundary (available - estimate === margin admits — the test is >=)', () => {
    const d = at(1524);   // 1524 - 500 = 1024 === margin
    expect(d).toMatchObject({ ok: true, action: 'launch' });
  });

  it('does NOT launch one byte below the boundary', () => {
    const d = admitLaunch({ availableBytes: 1524 * MB - 1, estimateBytes, marginBytes, canEvict: false });
    expect(d.ok).toBe(false);
    expect(d.action).toBe('decline');
  });

  it('below the margin WITH something idle to evict → action evict (caller frees room and retries)', () => {
    const d = at(1000, { canEvict: true });   // 1000 - 500 = 500 < 1024
    expect(d).toMatchObject({ ok: false, action: 'evict' });
  });

  it('below the margin with NOTHING to evict → action decline', () => {
    const d = at(1000, { canEvict: false });
    expect(d).toMatchObject({ ok: false, action: 'decline' });
  });

  it('every decision carries a human reason', () => {
    expect(at(4096).reason).toMatch(/fits/i);
    expect(at(1000, { canEvict: true }).reason).toMatch(/evict/i);
    expect(at(1000, { canEvict: false }).reason).toMatch(/margin/i);
  });
});

describe('estimateChromeBytes() — deterministic per-Chrome cost', () => {
  const floorBytes = 500 * MB;

  it('is the MAX of the measured running RSS when any Chrome is running', () => {
    expect(estimateChromeBytes({ runningRssBytes: [300 * MB, 700 * MB, 450 * MB], floorBytes }))
      .toBe(700 * MB);
  });

  it('falls back to the configured floor when NO Chrome is running (nothing to measure)', () => {
    expect(estimateChromeBytes({ runningRssBytes: [], floorBytes })).toBe(floorBytes);
  });

  it('drops non-positive / non-finite samples (an unreadable RSS is unknown, not 0 bytes)', () => {
    expect(estimateChromeBytes({ runningRssBytes: [null, NaN, 0, -5, 620 * MB], floorBytes }))
      .toBe(620 * MB);
    // all samples unusable → floor
    expect(estimateChromeBytes({ runningRssBytes: [null, 0, NaN], floorBytes })).toBe(floorBytes);
  });

  it('is deterministic: the same samples always give the same number', () => {
    const samples = [310 * MB, 512 * MB];
    const a = estimateChromeBytes({ runningRssBytes: samples, floorBytes });
    const b = estimateChromeBytes({ runningRssBytes: samples, floorBytes });
    expect(a).toBe(b);
    expect(a).toBe(512 * MB);
  });
});

// config/browsers.yaml's `groups:` map, as rooms-file.readBrowserGroups returns it.
const GROUPS = { brain: ['eGPT Admin', 'eGPT Rodz Lulu An'] };

describe('chromeConversationOf() — entry + browsers.yaml groups → { key, name, group }', () => {
  it('a chat listed under brain → brain (both operator-named chats)', () => {
    const admin = { conversation_path: '.egpt/conversations/whatsapp/eGPT Admin-2601010000', pushedName: 'eGPT Admin' };
    expect(chromeConversationOf(admin, GROUPS)).toEqual({ key: 'eGPT Admin-2601010000', name: 'eGPT Admin', group: 'brain' });
    expect(chromeConversationOf({ slug: 'rla-1', pushedName: 'eGPT Rodz Lulu An' }, GROUPS).group).toBe('brain');
  });

  it('an unlisted chat → shared', () => {
    const entry = { conversation_path: '.egpt/conversations/whatsapp/Reinie Alvino-2607150057', pushedName: 'Reinie Alvino', slug: 'reinie-x' };
    expect(chromeConversationOf(entry, GROUPS)).toEqual({ key: 'Reinie Alvino-2607150057', name: 'Reinie Alvino', group: 'shared' });
  });

  it('no browsers.yaml (empty map) → every chat is shared, eGPT Admin included', () => {
    expect(chromeConversationOf({ pushedName: 'eGPT Admin' }, {}).group).toBe('shared');
  });

  it('a chat in TWO groups → no group (no browser), with the reason; never a silent pick', () => {
    const d = chromeConversationOf({ pushedName: 'eGPT Admin' }, { brain: ['eGPT Admin'], work: ['eGPT Admin'] });
    expect(d.group).toBe(null);
    expect(d.why).toMatch(/brain, work/);
  });

  it('a group name that is not a safe single path segment → no group', () => {
    for (const bad of ['../brain', 'a/b', 'a\\b', '..', 'CON', ' brain', 'x:y']) {
      const d = chromeConversationOf({ pushedName: 'Diego' }, { [bad]: ['Diego'] });
      expect(d.group, bad).toBe(null);
      expect(d.why, bad).toMatch(/not a safe/);
    }
  });

  it('a nameless chat matches no listed member (an empty "" entry included) → shared', () => {
    expect(chromeConversationOf({ slug: 'x-1' }, { brain: [''] }).group).toBe('shared');
  });

  it('key falls back to entry.slug; a backslash conversation_path still yields the dir name', () => {
    expect(chromeConversationOf({ slug: 'diego-2605201243', pushedName: 'Diego' }, {}).key).toBe('diego-2605201243');
    const entry = { conversation_path: 'C:\\Users\\an\\.egpt\\conversations\\whatsapp\\Grp-2601010000', pushedName: 'Grp' };
    expect(chromeConversationOf(entry, {}).key).toBe('Grp-2601010000');
  });

  it('empty entry → shared (no throw)', () => {
    expect(chromeConversationOf()).toEqual({ key: '', name: '', group: 'shared' });
  });
});
