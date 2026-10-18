// 0047 — the global `super_chats:` block goes (operator 2026-10-18): SI chats are per conversation,
// a `superchats:` block on the chat's own conversations.yaml entry. The spine no longer reads
// super_chats. Removes the block and the comment lines directly above it; every other byte stays.
//
// Backups: <profile>/disposable/migration-0047-<ts>/config.yaml. Satisfied when there is no block.
// Refuses an ON block (a phrase in `triggers`): which chats get SI chats is a human decision. Refuses
// a config.yaml that is absent, not UTF-8 or not parsing.
import { readFileSync, writeFileSync, existsSync, mkdirSync, copyFileSync, renameSync } from 'node:fs';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { spliceYamlRemoveKey } from '../src/tools/config-io.mjs';

export const elevated = false;
export const summary = 'the global super_chats block is gone; SI chats are per conversation (superchats)';

const ID = '0047';
const BLOCK = 'super_chats';

const refuse = (why) => { throw new Error(`${ID} refuses: ${why}`); };
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
  const js = doc.toJS() ?? {};
  if (!Object.hasOwn(js, BLOCK)) return { satisfied: true, notes: [`${file} has no ${BLOCK} block`] };

  const phrases = (Array.isArray(js[BLOCK]?.triggers) ? js[BLOCK].triggers : []).map((t) => String(t ?? '').trim()).filter(Boolean);
  if (phrases.length) refuse(`${file} ${BLOCK} is ON (${phrases.map((p) => JSON.stringify(p)).join(', ')}) - put the phrases in a chat's superchats block in conversations.yaml, then remove ${BLOCK} by hand`);
  let next;
  try { next = spliceYamlRemoveKey(text, [], { key: BLOCK }); } catch (e) { refuse(`${file}: ${e?.message ?? e}`); }

  return {
    satisfied: false,
    changes: [
      `${file}: \`${BLOCK}:\` removed (it was off; nothing reads it any more)`,
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
