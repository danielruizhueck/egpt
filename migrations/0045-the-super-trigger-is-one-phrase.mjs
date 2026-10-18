// 0045 — super_chats.triggers: [list] → super_chats.trigger: "<phrase>" (operator 2026-10-18: "evict
// that '...' option. change the super_chat.trigger: '<phrase>', if phrase is empty it is effectively
// disabled").
//
// The first non-empty entry becomes the phrase; any others are dropped and named in the plan. An
// empty or all-empty list becomes trigger: "". The inline list's text is replaced and the key renamed;
// every other byte stays (its end-of-line comment included).
//
// Backups: <profile>/disposable/migration-0045-<ts>/config.yaml. Satisfied when super_chats has no
// `triggers:` (or there is no super_chats). Refuses a config.yaml that is absent, not UTF-8 or not
// parsing, `triggers:` beside `trigger:`, and a `triggers:` that is not an inline [ ] list.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as YAML from 'yaml';
import { spliceYamlKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'super_chats.triggers: [list] → super_chats.trigger: "<phrase>" (the "…" summon is gone)';

const ID = '0045';
const BLOCK = 'super_chats';
const FROM = 'triggers';
const TO = 'trigger';

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const block = doc.toJS()?.[BLOCK];
  if (!isMap(block) || !Object.hasOwn(block, FROM)) {
    return { satisfied: true, notes: [`${file} has no \`${BLOCK}.${FROM}:\` - nothing to rewrite`] };
  }
  if (Object.hasOwn(block, TO)) refuse(`${file} ${BLOCK} states \`${TO}:\` AND \`${FROM}:\` - keeping one is a human decision`);
  const node = doc.getIn([BLOCK, FROM], true);
  if (!YAML.isSeq(node) || !node.flow) refuse(`\`${FROM}:\` in ${file} ${BLOCK} is not an inline [ ] list (${JSON.stringify(block[FROM])}) - left for a human`);

  const phrases = block[FROM].map((t) => String(t ?? '')).filter((t) => t.trim());
  const [phrase = '', ...dropped] = phrases;
  const [start, end] = node.range;
  let next;
  try { next = spliceYamlKey(text.slice(0, start) + JSON.stringify(phrase) + text.slice(end), [BLOCK], { from: FROM, to: TO }); }
  catch (e) { refuse(`${file}: ${e?.message ?? e}`); }
  const expected = doc.toJS();
  delete expected[BLOCK][FROM];
  expected[BLOCK][TO] = phrase;
  const check = YAML.parseDocument(next);
  if (check.errors.length || !isDeepStrictEqual(check.toJS(), expected)) refuse(`the rewrite of ${file} would not re-parse to the same values - left for a human`);

  return {
    satisfied: false,
    changes: [
      `${file} ${BLOCK}: \`${FROM}: ${JSON.stringify(block[FROM])}\` → \`${TO}: ${JSON.stringify(phrase)}\``,
      ...(dropped.length ? [`dropped (only one phrase is kept): ${dropped.map((d) => JSON.stringify(d)).join(', ')}`] : []),
      `backup first: ${join(ctx.egptHome, 'disposable', `migration-${ID}-<timestamp>`)}/config.yaml`,
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      const vault = join(ctx.egptHome, 'disposable', `migration-${ID}-${stamp(new Date())}`);
      mkdirSync(vault, { recursive: true });
      copyFileSync(file, join(vault, 'config.yaml'));
      ctx.log(`backup: ${join(vault, 'config.yaml')}`);
      const tmp = `${file}.tmp-${ID}-${process.pid}`;
      writeFileSync(tmp, next, 'utf8');
      renameSync(tmp, file);
    },
  };
}
