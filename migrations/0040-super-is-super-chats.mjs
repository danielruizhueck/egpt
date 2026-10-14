// 0040 — SI config key rename: `super:` → `super_chats:` in the node's config.yaml.
//
// Operator, 2026-10-13: the SUPER CHANNEL block grew into SI (auto-create, the admin siphon, the
// access gate), and the top-level key reads clearer as `super_chats:`. The rename is value-preserving
// — enabled / mode / triggers / suffix / opener (and the new `automatic`) ride across untouched; only
// the key's own name changes (spliceYamlKey, the comment-preserving rename). A node that already says
// `super_chats:` is SATISFIED; a node with NEITHER key is SATISFIED (nothing to move). It REFUSES only
// on a config.yaml it cannot honestly read: absent, not UTF-8, or not parsing.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'SI config key rename: config.yaml `super:` → `super_chats:` (value-preserving)';

const ID = '0040';
const FROM = 'super';
const TO = 'super_chats';

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);

function rendered(file, before, after, label) {
  const a = before.split('\n');
  const b = after.split('\n');
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s]) s++;
  let e = 0;
  while (e < a.length - s && e < b.length - s && a[a.length - 1 - e] === b[b.length - 1 - e]) e++;
  const strip = (l) => l.replace(/\r$/, '');
  const gone = a.slice(s, a.length - e).map(strip);
  const came = b.slice(s, b.length - e).map(strip);
  return [`${file}:${s + 1}-${s + Math.max(gone.length, came.length)}  ${label}`, ...gone.map((l) => `  - ${l}`), ...came.map((l) => `  + ${l}`)];
}

export async function plan(ctx) {
  const file = join(ctx.egptHome, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; a splice would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const data = doc.toJS();
  if (!isMap(data)) refuse(`${file} is not a mapping at its root - there is no \`${FROM}:\` to rename`);
  if (Object.hasOwn(data, TO)) {
    return { satisfied: true, notes: [`${file} already states \`${TO}:\` - renamed already, left as it is`] };
  }
  if (!Object.hasOwn(data, FROM)) {
    return { satisfied: true, notes: [`${file} states neither \`${FROM}:\` nor \`${TO}:\` - nothing to rename`] };
  }
  let next;
  try { next = spliceYamlKey(text, [], { from: FROM, to: TO }); }
  catch (e) { refuse(`\`${FROM}:\` could not be renamed to \`${TO}:\` in ${file}: ${e?.message ?? e}`); }
  return {
    satisfied: false,
    changes: [...rendered(file, text, next, `rename \`${FROM}:\` → \`${TO}:\` at the root (value preserved)`), `backup first, beside it: config.yaml.bak-${ID}-<timestamp>`],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      ctx.log(`backup: ${ctx.backup(file)}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
