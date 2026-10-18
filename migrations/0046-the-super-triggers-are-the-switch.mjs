// 0046 — super_chats: `triggers: [ … ]` is the list of summon phrases AND the switch; `trigger:` and
// `enabled:` go (operator 2026-10-18: "a list defines if it's enabled or not: no phrase then it is not
// enabled"). Supersedes 0045.
//
// The node keeps its on/off state: `enabled: true` carries the phrases over (`trigger: "s"` → [ "s" ]);
// false or absent leaves `triggers: []` and names the phrases set aside. A block with only `enabled:`
// gets `triggers: []` in its place. Every other byte stays (end-of-line comments, CRLF).
//
// Backups: <profile>/disposable/migration-0046-<ts>/config.yaml. Satisfied when super_chats has neither
// `trigger:` nor `enabled:` - so a pre-0045 `triggers:` list with no `enabled:` reads as migrated (ON).
// Refuses a config.yaml that is absent, not UTF-8 or not parsing, `trigger:` beside `triggers:`, a
// `trigger:` that is not one phrase, and a `triggers:` that is not an inline [ ] list.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as YAML from 'yaml';
import { spliceYamlKey, spliceYamlRemoveKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'super_chats: `triggers: [ … ]` is the switch; `trigger:` and `enabled:` are gone';

const ID = '0046';
const BLOCK = 'super_chats';

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const quoted = (phrases) => phrases.map((p) => JSON.stringify(p)).join(', ');
const inline = (phrases) => (phrases.length ? `[ ${quoted(phrases)} ]` : '[]');

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const block = doc.toJS()?.[BLOCK];
  const has = (k) => isMap(block) && Object.hasOwn(block, k);
  if (!has('trigger') && !has('enabled')) {
    return { satisfied: true, notes: [`${file} ${BLOCK} has no \`trigger:\` or \`enabled:\` - nothing to rewrite`] };
  }
  if (has('trigger') && has('triggers')) refuse(`${file} ${BLOCK} states \`trigger:\` AND \`triggers:\` - keeping one is a human decision`);

  // The key whose value becomes the list: the phrase(s), else `enabled:` itself.
  const from = has('trigger') ? 'trigger' : has('triggers') ? 'triggers' : 'enabled';
  const node = doc.getIn([BLOCK, from], true);
  if (from === 'trigger' && !YAML.isScalar(node)) refuse(`\`trigger:\` in ${file} ${BLOCK} is not one phrase (${JSON.stringify(block.trigger)}) - left for a human`);
  if (from === 'triggers' && !(YAML.isSeq(node) && node.flow)) refuse(`\`triggers:\` in ${file} ${BLOCK} is not an inline [ ] list (${JSON.stringify(block.triggers)}) - left for a human`);

  const phrases = (from === 'trigger' ? [block.trigger] : from === 'triggers' ? block.triggers : [])
    .map((t) => String(t ?? '').trim()).filter(Boolean);
  const on = !!block.enabled;
  const kept = on ? phrases : [];
  const rewrite = from !== 'triggers' || kept.length < phrases.length;   // an ON `triggers:` list stays byte for byte
  let next = text;
  if (rewrite) { const [start, end] = node.range; next = text.slice(0, start) + inline(kept) + text.slice(end); }
  try {
    if (from !== 'triggers') next = spliceYamlKey(next, [BLOCK], { from, to: 'triggers' });
    if (from !== 'enabled' && has('enabled')) next = spliceYamlRemoveKey(next, [BLOCK], { key: 'enabled' });
  } catch (e) { refuse(`${file}: ${e?.message ?? e}`); }
  const expected = doc.toJS();
  delete expected[BLOCK].trigger;
  delete expected[BLOCK].enabled;
  expected[BLOCK].triggers = rewrite ? kept : block.triggers;
  const check = YAML.parseDocument(next);
  if (check.errors.length || !isDeepStrictEqual(check.toJS(), expected)) refuse(`the rewrite of ${file} would not re-parse to the same values - left for a human`);

  const was = ['enabled', 'trigger', 'triggers'].filter(has).map((k) => `${k}: ${JSON.stringify(block[k])}`).join(', ');
  return {
    satisfied: false,
    changes: [
      `${file} ${BLOCK}: \`${was}\` → \`triggers: ${JSON.stringify(expected[BLOCK].triggers)}\``,
      ...(!on && phrases.length ? [`SI was off, so these phrases were set aside - add them to \`triggers\` to turn it on: ${quoted(phrases)}`] : []),
      ...(on && !phrases.length ? ['SI was on (enabled: true) with no phrase; it is now OFF - add a phrase to `triggers` to turn it on'] : []),
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
