// config-reload-on-change.test.mjs — the heartbeat/config set is re-walked only when something
// it reads changed (operator 2026-10-18: "heartbeats, config, etc, should be at worst hot
// reloaded *on change*"). The walk's fingerprint (boot configInputsStamp) is the stats of every
// file the walk reads; a reload whose fingerprint and node config are unchanged walks nothing and
// writes nothing. A caller arriving while a reload runs waits for it.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { promises as fs } from 'node:fs';
import { join } from 'node:path';
import os from 'node:os';
import { createConfigResolver } from '../src/spine/config-resolver.mjs';
import { createHeartbeatLoader } from '../src/spine/heartbeat-loader.mjs';
import { configInputsStamp } from '../src/spine/boot.mjs';
import { RACY_MS } from '../src/stat-cache.mjs';

const registry = () => { const registered = []; return { registered, register: (name, everyMs, fn) => registered.push({ name, everyMs, fn }), clear: () => { registered.length = 0; }, runDue() {} }; };

function harness({ stampOf = () => 's1', cfg = { heartbeats: { alive: { frequency: '1s' } } } } = {}) {
  const n = { walks: 0, writes: 0 };
  let stampValue = stampOf;
  let config = cfg;
  const resolver = createConfigResolver({
    getConfig: () => config,
    listEntityDirs: async () => { n.walks++; await new Promise((r) => setTimeout(r, 5)); return [{ dir: '/c/x', ns: 'whatsapp/x' }]; },
    readEntityConfig: async () => ({ heartbeats: { ping: { frequency: '30s', command: 'echo' } } }),
    stamp: async () => stampValue(),
    io: { writeFile: async () => { n.writes++; }, mkdir: async () => {} },
  });
  const loader = createHeartbeatLoader({ resolver, egptHome: '/home', platform: 'linux', io: { writeFile: async () => { n.writes++; }, mkdir: async () => {} }, now: () => 0 });
  return { n, resolver, loader, setStamp: (f) => { stampValue = f; }, setConfig: (c) => { config = c; } };
}

describe('resolver.changed', () => {
  it('false while the fingerprint and the node config are the ones the last walk read', async () => {
    const h = harness();
    await h.resolver.collect();
    expect(await h.resolver.changed()).toBe(false);
    h.setStamp(() => 's2');
    expect(await h.resolver.changed()).toBe(true);
    await h.resolver.collect();
    expect(await h.resolver.changed()).toBe(false);
    h.setConfig({ heartbeats: {} });                      // config.yaml swapped (applyConfig)
    expect(await h.resolver.changed()).toBe(true);
  });

  it('no stamp seam → always changed (every caller that injects its own registry)', async () => {
    const resolver = createConfigResolver({ getConfig: () => ({}) });
    await resolver.collect();
    expect(await resolver.changed()).toBe(true);
  });
});

describe('heartbeat loader reload — on change only', () => {
  async function activated(opts) {
    const h = harness(opts);
    h.loader.wrapRegistry(registry());
    await h.loader.collect();
    await h.loader.activate({ stats: () => ({}), tickMs: 30_000 });
    h.n.walks = 0; h.n.writes = 0;
    return h;
  }

  it('nothing changed → no walk, no readonly writes', async () => {
    const h = await activated();
    await h.loader.reload();
    await h.loader.reload();
    expect(h.n.walks).toBe(0);
    expect(h.n.writes).toBe(0);
  });

  it('a changed file → one walk and the three aggregates', async () => {
    const h = await activated();
    h.setStamp(() => 's2');
    await h.loader.reload();
    expect(h.n.walks).toBe(1);
    expect(h.n.writes).toBe(3);
  });

  it('a caller arriving mid-reload waits for it (two lanes, one walk)', async () => {
    const h = await activated();
    h.setStamp(() => 's3');
    const first = h.loader.reload();
    let secondDone = false;
    const second = h.loader.reload().then(() => { secondDone = true; });
    await new Promise((r) => setTimeout(r, 1));
    expect(secondDone).toBe(false);                      // not waved through on a half-built set
    await Promise.all([first, second]);
    expect(h.n.walks).toBe(1);
  });
});

describe('configInputsStamp — the walk\'s fingerprint', () => {
  let dir;
  beforeEach(async () => { dir = await fs.mkdtemp(join(os.tmpdir(), 'egpt-stamp-')); });
  afterEach(async () => { await fs.rm(dir, { recursive: true, force: true }); });
  const old = async (p) => { const t = (Date.now() - RACY_MS * 5) / 1000; await fs.utimes(p, t, t); };

  async function fixture() {
    const conv = join(dir, 'conversations.yaml');
    await fs.writeFile(conv, 'contacts: {}\n', 'utf8'); await old(conv);
    const a = join(dir, 'a'), b = join(dir, 'b');
    await fs.mkdir(join(a, 'heartbeats'), { recursive: true });
    await fs.mkdir(b, { recursive: true });
    const beat = join(a, 'heartbeats', 'own.yaml');
    await fs.writeFile(beat, 'frequency: 1h\ncommand: echo\n', 'utf8'); await old(beat);
    const dirs = [{ dir: a, ns: 'whatsapp/a' }, { dir: b, ns: 'whatsapp/b' }];
    return { conv, beat, b, dirs, stamp: () => configInputsStamp({ files: [conv], listDirs: async () => dirs }) };
  }

  it('unchanged → the same stamp; an empty heartbeats/ folder is no beat', async () => {
    const f = await fixture();
    const s1 = await f.stamp();
    await fs.mkdir(join(f.b, 'heartbeats'));             // the room tree's empty folder
    expect(await f.stamp()).toBe(s1);
  });

  it('a being edits its beat, adds one, or the registry is written → a new stamp', async () => {
    const f = await fixture();
    const s1 = await f.stamp();
    await fs.writeFile(f.beat, 'frequency: 2h\ncommand: echo two\n', 'utf8'); await old(f.beat);
    const s2 = await f.stamp();
    expect(s2).not.toBe(s1);
    await fs.mkdir(join(f.b, 'heartbeats'), { recursive: true });
    await fs.writeFile(join(f.b, 'heartbeats', 'new.yaml'), 'x: 1\n', 'utf8'); await old(join(f.b, 'heartbeats', 'new.yaml'));
    const s3 = await f.stamp();
    expect(s3).not.toBe(s2);
    await fs.writeFile(f.conv, 'contacts: { whatsapp: {} }\n', 'utf8'); await old(f.conv);
    expect(await f.stamp()).not.toBe(s3);
  });

  it('a file written within RACY_MS reads as changed every time (a same-tick rewrite keeps its stat)', async () => {
    const f = await fixture();
    await fs.writeFile(f.conv, 'contacts: {}\n', 'utf8');
    const s1 = await f.stamp();
    await new Promise((r) => setTimeout(r, 2));
    expect(await f.stamp()).not.toBe(s1);
  });
});
