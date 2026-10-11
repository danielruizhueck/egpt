// src/spine/being-link.mjs — WHO MAY ASK THE SPINE FOR WHAT: the per-session credentials a boxed
// being is handed, and the ONE request it may make with one (operator 2026-09-26: "for now only the
// browser"). The wire is src/shell/being.mjs; the limb that carries it is src/bridges/shell-port.mjs;
// this module owns every decision in between.
//
// A CREDENTIAL PER SESSION, NEVER THE NODE'S. The console already authenticates with the node's
// shell token, and handing that to a boxed being would hand every boxed being the operator's
// console — `/upgrade` and all (src/shell/auth.mjs header). So the spine mints 32 random bytes
// when it opens a BOXED session (src/sandbox-cli-session.mjs asks, through the handle brainpool
// hands it), registers them against WHO that session is — being, surface, slug — and forgets them
// when the session closes. The warm pool closes a session on every eviction (src/warm-sessions.mjs
// _evict), so a secret lives exactly as long as the process it was handed to, and a background
// process a being left running with that environment is refused from the moment its session goes.
//
// THE SECRET NEVER CROSSES THE WIRE. The being answers the SAME nonce challenge the operator's
// editor answers (auth.mjs's authMac, macMatches — imported, never re-implemented), keyed by its
// own secret, and `identify` below finds which live credential produced the answer. That is one
// HMAC per live boxed session per dial — the warm pool's `max`, single digits — and it means the
// wire carries no session id either, so there is nothing on it to replay or to guess at.
// Loopback is not an authenticator (a pool account dials 127.0.0.1 as freely as anyone): an answer
// no live credential produced is refused, and the limb says so in the log.
//
// ONE REQUEST, NO ARGUMENTS. The table below is the routing table AND the allowlist, the shape
// shell-port's MOUTH_ANSWER already uses: a pair not in it is refused, and a frame carrying ANY
// field besides `ask` and `action` is refused before the table is even consulted — the being
// chooses nothing about what runs as the operator (src/shell/being.mjs header). There is no
// access_level gate, deliberately: a being that can only ask the spine to start the browser the
// spine configures is asking for nothing it could misuse, and every boxed being may.
//
// BROWSER GROUPS (operator 2026-10-11). Every being session is minted now, unboxed too — each gets
// its chat's GROUP browser — and `browser cdp` turns the connection into a tunnel to that group's
// Chrome and no other. A boxed being's tunnel is filtered (boxedCdpRefusal); an unboxed one runs as
// `an` and is not.
import { randomBytes as nodeRandomBytes } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, dirname, basename, relative, isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { authMac, macMatches } from '../shell/auth.mjs';
import { SPINE_PORT_ENV, BEING_TOKEN_ENV, ASK_SPINE_ENV, CDP_MODULE_ENV } from '../shell/being.mjs';
import { chromeConversationOf } from './chrome-pool.mjs';
import { readBrowserGroups } from '../rooms-file.mjs';
import { slugDir } from '../conversations-state.mjs';
import { createCdpMux } from '../tools/cdp.mjs';

// WHERE THE CLIENT IS, AS A POOL ACCOUNT CAN RUN IT: the copy in the eGPT CHECKOUT (~\src\egpt),
// not the running tree this spine was started from (~\bin\egpt), and the difference is measured,
// not preferred. Both trees carry a standing ReadAndExecute for the pool group
// (setup/provision-sandbox-account.ps1), but Node realpaths a script before it runs it, and that
// walk opens EVERY ancestor directory as an object — which a pool account may do only where it
// holds (X,RA,RC,S). The provisioner grants that chain for ~ and ~\src; it grants nothing on ~\bin
// (setup/SANDBOX.md, "The traverse chain": realpathSync through an ungranted ancestor EPERMs,
// measured as a real pool account 2026-09-13). So `node ~\bin\egpt\...` would die before the
// client's first line, and ~\src\egpt is the tree every pool profile already mounts as `src`.
// The same ~\src\egpt the launcher's $repoRoot and the provisioner's $repoDir name — a third
// spelling of one path, because PowerShell cannot import this one; change all three together.
// The being never types it: it arrives in ASK_SPINE_ENV, so the card names a variable, not a
// directory under the operator's profile (the disclosure the 2026-09-23 mount ruling closed).
export function askSpineClientPath(home = homedir()) {
  return join(home, 'src', 'egpt', 'src', 'tools', 'ask-spine.mjs');
}

// WHAT A BOXED BEING MAY NOT ASK ITS CHROME (operator 2026-10-11; unboxed beings run as `an` and keep
// full CDP). Chrome runs as the operator, so each reads or writes the operator's files or reaches past
// the group. URLs are checked as Chrome's parser reads them (tabs/newlines dropped). Null, or why not.
const PRIVILEGED = /^(file|filesystem|chrome|chrome-[a-z-]+|devtools|view-source):/i;
const NOT_SERVED = /^(Extensions|PWA)\.|^(Target\.(exposeDevToolsProtocol|openDevTools|sendMessageToTarget)|Browser\.(close|crash|crashGpuProcess)|DOM\.setFileInputFiles|Page\.handleFileChooser)$/;
const privileged = (v) => (typeof v === 'string'
  ? PRIVILEGED.test(v.replace(/[\t\n\r]/g, '').replace(/^[\x00-\x20]+/, ''))
  : !!v && typeof v === 'object' && Object.values(v).some(privileged));
const realOf = (p) => { try { return realpathSync.native(p); } catch { const up = dirname(p); return up === p ? p : join(realOf(up), basename(p)); } };
const inside = (p, dir) => { if (!p || !dir) return false; const rel = relative(realOf(dir), realOf(resolve(p))); return !rel.startsWith('..') && !isAbsolute(rel); };
const isPaste = (k) => (k.commands ?? []).some((c) => /paste/i.test(c))
  || (((k.modifiers ?? 0) & 6) && (/^v$/i.test(k.key ?? '') || k.code === 'KeyV' || k.windowsVirtualKeyCode === 86))
  || (((k.modifiers ?? 0) & 8) && (k.key === 'Insert' || k.code === 'Insert' || k.windowsVirtualKeyCode === 45));
export function boxedCdpRefusal({ method, params = {} }, url, convDir) {
  if (NOT_SERVED.test(method)) return `${method} is not served to a boxed being`;
  if (privileged(url)) return `that session is on a ${url.split(':')[0]}: page`;
  if (privileged(params)) return 'file:, chrome:, devtools:, extension and view-source: URLs are not served to a boxed being';
  if (method === 'Input.dispatchDragEvent' && params.data?.files?.length) return 'dragging local files is not served to a boxed being';
  if (/^(Browser|Page)\.setDownloadBehavior$/.test(method) && /^allow/.test(params.behavior ?? '') && !inside(params.downloadPath, convDir)) return "downloads may go only into this conversation's folder";
  if (/^Browser\.(grantPermissions|setPermission)$/.test(method) && /clipboard/i.test(JSON.stringify(params))) return "the operator's clipboard is not served to a boxed being";
  if (method === 'Input.dispatchKeyEvent' && isPaste(params)) return "pasting the operator's clipboard is not served to a boxed being";
  return null;
}

// A request value quoted into the log. The being wrote it, so it is bounded and JSON-escaped: a
// newline in it cannot forge a second log line, and a long one cannot flood the file.
const quoted = (v) => JSON.stringify(String(v ?? '').slice(0, 40));

/**
 * @param {object} opts
 * @param {number} opts.port                       the console port the being dials (boot's shellPortFrom(cfg))
 * @param {(c: object) => Promise<object>} opts.startBrowser the /chrome launch path, shared (commands.startBrowser), given the being's conversation — resolves { ok, launched|alreadyRunning, reason?, detail }
 * @param {(c: object) => Promise<object>} [opts.chromeClientFor] commands.chromeClientFor — the conversation's group CDP client ({ client: { channel() } })
 * @param {() => Promise<object>} [opts.readGroups] config/browsers.yaml's groups (default rooms-file.readBrowserGroups, read fresh per ask)
 * @param {string} [opts.clientPath]               the client script handed in ASK_SPINE_ENV (default askSpineClientPath()); being-cdp.mjs sits beside it
 * @param {(m: string) => void} [opts.onLog]       the AUDIT line, one per request
 * @param {typeof nodeRandomBytes} [opts.randomBytes]
 */
export function createBeingLink({ port, startBrowser, chromeClientFor = null, readGroups = readBrowserGroups, clientPath = askSpineClientPath(), onLog = () => {}, randomBytes = nodeRandomBytes } = {}) {
  const live = new Map();       // secret -> { being, surface, slug, boxed }
  const tunnels = new Map();    // who -> its open CDP tunnels, closed when its secret is revoked
  const muxes = new WeakMap();  // a group's CDP channel -> its mux
  const cdpModule = pathToFileURL(join(dirname(clientPath), 'being-cdp.mjs')).href;

  // THE BEING'S CONVERSATION, resolved at every ask: the slug it was minted for → its browser group
  // (config/browsers.yaml, read fresh). conversation_path's basename IS the slug (conversations-state
  // ensureContact), so { slug } is the whole entry chromeConversationOf reads.
  const conversationOf = async (who) => chromeConversationOf({ slug: who.slug }, await readGroups());
  const noBrowser = (c) => ({ ok: false, reason: 'no-browser', detail: c.why || 'this chat has no browser group' });

  async function openCdp(who, sink, tag) {
    const c = await conversationOf(who);
    if (!c.group) return noBrowser(c);
    const r = await chromeClientFor(c);
    if (typeof r?.client?.channel !== 'function') return { ok: false, reason: 'launch-failed', detail: r?.why || `group ${c.group} has no browser` };
    const channel = await r.client.channel();
    if (!muxes.has(channel)) muxes.set(channel, createCdpMux(channel));
    let convDir = null;
    try { convDir = slugDir(who.surface, who.slug); } catch { /* no folder → no download dir */ }
    const guard = who.boxed ? (m, url) => {
      const why = boxedCdpRefusal(m, url, convDir);
      if (why) onLog(`${tag} cdp ${quoted(m.method)} → REFUSED: ${why}`);
      return why;
    } : null;
    const inner = await muxes.get(channel).attach(sink, guard);
    const open = tunnels.get(who) ?? new Set();
    tunnels.set(who, open);
    const tunnel = { send: inner.send, close: () => { open.delete(tunnel); inner.close(); } };
    open.add(tunnel);
    return { ok: true, detail: `group ${c.group}`, tunnel };
  }

  // THE ROUTING TABLE AND THE ALLOWLIST (module header).
  const ASKS = {
    browser: {
      start: async (who) => { const c = await conversationOf(who); return c.group ? startBrowser(c) : noBrowser(c); },
      // A TUNNEL: answered once, then every frame on the connection is one raw CDP message to the
      // chat's group Chrome (shell-port handleBeing).
      cdp: openCdp,
    },
  };

  function mint(who) {
    const secret = randomBytes(32).toString('hex');
    const bound = { being: String(who?.being ?? ''), surface: String(who?.surface ?? ''), slug: String(who?.slug ?? ''), boxed: who?.boxed === true };
    live.set(secret, bound);
    return {
      // NAME=VALUE entries for the launcher's ONE -SetEnv element (boxed) or the spawn env (unboxed).
      // The VALUES are never logged: the launcher logs names only, and nothing here logs at all.
      env: [`${SPINE_PORT_ENV}=${port}`, `${BEING_TOKEN_ENV}=${secret}`, `${ASK_SPINE_ENV}=${clientPath}`, `${CDP_MODULE_ENV}=${cdpModule}`],
      revoke() {
        live.delete(secret);
        for (const t of tunnels.get(bound) ?? []) t.close();
        tunnels.delete(bound);
      },
    };
  }

  // What one request did, as the audit line says it and the being's client prints it.
  function outcomeOf(r) {
    if (r?.tunnel) return `tunnel — ${r.detail}`;
    if (r?.ok) return r.launched ? `launched — ${r.detail ?? ''}` : `already running — ${r.detail ?? ''}`;
    return `${r?.reason ?? 'failed'} — ${r?.detail ?? ''}`;
  }

  return {
    // THE HANDLE brainpool hands a boxed session (baseOpts.beingLink): it can mint for THIS being
    // in THIS room and nothing else — sandbox-cli-session never learns who it is minting for.
    forBeing(who) { return { mint: () => mint(who) }; },

    // Which live credential produced this answer to this nonce — or null. The limb's whole
    // question at the handshake; it never sees a secret.
    identify(mac, nonce) {
      for (const [secret, who] of live) if (macMatches(mac, authMac(secret, nonce))) return who;
      return null;
    },

    // ONE request off an authenticated /being connection. Never throws; every path is audited.
    // `sink` is the connection's way back ({ send(text), end() }) — what a `browser cdp` tunnel writes to.
    async ask(who, frame, sink) {
      const tag = `${who?.being || '?'} (${who?.surface || '?'}/${who?.slug || '?'})`;
      const refuse = (reason, detail, what) => {
        onLog(`${tag} asked ${what} → REFUSED (${reason}): ${detail}`);
        return { ok: false, reason, detail };
      };
      if (!frame || frame.ask === 'result') return refuse('bad-request', 'that is not a request frame', 'something unreadable');
      const what = `${quoted(frame.ask)} ${quoted(frame.action)}`;
      // ANY OTHER FIELD IS A REFUSAL, NOT AN OMISSION: a being that tries to pass an executable, a
      // flag or a profile is told it cannot, and the log names the FIELDS it tried — never what it
      // put in them.
      if (frame.extra?.length) {
        return refuse('bad-request', `the spine takes no arguments — it alone decides what runs; this request also carried: ${frame.extra.map((k) => quoted(k)).join(', ')}`, what);
      }
      const run = Object.hasOwn(ASKS, frame.ask) && Object.hasOwn(ASKS[frame.ask], frame.action) ? ASKS[frame.ask][frame.action] : null;
      if (!run) return refuse('unknown', 'the spine serves browser start and browser cdp, nothing else', what);
      let r;
      try { r = await run(who, sink, tag); }
      catch (e) { r = { ok: false, reason: 'launch-failed', detail: String(e?.message ?? e) }; }
      onLog(`${tag} asked ${frame.ask} ${frame.action} → ${outcomeOf(r)}`);
      return r;
    },

    get size() { return live.size; },
  };
}
