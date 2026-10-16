// 0041 — the actions card names /transcribe: audio and video go to dolly, never to a model the being runs.
//
// THE MEASUREMENT (2026-10-15): E needed a 9-minute court recording transcribed, had no path to the
// worker, and ran a local transformers.js whisper on reve until the node starved. Operator 2026-10-16:
// "All audio should be worked at dolly, reve is a fallback." src/spine/reply-actions.mjs now has the
// limb; a being learns its limbs from ONE card, config/skeletons/room/10-actions.md.
//
// WHY A MIGRATION: 0031's reason. boot's seedSkeletons is COPY-IF-MISSING, so a node that already
// carries the card never receives the repo's new lines; the profile copy is the one this migration owns.
//
// IT ADDS the verb line after the card's last action line (or at the end, if it lists none) and the
// paragraph at the end, in the card's own line endings - the repo card's wording.
//
// SATISFIED, NOT REFUSED: the card already names /transcribe, or there is no card on this node.
// IT REFUSES, NAMING THE PLACE, only on a card that is not valid UTF-8.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

export const elevated = false;
export const summary = 'the actions card names /transcribe: audio and video go to dolly, never to a speech model the being runs';

const CARD = ['config', 'skeletons', 'room', '10-actions.md'];
export const VERB = '    /transcribe <path>';
export const PARAGRAPH = [
  '`/transcribe` sends audio or video from this folder to dolly, and I am woken',
  'when the transcript is beside it. I never run whisper or a speech model myself.',
];
const SAYS_IT = '/transcribe';

const refuse = (why) => { throw new Error(`0041 refuses: ${why}`); };

export async function plan(ctx) {
  const file = join(ctx.egptHome, ...CARD);
  if (!existsSync(file)) {
    return { satisfied: true, notes: [`there is no ${file} on this node - boot's seeder plants the repo's card`] };
  }
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  if (text.includes(SAYS_IT)) return { satisfied: true, notes: [`${file} already names /transcribe`] };

  const nl = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/(\r?\n)+$/, '').split(nl);
  const last = lines.findLastIndex((l) => /^\s+\/[a-z]+/.test(l));
  if (last >= 0) lines.splice(last + 1, 0, VERB);
  else lines.push('', VERB);
  const next = `${lines.join(nl)}${nl}${nl}${PARAGRAPH.join(nl)}${nl}`;

  return {
    satisfied: false,
    changes: [
      `${file}: add the verb line ${last >= 0 ? 'after the last action line' : 'at the end'} and one paragraph at the end:`,
      `  + ${VERB.trim()}`,
      ...PARAGRAPH.map((l) => `  + ${l}`),
      'backup first, beside it: <file>.bak-0041-<timestamp>',
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
