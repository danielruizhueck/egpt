// 0044 — one loop_guard: block; plus the one-release read of the pre-0044 keys (src/loop-guard.mjs
// loopGuardConfig) and the rename's own check: no "lasso" left outside this file, the migration
// and the legacy-key constant.
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as YAML from 'yaml';
import { loopGuardConfig, LEGACY_BLOCKS } from '../src/loop-guard.mjs';

// egpt-home.mjs reads EGPT_HOME once at load: set it first, import what derives from it after.
const bootHome = join(tmpdir(), `egpt-0044-boot-${Date.now()}-${Math.random().toString(36).slice(2)}`);
process.env.EGPT_HOME = bootHome;
let plan, runMigrations, listMigrations, MIGRATIONS_DIR, boot;
beforeAll(async () => {
  ({ plan } = await import('../migrations/0044-the-loop-guard-is-one-block.mjs'));
  ({ runMigrations, listMigrations, MIGRATIONS_DIR } = await import('../setup/migrate.mjs'));
  ({ boot } = await import('../src/spine/boot.mjs'));
});
afterAll(() => { delete process.env.EGPT_HOME; rmSync(bootHome, { recursive: true, force: true }); });

const crlf = (lines) => lines.map((l) => `${l}\r\n`).join('');
const lf = (lines) => lines.map((l) => `${l}\n`).join('');

// reve, 2026-10-18: a guard: block, no lasso:.
const REVE = [
  'log_to_group: eGPT Admin',
  'super_chats:',
  '  enabled: false',
  'guard:',
  '  turns: 60      # non-human turns per window before auto-STOP (10x, operator 2026-10-11)',
  '  window: 2      # minutes',
  '# THE FOLDERS EVERY SANDBOXED BEING MAY READ',
  'global_read_paths:',
  '  - repos: C:\\Users\\an\\src\\siran',
];
// Both old keys, lasso: first, flow + block, comments above and inside.
const BOTH = [
  'node_name: kg',
  '# the outbound ceiling',
  'lasso:',
  '  messages: 30   # raised for the room',
  '  # per chat',
  '  chat_burst_count: 12',
  'warm:',
  '  max: 4',
  '# loop-breaker',
  'guard: { turns: 6, window: 2 }   # node default',
  'compaction:',
  '  enabled: true',
];

let root, egptHome;
const cfgPath = () => join(egptHome, 'config', 'config.yaml');
const logs = [];
const ctx = () => ({ id: '0044', egptHome, platform: 'win32', dryRun: false, log: (l) => logs.push(l) });
const write = (text) => { mkdirSync(join(egptHome, 'config'), { recursive: true }); writeFileSync(cfgPath(), text); };
const read = () => readFileSync(cfgPath(), 'utf8');
const vaults = () => (existsSync(join(egptHome, 'disposable')) ? readdirSync(join(egptHome, 'disposable')) : []);

beforeEach(() => { root = mkdtempSync(join(tmpdir(), 'egpt-0044-')); egptHome = join(root, '.egpt'); logs.length = 0; write(lf(REVE)); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe('0044 — guard: / lasso: → one loop_guard: block', () => {
  it('REPRODUCE: reve states `guard:` and no `loop_guard:`', async () => {
    expect(YAML.parse(read()).guard).toEqual({ turns: 60, window: 2 });
    expect((await plan(ctx())).satisfied).toBe(false);
  });

  it('moves reve\'s guard: under loop_guard.inbound, comments and every other line kept', async () => {
    await (await plan(ctx())).apply();
    expect(read()).toBe(lf([
      ...REVE.slice(0, 3),
      'loop_guard:',
      '  inbound:',
      '    turns: 60      # non-human turns per window before auto-STOP (10x, operator 2026-10-11)',
      '    window: 2      # minutes',
      ...REVE.slice(6),
    ]));
  });

  it('both old keys, CRLF: one block where the first stood, values equal, CRLF kept', async () => {
    write(crlf(BOTH));
    const before = YAML.parse(read());
    await (await plan(ctx())).apply();
    const after = YAML.parse(read());
    expect(after.loop_guard).toEqual({ outbound: before.lasso, inbound: before.guard });
    const { lasso: _l, guard: _g, ...restBefore } = before;
    const { loop_guard: _lg, ...restAfter } = after;
    expect(restAfter).toEqual(restBefore);
    expect(read()).toBe(crlf([
      'node_name: kg',
      'loop_guard:',
      '  # the outbound ceiling',
      '  outbound:',
      '    messages: 30   # raised for the room',
      '    # per chat',
      '    chat_burst_count: 12',
      '  # loop-breaker',
      '  inbound: { turns: 6, window: 2 }   # node default',
      'warm:',
      '  max: 4',
      'compaction:',
      '  enabled: true',
    ]));
  });

  it('backs up into disposable/migration-0044-<ts>/config.yaml, never beside the file', async () => {
    const original = read();
    await (await plan(ctx())).apply();
    const [vault] = vaults();
    expect(vault).toMatch(/^migration-0044-\d{8}T\d{6}$/);
    expect(readFileSync(join(egptHome, 'disposable', vault, 'config.yaml'), 'utf8')).toBe(original);
    expect(readdirSync(join(egptHome, 'config'))).toEqual(['config.yaml']);
    expect(logs.join('\n')).toContain(join('disposable', vault, 'config.yaml'));
  });

  it('is idempotent: satisfied once moved', async () => {
    await (await plan(ctx())).apply();
    const p = await plan(ctx());
    expect(p.satisfied).toBe(true);
    expect(p.notes.join()).toMatch(/moved already/);
  });

  it('a node with neither old key is satisfied', async () => {
    write(lf(['node_name: kg', 'warm:', '  max: 4']));
    expect((await plan(ctx())).satisfied).toBe(true);
    expect(vaults()).toEqual([]);
  });

  it('refuses old keys beside an existing loop_guard:', async () => {
    write(lf(['loop_guard:', '  inbound: { turns: 6 }', 'guard: { turns: 60 }']));
    await expect(plan(ctx())).rejects.toThrow(/0044 refuses: .*loop_guard:.*AND `guard:`/);
  });

  it('refuses an old key that is not a mapping, and a config.yaml that does not parse', async () => {
    write(lf(['guard: 6']));
    await expect(plan(ctx())).rejects.toThrow(/0044 refuses: `guard:` .* is not a mapping/);
    write('guard: [unclosed\r\n');
    await expect(plan(ctx())).rejects.toThrow(/0044 refuses: .*config\.yaml does not parse/);
  });

  it('through the runner, on a node whose ledger records 0001-0043: applied and recorded', async () => {
    mkdirSync(join(egptHome, 'state'), { recursive: true });
    const earlier = listMigrations(MIGRATIONS_DIR).filter(({ id }) => id < '0044');
    writeFileSync(join(egptHome, 'state', 'migrations-applied.json'),
      JSON.stringify(Object.fromEntries(earlier.map(({ id }) => [id, { outcome: 'applied', at: '2026-10-18T00:00:00Z' }]))));
    const { exitCode } = await runMigrations({ through: '0044', egptHome, elevated: false, platform: 'win32', log: () => {} });
    expect(exitCode).toBe(0);
    const ledger = JSON.parse(readFileSync(join(egptHome, 'state', 'migrations-applied.json'), 'utf8'));
    expect(ledger['0044-the-loop-guard-is-one-block'].outcome).toBe('applied');
    expect(YAML.parse(read()).loop_guard).toEqual({ inbound: { turns: 60, window: 2 } });
  });
});

describe('loopGuardConfig — the pre-0044 keys are still read for one release', () => {
  it('names exactly the two old blocks', () => {
    expect(LEGACY_BLOCKS).toEqual({ inbound: 'guard', outbound: 'lasso' });
  });

  it('reads guard: as inbound and lasso: as outbound, with ONE deprecation line', () => {
    const seen = [];
    const got = loopGuardConfig({ guard: { turns: 60, window: 2 }, lasso: { messages: 30 } }, { onDeprecated: (m) => seen.push(m) });
    expect(got).toEqual({ inbound: { turns: 60, window: 2 }, outbound: { messages: 30 } });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatch(/guard: read as loop_guard\.inbound; lasso: read as loop_guard\.outbound.*0044/);
  });

  it('loop_guard: wins; an old key beside it is ignored and said so', () => {
    const seen = [];
    const got = loopGuardConfig({ loop_guard: { inbound: { turns: 6 } }, guard: { turns: 60 } }, { onDeprecated: (m) => seen.push(m) });
    expect(got).toEqual({ inbound: { turns: 6 }, outbound: {} });
    expect(seen).toEqual([expect.stringMatching(/guard: ignored, loop_guard\.inbound is set/)]);
  });

  it('the new block alone, or nothing at all: no deprecation line', () => {
    const seen = [];
    expect(loopGuardConfig({ loop_guard: { outbound: { edits: 9 } } }, { onDeprecated: (m) => seen.push(m) })).toEqual({ inbound: {}, outbound: { edits: 9 } });
    expect(loopGuardConfig({}, { onDeprecated: (m) => seen.push(m) })).toEqual({ inbound: {}, outbound: {} });
    expect(seen).toEqual([]);
  });
});

// boot() on a node that has NOT run 0044: its old lasso: still bounds what it sends.
describe('boot() reads an old block, logged once', () => {
  it('lasso: { messages: 3 } still trips at 3 (STOP lands in this file\'s profile), and guard: is read too', async () => {
    const sent = [];
    const lines = [];
    const exits = [];
    const app = await boot({
      readConfig: () => ({ whatsapp: {}, node_name: 'kg', lasso: { messages: 3, window_ms: 5000 }, guard: { turns: 60 }, agents: { egpt: { configuration: 'egpt', handles: ['e'], default: true } } }),
      startBridge: async () => ({ async send(text) { sent.push(text); return { ok: true }; }, startStreamMessage() { return { delivered: false, update() {}, async finish() {} }; }, isAlive: () => true, stop() {} }),
      makeSession: () => ({ sessionId: 's', async turn() { return { text: 'ok' }; }, close() {} }),
      loadState: async () => (await import('../src/conversations-state.mjs')).emptyState(),
      writeState: async () => {},
      ingest: false, tickMs: 0, exit: (c) => exits.push(c), log: { line: (s) => lines.push(s) },
    });
    try {
      await Promise.all(Array.from({ length: 4 }, (_, i) => app.bridge.send(`!room${i}:beeper.com`, `x${i}`)));
      await new Promise((r) => setImmediate(r));
      expect(sent).toHaveLength(3);
      expect(exits).toEqual([0]);
      expect(readFileSync(join(bootHome, 'STOP'), 'utf8')).toContain('reason: loop_guard: outbound message flood');
      const dep = lines.filter((l) => l.includes('deprecated config.yaml key'));
      expect(dep).toHaveLength(1);
      expect(dep[0]).toMatch(/\[loop_guard\] .*guard: read as loop_guard\.inbound; lasso: read as loop_guard\.outbound/);
    } finally { app.stop(); }
  });
});

describe('the rename is complete', () => {
  const REPO = fileURLToPath(new URL('..', import.meta.url));
  const SKIP_DIRS = new Set(['node_modules', '.git']);
  const TEXT = /\.(mjs|js|cjs|json|md|ya?ml|cmd|ps1|psm1|sh|txt|html|css)$/i;
  const ALLOWED = new Set(['migrations/0044-the-loop-guard-is-one-block.mjs', 'tests/migrations-0044-the-loop-guard-is-one-block.test.mjs']);
  const walk = (dir) => readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    const st = statSync(p);
    if (st.isDirectory()) return SKIP_DIRS.has(n) ? [] : walk(p);
    return TEXT.test(n) ? [p] : [];
  });

  it('no "lasso" outside 0044 and the legacy-key constant', () => {
    const hits = [];
    for (const p of walk(REPO)) {
      const rel = relative(REPO, p).split(sep).join('/');
      if (ALLOWED.has(rel)) continue;
      readFileSync(p, 'utf8').split('\n').forEach((line, i) => {
        if (!/lasso/i.test(line)) return;
        if (rel === 'src/loop-guard.mjs' && line.startsWith('export const LEGACY_BLOCKS = ')) return;
        hits.push(`${rel}:${i + 1}: ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
