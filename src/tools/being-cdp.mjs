// src/tools/being-cdp.mjs — a being's Chrome DevTools, through its spine. Exports a `fetch` and a
// `WebSocket` that serve Chrome's localhost:9221 surface — /json, /json/list, /json/version,
// /json/new, /json/close, /json/activate and ws://…/devtools/{page,browser}/<id> — from the being's
// OWN chat's group Chrome, over the /being link (src/spine/being-link.mjs, `browser cdp`). Only
// localhost/127.0.0.1:9221 URLs are intercepted; every other URL goes to the real globals.
// A script migrates with one line:
//     const { fetch, WebSocket } = await import(process.env.EGPT_CDP);
import { createLinkTransport } from './cdp.mjs';

const LOCAL = /^(http|ws):\/\/(?:localhost|127\.0\.0\.1):9221(\/[^?#]*)?(?:\?([^#]*))?(?:#.*)?$/i;
const HOST = 'localhost:9221';
const pageUrl = (id) => `ws://${HOST}/devtools/page/${id}`;
const entry = (t) => ({ id: t.targetId, type: t.type, title: t.title, url: t.url, webSocketDebuggerUrl: pageUrl(t.targetId) });

// One link per call, closed when the call is done — or when `signal` aborts it (cdp.mjs's deadline).
async function overLink(fn, signal) {
  signal?.throwIfAborted();
  const link = createLinkTransport(process.env);
  let onAbort;
  const aborted = new Promise((_, reject) => { onAbort = () => reject(signal.reason); signal?.addEventListener('abort', onAbort, { once: true }); });
  try { return await Promise.race([link.then(async (t) => fn(await t.openBrowserSession())), aborted]); }
  finally {
    signal?.removeEventListener('abort', onAbort);
    link.then(async (t) => (await t.channel()).close(), () => {});
  }
}

export async function fetch(input, init) {
  const m = LOCAL.exec(typeof input === 'string' ? input : String(input?.url ?? input));
  if (!m || m[1].toLowerCase() !== 'http') return globalThis.fetch(input, init);
  const [, , path = '/', query = ''] = m;
  const json = (body) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json; charset=UTF-8' } });
  return overLink(async (s) => {
    if (path === '/json' || path === '/json/list') return json((await s.send('Target.getTargets')).targetInfos.map(entry));
    if (path === '/json/version') {
      const v = await s.send('Browser.getVersion');
      return json({ Browser: v.product, 'Protocol-Version': v.protocolVersion, 'User-Agent': v.userAgent, 'V8-Version': v.jsVersion, webSocketDebuggerUrl: `ws://${HOST}/devtools/browser/egpt` });
    }
    if (path === '/json/new') {
      const url = decodeURIComponent(query) || 'about:blank';
      const { targetId } = await s.send('Target.createTarget', { url });
      return json(entry({ targetId, type: 'page', title: url, url }));
    }
    const [, verb, targetId] = /^\/json\/(close|activate)\/(.+)$/.exec(path) ?? [];
    if (verb === 'close') { await s.send('Target.closeTarget', { targetId }); return new Response('Target is closing'); }
    if (verb === 'activate') { await s.send('Target.activateTarget', { targetId }); return new Response('Target activated'); }
    return new Response(`Unknown command: ${path}`, { status: 404 });
  }, init?.signal);
}

// A page endpoint attaches to its target and stamps that session on what the script sends (and
// strips it from what comes back); the browser endpoint passes messages as they are.
export class WebSocket extends EventTarget {
  static CONNECTING = 0; static OPEN = 1; static CLOSING = 2; static CLOSED = 3;
  #channel = null;
  #session = null;

  constructor(url, protocols) {
    const m = LOCAL.exec(String(url));
    if (!m || m[1].toLowerCase() !== 'ws') return new globalThis.WebSocket(url, protocols);
    super();
    Object.assign(this, { url: String(url), readyState: 0, onopen: null, onmessage: null, onclose: null, onerror: null });
    this.#open(/^\/devtools\/page\/(.+)$/.exec(m[2] ?? '')?.[1]);
  }

  async #open(targetId) {
    try {
      const transport = await createLinkTransport(process.env);
      this.#channel = await transport.channel();
      this.#channel.onClose(() => this.#ended());
      if (targetId) this.#session = (await (await transport.openBrowserSession()).send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
      if (this.readyState !== 0) { this.#channel.close(); return; }   // closed while opening
      this.#channel.onMessage((msg) => {
        if (this.#session) {
          if (msg.sessionId !== this.#session) return;
          msg = { ...msg };
          delete msg.sessionId;
        }
        this.#emit(new MessageEvent('message', { data: JSON.stringify(msg) }));
      });
      this.readyState = 1;
      this.#emit(new Event('open'));
    } catch (e) {
      this.#emit(Object.assign(new Event('error'), { message: e.message, error: e }));
      this.#channel?.close();
      this.#ended();
    }
  }

  send(text) {
    if (this.readyState !== 1) throw new Error('WebSocket is not open');
    const msg = JSON.parse(String(text));
    this.#channel.send(this.#session && !msg.sessionId ? { ...msg, sessionId: this.#session } : msg);
  }

  close() {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.#channel?.close();
  }

  #ended() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.#emit(Object.assign(new Event('close'), { code: 1000, reason: '', wasClean: true }));
  }

  #emit(ev) { this.dispatchEvent(ev); this[`on${ev.type}`]?.(ev); }
}
