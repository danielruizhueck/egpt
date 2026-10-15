// The spine runs at NORMAL priority; being processes and the batch work it waits on (whisper,
// ffmpeg, piper, Chrome) run at BELOW_NORMAL, so none of them can starve it. Best-effort: a
// refusal is logged (to swallowed.log when the site has no logger), never thrown.
import { constants, setPriority as osSetPriority } from 'node:os';
import { swallow } from './swallow.mjs';

const { PRIORITY_NORMAL, PRIORITY_BELOW_NORMAL } = constants.priority;
const report = (onLog, m, e) => (onLog ? onLog(m) : swallow('process-priority', e));

export function raiseSelfToNormal({ onLog, setPriority = osSetPriority } = {}) {
  try { setPriority(0, PRIORITY_NORMAL); }
  catch (e) { report(onLog, `process-priority: could not raise this process to normal (${e?.message ?? e})`, e); }
}

export function lowerChild(pid, { onLog, setPriority = osSetPriority } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;   // a failed spawn has no pid, and 0 would be ourselves
  try { setPriority(pid, PRIORITY_BELOW_NORMAL); }
  catch (e) { report(onLog, `process-priority: could not lower pid ${pid} to below-normal (${e?.message ?? e})`, e); }
}
