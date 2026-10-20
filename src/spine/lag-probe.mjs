// lag-probe.mjs — is the spine's one event loop keeping up? (operator 2026-10-18, after 10-15:
// 2+ min behind for every chat, unnoticed until "E isn't answering").
//
// Every every_ms: the loop delay (perf_hooks histogram) and the fast pump's oldest wait. Over
// threshold_ms → ONE line to the logging group with what the process can see without a debug port.
// Re-posted at most every 10 min while it lasts; one "recovered" line after a clean minute.
// A one-line baseline goes to the node log every 5 min.
// A gap the node slept through (wall clock ≫ monotonic, or a Windows standby in the System log) → one 💤 line.
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { cpus as osCpus, freemem, totalmem } from 'node:os';
import { execFile } from 'node:child_process';

export const LAG_DEFAULTS = { threshold_ms: 10_000, every_ms: 5_000 };
const REPEAT_MS = 10 * 60_000;
const RECOVER_MS = 60_000;
const SUMMARY_MS = 5 * 60_000;
const SLOWEST = 5;

const dur = (ms) => (ms < 1000 ? `${Math.round(ms)}ms` : ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`);
const span = (ms) => (ms < 60_000 ? dur(ms) : ms < 3_600_000 ? `${Math.round(ms / 60_000)}m` : `${Math.floor(ms / 3_600_000)}h${Math.floor(ms / 60_000) % 60}m`);
const hm = (ms) => new Date(ms).toTimeString().slice(0, 5);
const pct = (x) => `${Math.round(x || 0)}%`;
const mb = (b) => `${Math.round(b / 2 ** 20)}MB`;
const gb = (b) => (b / 2 ** 30).toFixed(1);
const short = (s) => { s = String(s ?? ''); return s.length > 24 ? `${s.slice(0, 23)}…` : s; };

// Two windows (per sample, per summary). The histogram records timer intervals: minus resolution = delay.
export function createLoopDelay({ resolution = 20 } = {}) {
  const hs = [monitorEventLoopDelay({ resolution }), monitorEventLoopDelay({ resolution })];
  for (const h of hs) h.enable();
  const ms = (ns) => Math.max(0, ns / 1e6 - resolution);
  const read = (h) => { const r = { p50: ms(h.percentile(50)), p99: ms(h.percentile(99)), max: ms(h.max) }; h.reset(); return r; };
  return { sample: () => read(hs[0]), summary: () => read(hs[1]), stop: () => { for (const h of hs) h.disable(); } };
}

// typeperf: % of one core per process. PDH sees every account's processes (Get-Process does not, unelevated).
export function parseTypeperf(out) {
  const rows = String(out ?? '').split(/\r?\n/).filter((l) => l.startsWith('"'));
  if (rows.length < 2) return [];
  const cells = (l) => l.trim().slice(1, -1).split('","');
  const vals = cells(rows[rows.length - 1]).slice(1);
  return cells(rows[0]).slice(1)
    .map((h, i) => ({ name: /\\Process\((.*)\)\\/.exec(h)?.[1] ?? h, pct: Number(vals[i]) }))
    .filter((p) => Number.isFinite(p.pct) && !['_Total', 'Idle', 'typeperf'].includes(p.name));
}
// ps pcpu: a decaying average on macOS, the lifetime average on Linux.
export function parsePs(out) {
  return String(out ?? '').split('\n').map((l) => /^\s*([\d.]+)\s+(.+?)\s*$/.exec(l)).filter(Boolean)
    .map((m) => ({ name: m[2].split('/').pop(), pct: Number(m[1]) }));
}
const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { windowsHide: true, timeout: 20_000, maxBuffer: 4 * 2 ** 20 }, (e, out) => (e ? reject(e) : resolve(out)));
});
export async function topProcesses({ platform = process.platform, exec = run } = {}) {
  const all = platform === 'win32'
    ? parseTypeperf(await exec('typeperf', ['\\Process(*)\\% Processor Time', '-sc', '1']))
    : parsePs(await exec('ps', ['-Ao', 'pcpu=,comm=']));
  return all.sort((a, b) => b.pct - a.pct).slice(0, 3);
}
// Windows keeps the loop's clock running through standby: did the System log record one in [from, to]?
export async function sleptBetween(from, to, { platform = process.platform, exec = run } = {}) {
  if (platform !== 'win32') return false;
  const at = (ms) => new Date(ms).toISOString();
  const q = `*[System[((Provider[@Name='Microsoft-Windows-Kernel-Power'] and (EventID=506 or EventID=507)) or (Provider[@Name='Microsoft-Windows-Power-Troubleshooter'] and EventID=1)) and TimeCreated[@SystemTime>='${at(from)}' and @SystemTime<='${at(to)}']]]`;
  return /^Event\[/m.test(await exec('wevtutil', ['qe', 'System', `/q:${q}`, '/c:1', '/f:text']));
}

// THE INTAKE CAP (spine.mjs lanes): how many chats' fast phases run at once, from the last sample.
// A quarter of it when memory runs low or the machine or the loop is busy, one past the edge.
export const INTAKE_LANES = 8;
export function intakeCap(load) {
  if (!load) return INTAKE_LANES;
  const free = load.total > 0 ? (load.free / load.total) * 100 : 100;
  const hot = Math.max(load.cpu ?? 0, load.busy ?? 0);
  if (free < 5 || hot >= 95) return 1;
  if (free < 15 || hot >= 80) return INTAKE_LANES / 4;
  return INTAKE_LANES;
}

export function createLagProbe({
  config = () => null,          // () => config.lag_probe, read every sample
  report = null,                // (text) => Promise — the logging group
  note = () => {},              // the node log
  backlog = () => ({}),         // () => ({ fast: { queueDepth, oldestMs }, turns: [[convKey, n]] })
  now = () => Date.now(),
  mono = () => performance.now(),   // stands still while Linux/macOS sleep
  loop: loopIn = null,          // { sample, summary, stop }; createLoopDelay() at start
  cpuUsage = () => process.cpuUsage(),
  elu = (a, b) => performance.eventLoopUtilization(a, b),
  cpus = osCpus,
  memory = () => ({ rss: process.memoryUsage.rss(), free: freemem(), total: totalmem() }),
  top = topProcesses,
  sleepLog = sleptBetween,      // (from, to) => Promise<bool>
  setTimeout: setT = globalThis.setTimeout,
  clearTimeout: clearT = globalThis.clearTimeout,
} = {}) {
  const knob = (k) => { const v = config()?.[k]; return v > 0 ? v : LAG_DEFAULTS[k]; };

  // A cumulative counter read over the sample window and the summary window.
  function windows(read, diff) {
    let s = null, m = null;
    return {
      reset() { s = m = read(); },
      sample() { const n = read(); const d = diff(n, s); s = n; return d; },
      summary() { const n = read(); const d = diff(n, m); m = n; return d; },
    };
  }
  const spineCpu = windows(() => ({ at: now(), u: cpuUsage() }), (n, o) => (n.u.user + n.u.system - o.u.user - o.u.system) / 10 / Math.max(1, n.at - o.at));
  const busy = windows(() => elu(), (n, o) => elu(n, o).utilization * 100);
  const nodeCpu = windows(() => {
    const cs = cpus(); let b = 0, t = 0;
    for (const { times: x } of cs) { const u = x.user + x.nice + x.sys + x.irq; b += u; t += u + x.idle; }
    return { b, t, cores: cs.length };
  }, (n, o) => ({ pct: ((n.b - o.b) / Math.max(1, n.t - o.t)) * 100, cores: n.cores }));

  // --- spine steps: timed in place, the slowest kept per summary window (this one + the last) ---
  const open = new Set();
  let slow = [], slowPrev = [];
  const names = new Map();      // chatId -> chatName, to name a turn key's chat
  const chatOf = (ev) => short(ev?.chatName || ev?.chatId || '-');
  function record(s) {
    if (slow.length >= SLOWEST && s.ms <= slow[SLOWEST - 1].ms) return;
    slow = [...slow, s].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST);
  }
  function time(name, ev, fn) {
    const s = { name, ev, at: now(), ms: 0 };
    if (ev?.chatId && ev.chatName) names.set(ev.chatId, ev.chatName);
    open.add(s);
    const end = () => { open.delete(s); s.ms = now() - s.at; record(s); };
    let r;
    try { r = fn(); } catch (e) { end(); throw e; }
    if (typeof r?.then !== 'function') { end(); return r; }
    return Promise.resolve(r).finally(end);
  }
  const slowest = () => [...slow, ...slowPrev].sort((a, b) => b.ms - a.ms).slice(0, SLOWEST).map((s) => ({ name: s.name, chat: chatOf(s.ev), ms: s.ms }));

  // --- the line ---
  function post(line) {
    note(line);
    if (report) Promise.resolve().then(() => report(line)).catch((e) => note(`lag probe: logging group refused the line — ${e?.message ?? e}`));
  }
  async function alert(head, l, sys) {
    const { fast = {}, turns = [] } = backlog() ?? {};
    const t = now();
    const parts = [`loop max ${dur(l.max)} p99 ${dur(l.p99)}, busy ${pct(sys.busy)}`];
    if (fast.queueDepth) parts.push(`fast queue ${fast.queueDepth} (oldest ${dur(fast.oldestMs ?? 0)})`);
    const stuck = [...open].sort((a, b) => a.at - b.at)[0];
    if (stuck && t - stuck.at >= 1000) parts.push(`in ${stuck.name}@${chatOf(stuck.ev)} ${dur(t - stuck.at)}`);
    if (turns.length) {
      const [key, n] = [...turns].sort((a, b) => b[1] - a[1])[0];
      const [being, , ...rest] = String(key).split(':');
      const id = rest.join(':');
      parts.push(`turns ${turns.length} chats/${turns.reduce((s, [, k]) => s + k, 0)}, most ${being}@${short(names.get(id) ?? id)} ×${n}`);
    }
    const m = memory();
    parts.push(`spine CPU ${pct(sys.spine)} rss ${mb(m.rss)}`, `node CPU ${pct(sys.node.pct)} of ${sys.node.cores} cores, free ${gb(m.free)}/${gb(m.total)}GB`);
    const s = slowest();
    try {
      const procs = await top();
      if (procs?.length) parts.push(`top ${procs.map((p) => `${p.name} ${pct(p.pct)}`).join(', ')}`);
    } catch (e) { note(`lag probe: top processes unavailable — ${e?.message ?? e}`); }
    if (s.length) parts.push(`slowest ${s.map((x) => `${x.name}@${x.chat} ${dur(x.ms)}`).join(', ')}`);
    post(`${head} — ${parts.join(' · ')}`);
  }

  // --- the sample ---
  let lagging = null;           // { since, postedAt, worst, clearSince }
  let fastMax = 0, summaryAt = 0, timer = null, loop = null, last = null, prev = null, ruling = Promise.resolve();
  function sample() {
    const t = now(), m = mono();
    const l = loop.sample();
    const fast = backlog()?.fast ?? {};
    fastMax = Math.max(fastMax, fast.queueDepth ?? 0);
    const sys = { spine: spineCpu.sample(), busy: busy.sample(), node: nodeCpu.sample() };
    const { free, total } = memory();
    last = { cpu: sys.node.pct, busy: sys.busy, free, total };
    const lag = Math.max(l.max, fast.oldestMs ?? 0);
    const gap = { from: prev.t, slept: t - prev.t - (m - prev.m) };
    prev = { t, m };
    ruling = ruling.then(() => judge(t, lag, l, sys, gap)).catch((e) => note(`lag probe: ${e?.message ?? e}`));
    if (t - summaryAt >= SUMMARY_MS) summarize(t);
  }
  // In sample order: a sample waits behind the previous one's sleep check.
  async function judge(t, lag, l, sys, gap) {
    const fire = (head) => alert(head, l, sys).catch((e) => note(`lag probe: ${e?.message ?? e}`));
    if (lag >= knob('threshold_ms')) {
      if (!lagging) {
        if (await asleep(t, gap)) return post(`💤 was asleep ${span(t - gap.from)} (${hm(gap.from)} → ${hm(t)})`);
        lagging = { since: t, postedAt: t, worst: lag, clearSince: null };
        fire(`spine lagging ${dur(lag)}`);
      } else {
        lagging.worst = Math.max(lagging.worst, lag);
        lagging.clearSince = null;
        if (t - lagging.postedAt >= REPEAT_MS) {
          lagging.postedAt = t;
          fire(`spine still lagging ${dur(lag)} (for ${span(t - lagging.since)}, worst ${dur(lagging.worst)})`);
        }
      }
    } else if (lagging) {
      lagging.clearSince ??= t;
      if (t - lagging.clearSince >= RECOVER_MS) {
        post(`spine recovered after ${span(lagging.clearSince - lagging.since)} (worst ${dur(lagging.worst)})`);
        lagging = null;
      }
    }
  }
  async function asleep(t, { from, slept }) {
    if (slept >= knob('threshold_ms')) return true;
    try { return await sleepLog(from, t); } catch (e) { note(`lag probe: sleep check failed — ${e?.message ?? e}`); return false; }
  }
  function summarize(t) {
    const l = loop.summary();
    const m = memory();
    const s = slow[0];
    note(`lag ${span(t - summaryAt)}: p50 ${dur(l.p50)} p99 ${dur(l.p99)} max ${dur(l.max)} · busy ${pct(busy.summary())} · spine CPU ${pct(spineCpu.summary())} rss ${mb(m.rss)} · node CPU ${pct(nodeCpu.summary().pct)} · fast queue max ${fastMax}${s ? ` · slowest ${s.name}@${chatOf(s.ev)} ${dur(s.ms)}` : ''}`);
    summaryAt = t;
    slowPrev = slow; slow = []; fastMax = 0;
  }

  function arm() {
    timer = setT(() => {
      timer = null;
      try { sample(); } catch (e) { note(`lag probe: ${e?.message ?? e}`); }
      if (loop) arm();
    }, knob('every_ms'));
    timer?.unref?.();
  }
  function start() {
    if (loop) return;
    loop = loopIn ?? createLoopDelay();
    spineCpu.reset(); busy.reset(); nodeCpu.reset();
    summaryAt = now();
    prev = { t: summaryAt, m: mono() };
    arm();
  }
  function stop() {
    if (timer) clearT(timer);
    timer = null;
    loop?.stop?.();
    loop = null;
  }
  // The last sample's load ({ cpu, busy, free, total }), null before the first: intakeCap's input.
  return { start, stop, time, slowest, load: () => last };
}
