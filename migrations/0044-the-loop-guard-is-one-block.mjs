// 0044 — one loop_guard: block (operator 2026-10-18: "'lasso' should be called 'loop_guard' ... it
// must be changed everywhere" / "yes, one loop_guard block for both").
//
// config.yaml `guard:` → `loop_guard.inbound`, `lasso:` → `loop_guard.outbound`. Values move
// verbatim: each old block's lines (the comments above and inside it included, the same lines
// spliceYamlRemoveKey would cut) go under `loop_guard:`, indented two spaces, where the first of
// them stood. Every other byte stays; each line keeps its own ending.
//
// Backup: <profile>/disposable/migration-0044-<ts>/config.yaml, never a .bak beside it.
// Satisfied when neither old key is there. Refuses a config.yaml that is absent, not UTF-8 or not
// parsing, an old block that is not a mapping, and old keys beside a loop_guard: (a human merges).
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as YAML from 'yaml';
import { yamlKeyLines } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'one loop_guard: block: config.yaml guard: → loop_guard.inbound, lasso: → loop_guard.outbound';

const ID = '0044';
const TO = 'loop_guard';
const MOVES = [['guard', 'inbound'], ['lasso', 'outbound']];

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const eolAt = (text, i) => { const n = text.indexOf('\n', i); return n > 0 && text[n - 1] === '\r' ? '\r\n' : '\n'; };
const linesOf = (s) => s.split('\n').map((l) => l.replace(/\r$/, '')).filter((l, i, a) => i < a.length - 1 || l !== '');

// One old block, its key renamed, indented under loop_guard:. Blank lines stay blank.
function nested(text, { start, end, keyAt, from, to }, nl) {
  let chunk = text.slice(start, keyAt) + to + text.slice(keyAt + from.length, end);
  if (!chunk.endsWith('\n')) chunk += nl;
  return chunk.replace(/^(?=[^\r\n])/gm, '  ');
}

export async function plan(ctx) {
  const home = ctx.egptHome;
  const file = join(home, 'config', 'config.yaml');
  if (!existsSync(file)) refuse(`there is no ${file}`);
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  const data = doc.toJS();
  if (!isMap(data)) refuse(`${file} is not a mapping at its root`);

  const moves = MOVES.filter(([from]) => Object.hasOwn(data, from));
  if (!moves.length) {
    return { satisfied: true, notes: [Object.hasOwn(data, TO) ? `${file} states \`${TO}:\` - moved already` : `${file} states neither \`guard:\` nor \`lasso:\` - nothing to move`] };
  }
  const named = moves.map(([from]) => `\`${from}:\``).join(' and ');
  if (Object.hasOwn(data, TO)) refuse(`${file} states \`${TO}:\` AND ${named} - merging them is a human decision`);
  for (const [from] of moves) if (!isMap(data[from])) refuse(`\`${from}:\` in ${file} is not a mapping (${JSON.stringify(data[from])})`);

  let spans;
  try { spans = moves.map(([from, to]) => ({ from, to, ...yamlKeyLines(text, [], { key: from }) })); }
  catch (e) { refuse(`${file}: ${e?.message ?? e}`); }
  spans.sort((a, b) => a.start - b.start);
  for (const s of spans) if (text.slice(s.keyAt, s.keyAt + s.from.length + 1) !== `${s.from}:`) refuse(`\`${s.from}:\` in ${file} is not written as a plain key - left for a human`);

  const nl = eolAt(text, spans[0].keyAt);
  const block = `${TO}:${nl}${spans.map((s) => nested(text, s, nl)).join('')}`;
  let next = text;
  for (const s of [...spans].reverse()) next = next.slice(0, s.start) + (s === spans[0] ? block : '') + next.slice(s.end);

  const expected = { ...data, [TO]: {} };
  for (const [from, to] of moves) { expected[TO][to] = data[from]; delete expected[from]; }
  const check = YAML.parseDocument(next);
  if (check.errors.length || !isDeepStrictEqual(check.toJS(), expected)) refuse(`moving ${named} under \`${TO}:\` in ${file} would not re-parse to the same values - left for a human`);

  return {
    satisfied: false,
    changes: [
      `${file}: ${moves.map(([from, to]) => `\`${from}:\` → \`${TO}.${to}\``).join(', ')} (values verbatim)`,
      ...spans.flatMap((s) => linesOf(text.slice(s.start, s.end)).map((l) => `  - ${l}`)),
      ...linesOf(block).map((l) => `  + ${l}`),
      `backup first: ${join(home, 'disposable', `migration-${ID}-<timestamp>`, 'config.yaml')}`,
    ],
    apply: async () => {
      if (!readFileSync(file).equals(bytes)) refuse(`${file} changed since it was planned - re-run`);
      const vault = join(home, 'disposable', `migration-${ID}-${stamp(new Date())}`);
      mkdirSync(vault, { recursive: true });
      copyFileSync(file, join(vault, 'config.yaml'));
      ctx.log(`backup: ${join(vault, 'config.yaml')}`);
      writeFileSync(file, next, 'utf8');
    },
  };
}
