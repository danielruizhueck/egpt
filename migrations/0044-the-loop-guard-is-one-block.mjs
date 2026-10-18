// 0044 — one loop_guard: block (operator 2026-10-18: "'lasso' should be called 'loop_guard' ... it
// must be changed everywhere" / "yes, one loop_guard block for both").
//
//   config.yaml        `guard:` → `loop_guard.inbound`, `lasso:` → `loop_guard.outbound`
//   conversations.yaml every entry's `guard:` → `loop_guard: { inbound: … }`
//   rooms.yaml, agents.yaml  the same, per row
//
// Values move verbatim: each old block's lines (the comments above and inside it included, the
// same lines spliceYamlRemoveKey would cut) go under `loop_guard:`, indented two spaces, where the
// first of them stood. Every other byte stays; each line keeps its own ending.
//
// conversations.yaml is rewritten from memory by the running spine (migrations run after the
// deploy's bounce). As 0018: every file is checked unchanged-since-planned right before it is
// written, the write is temp → rename like the spine's own, the runner re-plans after apply and
// records nothing a spine write undid, and upgrade.ps1 restarts the spine once anything applied.
//
// Backups: <profile>/disposable/migration-0044-<ts>/<file name>, never a .bak beside a file.
// Satisfied when no old key is left. Refuses a config.yaml that is absent, any file that is not
// UTF-8 or not parsing, an old block that is not a mapping, and an old key beside a loop_guard:
// in the same place (a human merges).
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join, basename } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import * as YAML from 'yaml';
import { yamlKeyLines } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'one loop_guard: block: guard: → loop_guard.inbound, lasso: → loop_guard.outbound, in config.yaml and every registry entry';

const ID = '0044';
const TO = 'loop_guard';
const NODE_MOVES = [['guard', 'inbound'], ['lasso', 'outbound']];
const ENTRY_MOVES = [['guard', 'inbound']];
// Registry files and where their rows sit: conversations.yaml contacts.<surface>.<key>; the other
// two under their root key (or a bare top-level map, as src/rooms-file.mjs reads them).
const REGISTRIES = [['conversations.yaml', 'contacts', 2], ['rooms.yaml', 'rooms', 1], ['agents.yaml', 'agents', 1]];

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
const isMap = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const pad = (n) => String(n).padStart(2, '0');
const stamp = (d) => `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
const eolAt = (text, i) => { const n = text.indexOf('\n', i); return n > 0 && text[n - 1] === '\r' ? '\r\n' : '\n'; };
const linesOf = (s) => s.split('\n').map((l) => l.replace(/\r$/, '')).filter((l, i, a) => i < a.length - 1 || l !== '');
const where = (file, path) => `${basename(file)} ${path.length ? path.join('.') : '(root)'}`;

function open(file) {
  const bytes = readFileSync(file);
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
  const doc = YAML.parseDocument(text);
  if (doc.errors.length) refuse(`${file} does not parse: ${doc.errors[0].message}`);
  return { file, bytes, text, doc, data: doc.toJS(), next: text, expected: doc.toJS(), shown: [] };
}

// One old block, its key renamed, indented under loop_guard:. Blank lines stay blank.
function nested(text, { start, end, keyAt, from, to }, nl) {
  let chunk = text.slice(start, keyAt) + to + text.slice(keyAt + from.length, end);
  if (!chunk.endsWith('\n')) chunk += nl;
  return chunk.replace(/^(?=[^\r\n])/gm, '  ');
}

// Move `moves` ([[from, to]], present in the map at `path` of f.next) under one `loop_guard:` there.
function regroup(f, path, row, moves) {
  const at = where(f.file, path);
  if (Object.hasOwn(row, TO)) refuse(`${at} states \`${TO}:\` AND ${moves.map(([m]) => `\`${m}:\``).join(' and ')} - merging them is a human decision`);
  for (const [from] of moves) if (!isMap(row[from])) refuse(`\`${from}:\` at ${at} is not a mapping (${JSON.stringify(row[from])})`);
  const text = f.next;
  let spans;
  try { spans = moves.map(([from, to]) => ({ from, to, ...yamlKeyLines(text, path, { key: from }) })); }
  catch (e) { refuse(`${at}: ${e?.message ?? e}`); }
  spans.sort((a, b) => a.start - b.start);
  for (const s of spans) if (text.slice(s.keyAt, s.keyAt + s.from.length + 1) !== `${s.from}:`) refuse(`\`${s.from}:\` at ${at} is not written as a plain key - left for a human`);
  const nl = eolAt(text, spans[0].keyAt);
  const col = spans[0].keyAt - (text.lastIndexOf('\n', spans[0].keyAt - 1) + 1);
  const block = `${' '.repeat(col)}${TO}:${nl}${spans.map((s) => nested(text, s, nl)).join('')}`;
  let next = text;
  for (const s of [...spans].reverse()) next = next.slice(0, s.start) + (s === spans[0] ? block : '') + next.slice(s.end);
  f.next = next;
  const target = path.reduce((o, k) => o[String(k)], f.expected);
  target[TO] = {};
  for (const [from, to] of moves) { target[TO][to] = row[from]; delete target[from]; }
  f.shown.push(`${at}: ${moves.map(([from, to]) => `\`${from}:\` → \`${TO}.${to}\``).join(', ')}`,
    ...spans.flatMap((s) => linesOf(text.slice(s.start, s.end)).map((l) => `  - ${l}`)),
    ...linesOf(block).map((l) => `  + ${l}`));
}

// Every row of a registry, as [doc path, row data]. Paths use the doc's own key values.
function rowsOf(f, root, depth) {
  const top = f.doc.contents;
  if (!YAML.isMap(top)) return [];
  const base = YAML.isMap(top.get(root, true)) ? [root] : [];
  let level = [[base, base.length ? top.get(root, true) : top]];
  for (let d = 0; d < depth; d++) {
    level = level.flatMap(([p, m]) => m.items.filter((it) => YAML.isScalar(it.key) && YAML.isMap(it.value)).map((it) => [[...p, it.key.value], it.value]));
  }
  return level.map(([p]) => [p, p.reduce((o, k) => o?.[String(k)], f.data)]).filter(([, row]) => isMap(row));
}

export async function plan(ctx) {
  const home = ctx.egptHome;
  const configFile = join(home, 'config', 'config.yaml');
  if (!existsSync(configFile)) refuse(`there is no ${configFile}`);
  const files = [];

  const cfg = open(configFile);
  if (!isMap(cfg.data)) refuse(`${configFile} is not a mapping at its root`);
  const nodeMoves = NODE_MOVES.filter(([from]) => Object.hasOwn(cfg.data, from));
  if (nodeMoves.length) { regroup(cfg, [], cfg.data, nodeMoves); files.push(cfg); }

  for (const [name, root, depth] of REGISTRIES) {
    const file = join(home, 'config', name);
    if (!existsSync(file)) continue;
    const f = open(file);
    for (const [path, row] of rowsOf(f, root, depth)) if (Object.hasOwn(row, 'guard')) regroup(f, path, row, ENTRY_MOVES);
    if (f.shown.length) files.push(f);
  }

  if (!files.length) return { satisfied: true, notes: ['no `guard:` or `lasso:` left in config.yaml, conversations.yaml, rooms.yaml or agents.yaml'] };
  for (const f of files) {
    const check = YAML.parseDocument(f.next);
    if (check.errors.length || !isDeepStrictEqual(check.toJS(), f.expected)) refuse(`the moves in ${f.file} would not re-parse to the same values - left for a human`);
  }

  return {
    satisfied: false,
    changes: [
      ...files.flatMap((f) => [`${f.file} (values verbatim):`, ...f.shown]),
      `backups first: ${join(home, 'disposable', `migration-${ID}-<timestamp>`)}/<file name>`,
    ],
    apply: async () => {
      for (const f of files) if (!readFileSync(f.file).equals(f.bytes)) refuse(`${f.file} changed since it was planned - re-run`);
      const vault = join(home, 'disposable', `migration-${ID}-${stamp(new Date())}`);
      mkdirSync(vault, { recursive: true });
      for (const f of files) {
        copyFileSync(f.file, join(vault, basename(f.file)));
        ctx.log(`backup: ${join(vault, basename(f.file))}`);
        const tmp = `${f.file}.tmp-${ID}-${process.pid}`;
        writeFileSync(tmp, f.next, 'utf8');
        renameSync(tmp, f.file);
      }
    },
  };
}
