// The spine runs at NORMAL priority and every being process at BELOW_NORMAL, so a being's
// job can never starve the spine. Both are best-effort: a refusal is logged, never thrown.
import { constants, setPriority as osSetPriority } from 'node:os';

const { PRIORITY_NORMAL, PRIORITY_BELOW_NORMAL } = constants.priority;

export function raiseSelfToNormal({ onLog, setPriority = osSetPriority } = {}) {
  try { setPriority(0, PRIORITY_NORMAL); }
  catch (e) { onLog?.(`process-priority: could not raise this process to normal (${e?.message ?? e})`); }
}

export function lowerChild(pid, { onLog, setPriority = osSetPriority } = {}) {
  if (!Number.isInteger(pid) || pid <= 0) return;   // a failed spawn has no pid, and 0 would be ourselves
  try { setPriority(pid, PRIORITY_BELOW_NORMAL); }
  catch (e) { onLog?.(`process-priority: could not lower pid ${pid} to below-normal (${e?.message ?? e})`); }
}
