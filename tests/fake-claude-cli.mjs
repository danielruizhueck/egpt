// tests/fake-claude-cli.mjs — a fake `claude` speaking stream-json, and an in-memory IPC pair, for the
// daemon-held sessions (src/cli-host.mjs). Shared by tests/cli-host.test.mjs and boot-cli-host.test.mjs.
import { EventEmitter } from 'node:events';

// The daemon's child handle ⇄ the spine's `process`, async and JSON-cloned like node's IPC.
export function ipcPair() {
  const daemonSide = Object.assign(new EventEmitter(), { connected: true });
  const spineSide = Object.assign(new EventEmitter(), { connected: true });
  const deliver = (to, m) => setImmediate(() => { if (to.connected) to.emit('message', JSON.parse(JSON.stringify(m))); });
  daemonSide.send = (m) => deliver(spineSide, m);
  spineSide.send = (m) => deliver(daemonSide, m);
  const drop = () => { daemonSide.connected = spineSide.connected = false; daemonSide.emit('disconnect'); spineSide.emit('disconnect'); };
  return { daemonSide, spineSide, drop };
}

// A `claude --input-format stream-json` that answers `echo:<text>`. "bg:" in a message starts a
// background task; finishBg() completes it the way 2.1.301 does (notification, then a turn of its own).
export function fakeClaude(pid) {
  const c = new EventEmitter();
  Object.assign(c, { pid, killed: false, ended: false, lines: [], controls: [], model: 'sonnet', held: null });
  c.stdout = Object.assign(new EventEmitter(), { setEncoding() {} });
  c.stderr = Object.assign(new EventEmitter(), { setEncoding() {} });
  const out = (ev) => c.stdout.emit('data', `${JSON.stringify({ session_id: 'sess-1', ...ev })}\n`);
  const answer = (text) => {
    out({ type: 'system', subtype: 'init', model: c.model });
    out({ type: 'user', isReplay: true, message: { role: 'user', content: [{ type: 'text', text }] } });
    if (text.includes('bg:')) out({ type: 'system', subtype: 'background_tasks_changed', tasks: [{ task_id: 'b1', description: 'audit' }] });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: `echo:${text}` } } });
    out({ type: 'result', subtype: 'success', result: `echo:${text}` });
  };
  c.stdin = {
    write(data) {
      for (const line of String(data).split('\n').filter(Boolean)) {
        const m = JSON.parse(line);
        if (m.type === 'control_request') {
          c.controls.push(m.request);
          const ok = (response) => out({ type: 'control_response', response: { subtype: 'success', request_id: m.request_id, ...(response && { response }) } });
          if (m.request.subtype === 'set_model' && m.request.model === 'bogus') out({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: "Model 'bogus' not found" } });
          else if (m.request.subtype === 'set_model') { c.model = m.request.model; ok(); }
          else if (m.request.subtype === 'interrupt') { ok({ still_queued: [] }); if (c.held) { c.held = null; out({ type: 'result', subtype: 'error_during_execution' }); } }
          else ok();
          continue;
        }
        const text = m.message.content.map((x) => x.text).join('');
        c.lines.push(text);
        if (c.holdNext) { c.holdNext = false; c.held = () => answer(text); } else setImmediate(() => answer(text));
      }
      return true;
    },
    end() { c.ended = true; },
    on() { return c.stdin; },
  };
  c.kill = () => { if (!c.killed) { c.killed = true; setImmediate(() => c.emit('close', null, 'SIGTERM')); } return true; };
  c.release = () => { const h = c.held; c.held = null; h?.(); };
  c.finishBg = () => {
    out({ type: 'system', subtype: 'task_notification', task_id: 'b1', status: 'completed' });
    out({ type: 'system', subtype: 'background_tasks_changed', tasks: [] });
    out({ type: 'system', subtype: 'init', model: c.model });
    out({ type: 'user', isReplay: true, origin: { kind: 'task-notification' }, message: { role: 'user', content: [{ type: 'text', text: '<task-notification>' }] } });
    out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'the audit is done' } } });
    out({ type: 'result', subtype: 'success', result: 'the audit is done', origin: { kind: 'task-notification' } });
  };
  return c;
}
