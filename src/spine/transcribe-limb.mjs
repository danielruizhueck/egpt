// transcribe-limb.mjs — the /transcribe limb (operator 2026-10-16: "All audio should be worked at
// dolly, reve is a fallback"). A file in the being's own folder goes through THE transcription
// service (src/spine/transcription.mjs: its fallback_order, worker first, the local cli only when the
// worker fails); the text is written beside the file. src/spine/reply-actions.mjs confines the path
// and wakes the being with the outcome. `background` lists the jobs in flight for liveness.
import { writeFile } from 'node:fs/promises';
import { elapsed } from './sender.mjs';

export function createTranscribeLimb({ transcribe, cfg = {}, getConfig = () => ({}), now = () => Date.now(), write = writeFile, log = () => {} } = {}) {
  const jobs = new Map();   // `${being} ${surface} ${chatId}` → Set<{ description, since }>
  const keyOf = (being, ev) => `${being} ${ev?.surface} ${ev?.chatId}`;

  // Where the decode is expected: the first worker rung's own name, until the chain decodes here.
  function firstWorker() {
    const svc = getConfig()?.transcription_service;
    const profile = svc?.[svc?.use_config];
    return (profile?.fallback_order ?? []).find((n) => profile?.[n]?.type === 'whisper-server-remote') ?? null;
  }

  // (action, ev, being, abs) -> { outcome: done|failed, detail }. Never throws.
  async function run(a, ev, being, abs) {
    const k = keyOf(being, ev);
    const where = firstWorker();
    const job = { description: `transcribing ${a.path}${where ? ` on ${where}` : ''}`, since: now() };
    if (!jobs.has(k)) jobs.set(k, new Set());
    jobs.get(k).add(job);
    const onHere = () => { job.description = `transcribing ${a.path} on ${getConfig()?.node_name ?? 'this node'}`; };
    try {
      const meta = {};
      const text = await transcribe(abs, cfg, log, meta, onHere);
      if (!text) return { outcome: 'failed', detail: 'no engine produced a transcript' };
      await write(`${abs}.transcript.txt`, `${text}\n`, 'utf8');
      const how = [Number.isFinite(meta.durationSec) ? `${elapsed(meta.durationSec * 1000)} of audio` : null, meta.engine ? `via ${meta.engine}` : null].filter(Boolean).join(', ');
      return { outcome: 'done', detail: `${a.path}.transcript.txt${how ? ` (${how})` : ''}` };
    } catch (e) {
      return { outcome: 'failed', detail: e?.message ?? String(e) };
    } finally {
      jobs.get(k)?.delete(job);
      if (!jobs.get(k)?.size) jobs.delete(k);
    }
  }

  return {
    transcribe: run,
    background: (being, ev) => [...(jobs.get(keyOf(being, ev)) ?? [])].map((j) => ({ ...j })),
  };
}
