// 0041 — the actions card names /transcribe. The fixture is the card as a node carried it after 0031,
// in both line endings; the migrated card must equal the repo's.
import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { plan, VERB, PARAGRAPH } from '../migrations/0041-the-actions-card-says-transcribe-goes-to-dolly.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';
import { ACTION_VERBS } from '../src/spine/reply-actions.mjs';

const OLD = [
  '# Actions',
  '',
  'Each on its own line:',
  '',
  '    /react #<id> <emoji>',
  '    /reply #<id> <text>',
  '    /media <path> [caption]',
  '    /edit #<id> <text>',
  '',
  'Messages carry their id as `#<id>`. `/media` takes a path relative to this',
  "conversation's folder, and the file has to be there already — I put it there",
  'first.',
  '',
  'A `/reply` runs on to my next action or the end, so it can hold paragraphs and',
  'lists. My plain words go before my actions.',
  '',
];
const lf = (lines) => lines.join('\n');
const crlf = (lines) => lines.join('\r\n');
const REPO_CARD = join(import.meta.dirname, '..', 'config', 'skeletons', 'room', '10-actions.md');

function home({ card = lf(OLD) } = {}) {
  const h = join(mkdtempSync(join(tmpdir(), 'egpt-0041-')), '.egpt');
  mkdirSync(join(h, 'config', 'skeletons', 'room'), { recursive: true });
  if (card != null) writeFileSync(join(h, 'config', 'skeletons', 'room', '10-actions.md'), card);
  return h;
}
const cardPath = (h) => join(h, 'config', 'skeletons', 'room', '10-actions.md');
const baks = (h) => readdirSync(join(h, 'config', 'skeletons', 'room')).filter((f) => f.includes('.bak-'));
const ctxFor = (h) => ({ egptHome: h, log: () => {}, backup: (f) => { const to = `${f}.bak-0041-test`; writeFileSync(to, readFileSync(f)); return to; } });

describe('0041 — the actions card names /transcribe', () => {
  it('REPRODUCE: a node\'s card does not name it, so a being runs its own speech model', async () => {
    const h = home();
    expect(readFileSync(cardPath(h), 'utf8')).not.toContain('/transcribe');
    expect((await plan(ctxFor(h))).satisfied).toBe(false);
  });

  it('adds the verb after the last action line and the paragraph at the end: the card becomes the repo\'s', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(readFileSync(REPO_CARD, 'utf8'));
    expect(baks(h)).toEqual(['10-actions.md.bak-0041-test']);
  });

  it('keeps a CRLF card CRLF', async () => {
    const h = home({ card: crlf(OLD) });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(readFileSync(REPO_CARD, 'utf8').replace(/\n/g, '\r\n'));
  });

  it('a card that lists no action lines gets the verb at the end, before the paragraph', async () => {
    const h = home({ card: lf(['# Actions', '', 'My own words.', '']) });
    await (await plan(ctxFor(h))).apply();
    expect(readFileSync(cardPath(h), 'utf8')).toBe(lf(['# Actions', '', 'My own words.', '', VERB, '', ...PARAGRAPH, '']));
  });

  it('is satisfied once applied, and on a card that already names it anywhere', async () => {
    const h = home();
    await (await plan(ctxFor(h))).apply();
    expect((await plan(ctxFor(h))).satisfied).toBe(true);
    expect((await plan(ctxFor(home({ card: lf([...OLD, 'Audio goes through /transcribe.', '']) })))).satisfied).toBe(true);
  });

  it('no card on this node: satisfied, the seeder plants the repo\'s', async () => {
    expect((await plan(ctxFor(home({ card: null })))).satisfied).toBe(true);
  });

  it('refuses a card that is not UTF-8, naming it', async () => {
    const h = home({ card: Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a]) });
    await expect(plan(ctxFor(h))).rejects.toThrow(/0041 refuses: .*10-actions\.md is not valid UTF-8/);
  });

  it('the verb it advertises is one the parser accepts; the paragraph advertises none', () => {
    expect(ACTION_VERBS.has(VERB.trim().slice(1).split(' ')[0])).toBe(true);
    for (const l of PARAGRAPH) expect(/^\s*\//.test(l)).toBe(false);
  });
});

describe('0041 through the runner', () => {
  function withLedger(h) {
    mkdirSync(join(h, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0041');
    writeFileSync(join(h, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-16T00:00:00Z' }]))));
    return h;
  }
  const outcome = (h) => JSON.parse(readFileSync(join(h, 'state', 'migrations-applied.json'), 'utf8'))['0041-the-actions-card-says-transcribe-goes-to-dolly'].outcome;

  it('applied and recorded, a backup beside the card, the repo card untouched', async () => {
    const before = readFileSync(REPO_CARD);
    const h = withLedger(home());
    const { exitCode } = await runMigrations({ through: '0041', egptHome: h, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    expect(outcome(h)).toBe('applied');
    expect(baks(h).filter((f) => f.startsWith('10-actions.md.bak-0041-'))).toHaveLength(1);
    expect(readFileSync(REPO_CARD).equals(before)).toBe(true);
  });
});
