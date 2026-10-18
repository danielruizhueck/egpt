// 0045 — super_chats.triggers: [list] → super_chats.trigger: "<phrase>". A kg-shaped config.yaml.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as YAML from 'yaml';
import { plan } from '../migrations/0045-the-super-trigger-is-one-phrase.mjs';
import { runMigrations, listMigrations, MIGRATIONS_DIR } from '../setup/migrate.mjs';

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const lf = (lines) => lines.map((l) => `${l}\n`).join('');
const KG = (triggers = '[ "SI chat" ]') => [
  'node_name: kg',
  '# SI',
  'super_chats:',
  '  enabled: true',
  '  mode: "on"',
  `  triggers: ${triggers}   # whole-message`,
  '  suffix: -super',
  'compaction:',
  '  enabled: true',
];

let root, egptHome;
const cfgPath = () => join(egptHome, 'config', 'config.yaml');
const logs = [];
const ctx = () => ({ id: '0045', egptHome, platform: 'win32', dryRun: false, log: (l) => logs.push(l) });
const write = (text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(cfgPath(), text); };
const read = () => readFileSync(cfgPath(), 'utf8');
const vaults = () => (existsSync(join(egptHome, 'disposable')) ? readdirSync(join(egptHome, 'disposable')) : []);
const expectedFor = (phrase, eol = lf) => eol(KG().map((l) => (l.startsWith('  triggers:') ? `  trigger: ${JSON.stringify(phrase)}   # whole-message` : l)));

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-0045-')); egptHome = join(root, '.egpt'); logs.length = 0; write(crlf(KG())); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0045 — super_chats.triggers → super_chats.trigger', () => {
  it('REPRODUCE: kg states `triggers:` and no `trigger:`', async () => {
    expect(YAML.parse(read()).super_chats.triggers).toEqual(['SI chat']);
    expect((await plan(ctx())).satisfied).toBe(false);
  });

  it('the list becomes its one phrase; the comment, CRLF and every other line kept', async () => {
    await (await plan(ctx())).apply();
    expect(read()).toBe(expectedFor('SI chat', crlf));
  });

  it('keeps the first non-empty phrase and names what it dropped', async () => {
    write(lf(KG('[ "", "SI chat", other ]')));
    const p = await plan(ctx());
    expect(p.changes.join('\n')).toMatch(/dropped.*"other"/);
    await p.apply();
    expect(read()).toBe(expectedFor('SI chat'));
  });

  it('an empty or all-empty list becomes trigger: "" (no summon)', async () => {
    for (const list of ['[]', '[ "", "  " ]']) {
      write(lf(KG(list)));
      await (await plan(ctx())).apply();
      expect(read()).toBe(expectedFor(''));
    }
  });

  it('backs up into disposable/migration-0045-<ts>/config.yaml, never beside the file', async () => {
    const original = read();
    await (await plan(ctx())).apply();
    const [vault] = vaults();
    expect(vault).toMatch(/^migration-0045-\d{8}T\d{6}$/);
    expect(readFileSync(join(egptHome, 'disposable', vault, 'config.yaml'), 'utf8')).toBe(original);
    expect(readdirSync(join(egptHome, 'config'))).toEqual(['config.yaml']);
    expect(logs.join('\n')).toContain(join('disposable', vault, 'config.yaml'));
  });

  it('is idempotent: satisfied once rewritten', async () => {
    await (await plan(ctx())).apply();
    expect((await plan(ctx())).satisfied).toBe(true);
  });

  it('no super_chats block, or one without triggers: satisfied, untouched', async () => {
    for (const lines of [['node_name: kg', 'compaction:', '  enabled: true'], ['super_chats:', '  enabled: true', '  trigger: SI chat']]) {
      write(lf(lines));
      expect((await plan(ctx())).satisfied).toBe(true);
      expect(read()).toBe(lf(lines));
    }
    expect(vaults()).toEqual([]);
  });

  it('refuses triggers beside trigger, a value that is not an inline list, and a config that does not parse', async () => {
    write(lf(['super_chats:', '  trigger: a', '  triggers: [ b ]']));
    await expect(plan(ctx())).rejects.toThrow(/0045 refuses: .*`trigger:` AND `triggers:`/);
    write(lf(['super_chats:', '  triggers:', '    - SI chat']));
    await expect(plan(ctx())).rejects.toThrow(/0045 refuses: .*`triggers:` .*not an inline \[ \] list/);
    write(lf(['super_chats:', '  triggers: SI chat']));
    await expect(plan(ctx())).rejects.toThrow(/0045 refuses: .*`triggers:` .*not an inline \[ \] list/);
    write('super_chats: [unclosed\r\n');
    await expect(plan(ctx())).rejects.toThrow(/0045 refuses: .*config\.yaml does not parse/);
  });

  it('through the runner, on a node whose ledger records 0001-0044: applied and recorded', async () => {
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0045');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-18T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0045', egptHome, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0045-the-super-trigger-is-one-phrase'].outcome).toBe('applied');
    expect(YAML.parse(read()).super_chats).toEqual({ enabled: true, mode: 'on', trigger: 'SI chat', suffix: '-super' });
  });
});
