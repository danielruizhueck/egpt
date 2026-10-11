// tests/fake-pipe-chrome.mjs — a fake `spawnChromePipe` for createCommands. Each launch is a fake
// child whose fds 3/4 speak \0-framed CDP to a scripted peer, so the spine's real pipe client is
// what the test drives. `browser` is shaped like a CDP client: listTabs() answers Target.getTargets,
// openTab(url) Target.createTarget, closeTab / activateTarget their Target methods; a method that
// throws becomes a CDP error. A function `(spawnOpts) => browser` picks one per launch. No real Chrome.
import { PassThrough } from 'node:stream';
import { EventEmitter } from 'node:events';

export function fakePipeChrome(browserOf = {}) {
  const calls = [];
  const handles = [];
  let pid = 1000;
  const answer = async (browser, { method, params = {} }) => {
    switch (method) {
      case 'Target.getTargets': return { targetInfos: (await (browser.listTabs?.() ?? [])).map((t) => ({ targetId: t.id, type: t.type ?? 'page', url: t.url, title: t.title })) };
      case 'Target.createTarget': return { targetId: (await browser.openTab?.(params.url)) ?? 'NEW' };
      case 'Target.closeTarget': await browser.closeTab?.(params.targetId); return {};
      case 'Target.activateTarget': await browser.activateTarget?.(params.targetId); return {};
      case 'Target.attachToTarget': return { sessionId: `S-${params.targetId}` };
      default: return {};
    }
  };
  const spawnChromePipe = async (opts) => {
    calls.push(opts);
    const browser = typeof browserOf === 'function' ? browserOf(opts) : browserOf;
    const toChrome = new PassThrough();
    const toClient = new PassThrough();
    let buf = Buffer.alloc(0);
    toChrome.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      let i;
      while ((i = buf.indexOf(0)) !== -1) {
        const frame = buf.subarray(0, i);
        buf = buf.subarray(i + 1);
        if (!frame.length) continue;
        const msg = JSON.parse(frame.toString('utf8'));
        const reply = (body) => { if (!toClient.writableEnded) toClient.write(JSON.stringify({ id: msg.id, ...body, ...(msg.sessionId ? { sessionId: msg.sessionId } : {}) }) + '\0'); };
        answer(browser, msg).then((result) => reply({ result }), (e) => reply({ error: { message: e?.message ?? String(e) } }));
      }
    });
    const child = new EventEmitter();
    child.exitCode = null;
    child.killed = false;
    child.kill = () => {
      if (child.killed) return;
      child.killed = true; child.exitCode = 0;
      toClient.end();
      child.emit('exit', 0, null);
    };
    if (opts.onExit) child.on('exit', (code, signal) => opts.onExit({ code, signal, error: null }));
    const h = { child, writable: toChrome, readable: toClient, pid: ++pid, userDataDir: opts.userDataDir };
    handles.push(h);
    return h;
  };
  return { spawnChromePipe, calls, handles };
}
