// 0042 — the actions card drops /transcribe. The limb was reverted (operator 2026-10-16: audio enters
// through the bridge only); 0041 had taught it to the profile card.
//
// Removes exactly 0041's lines: the verb line, and the two-line paragraph with the blank line before
// it. From the profile card and from every directives/10-actions.md copy (conversations, rooms,
// agents). Each line keeps its own ending. Anything else naming /transcribe is left alone, and noted.
//
// Backups: the card beside itself (<file>.bak-0042-<ts>); a directives copy under
// <profile>/disposable/migration-0042-<ts>/<same relative path>, so no old card sits where a being reads.
// Satisfied when no file carries 0041's lines. Refuses only a non-UTF-8 file that names /transcribe.
import { readFileSync, writeFileSync, existsSync, readdirSync, copyFileSync, mkdirSync } from 'node:fs';
import { join, relative, dirname, sep } from 'node:path';

export const elevated = false;
export const summary = "the actions card drops /transcribe: 0041's lines leave the profile card and every directives/ copy";

const CARD = ['config', 'skeletons', 'room', '10-actions.md'];
const COPY = ['directives', '10-actions.md'];
const ROOTS = [['conversations', 2], ['rooms', 1], ['agents', 1]];   // [root, folder depth of a room under it]
export const VERB = '    /transcribe <path>';
export const PARAGRAPH = [
  '`/transcribe` sends audio or video from this folder to dolly, and I am woken',
  'when the transcript is beside it. I never run whisper or a speech model myself.',
];
const NAMES_IT = '/transcribe';

const refuse = (why) => { throw new Error(`0042 refuses: ${why}`); };
const subdirs = (dir) => { try { return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory() && !e.isSymbolicLink()).map((e) => join(dir, e.name)); } catch { return []; } };

function copies(home) {
  const out = [];
  for (const [root, depth] of ROOTS) {
    let dirs = [join(home, root)];
    for (let i = 0; i < depth; i++) dirs = dirs.flatMap(subdirs);
    for (const d of dirs) if (existsSync(join(d, ...COPY))) out.push(join(d, ...COPY));
  }
  return out;
}

// { next, dropped } with 0041's lines gone, or null when none are there.
export function without0041(text) {
  const segs = text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const line = (i) => (segs[i] ?? '').replace(/\r?\n$/, '').trimEnd();
  const drop = new Set();
  segs.forEach((_, i) => { if (line(i).trim() === VERB.trim()) drop.add(i); });
  for (let i = 0; i + 1 < segs.length; i++) {
    if (line(i) !== PARAGRAPH[0] || line(i + 1) !== PARAGRAPH[1]) continue;
    drop.add(i).add(i + 1);
    if (i > 0 && line(i - 1) === '') drop.add(i - 1);
    else if (i + 2 < segs.length && line(i + 2) === '') drop.add(i + 2);
  }
  if (!drop.size) return null;
  return { next: segs.filter((_, i) => !drop.has(i)).join(''), dropped: [...drop].sort((a, b) => a - b).map(line) };
}

export async function plan(ctx) {
  const home = ctx.egptHome;
  const rel = (p) => relative(home, p).split(sep).join('/');
  const card = join(home, ...CARD);
  const edits = [], notes = [];
  for (const file of [card, ...copies(home)]) {
    if (!existsSync(file)) continue;
    const bytes = readFileSync(file);
    const text = bytes.toString('utf8');
    if (!text.includes(NAMES_IT)) continue;
    if (!Buffer.from(text, 'utf8').equals(bytes)) refuse(`${file} is not valid UTF-8; an edit would re-encode bytes it never meant to touch`);
    const r = without0041(text);
    if ((r ? r.next : text).includes(NAMES_IT)) notes.push(`${rel(file)} names /transcribe in words 0041 did not write - left as is`);
    if (r) edits.push({ file, bytes, ...r, beside: file === card });
  }
  if (!edits.length) return { satisfied: true, notes: notes.length ? notes : ["no card or directives copy carries 0041's lines"] };

  return {
    satisfied: false,
    changes: [
      ...edits.flatMap((e) => [`${rel(e.file)}: drop ${e.dropped.length} line(s)`, ...e.dropped.map((l) => `  - ${l}`)]),
      ...notes,
      'backups first: the card beside itself (<file>.bak-0042-<timestamp>); directives copies under disposable/migration-0042-<timestamp>/',
    ],
    apply: async () => {
      for (const e of edits) if (!readFileSync(e.file).equals(e.bytes)) refuse(`${e.file} changed since it was planned - re-run`);
      const pad = (n) => String(n).padStart(2, '0');
      const d = new Date();
      const vault = join(home, 'disposable', `migration-0042-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}T${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`);
      for (const e of edits) {
        if (e.beside) ctx.log(`backup: ${ctx.backup(e.file)}`);
        else { const to = join(vault, relative(home, e.file)); mkdirSync(dirname(to), { recursive: true }); copyFileSync(e.file, to); }
        writeFileSync(e.file, e.next, 'utf8');
      }
      if (edits.some((e) => !e.beside)) ctx.log(`backups: ${vault}`);
    },
  };
}
