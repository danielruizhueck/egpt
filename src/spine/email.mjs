// email.mjs — the ONE Amazon SES path (SES v2 SendEmail, SigV4 over node:crypto + fetch) and the
// /email limb that rides it. /book's invitation rides the same `ses` (src/spine/book.mjs).
//
// THE SECRET BOUNDARY (same as src/spine/login.mjs):
//   - the AWS keys are locals: they sign the request and are never returned, logged or posted;
//   - every output is an outcome token: 'sent' | 'not-configured' | 'failed';
//   - recipients, sender and subject prefix come from config only. The being supplies body text,
//     which lands in Body.Text (or a base64 MIME part), never in a header.
import { createHash, createHmac } from 'node:crypto';
import { readFile as fsReadFile } from 'node:fs/promises';

export const EMAIL_OUTCOMES = ['sent', 'not-configured', 'failed'];
const TIMEOUT_MS = 20_000;
const SES_PATH = '/v2/email/outbound-emails';

const sha256 = (s) => createHash('sha256').update(s).digest('hex');
const hmac = (k, s) => createHmac('sha256', k).update(s).digest();

// AWS Signature Version 4 → the Authorization header value.
export function sigv4({ method, host, path = '/', query = '', headers = {}, body = '', region, service, accessKeyId, secretAccessKey, amzDate }) {
  const all = { ...Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v).trim()])), host, 'x-amz-date': amzDate };
  const names = Object.keys(all).sort();
  const canonical = [method, path, query, names.map((k) => `${k}:${all[k]}\n`).join(''), names.join(';'), sha256(body)].join('\n');
  const scope = `${amzDate.slice(0, 8)}/${region}/${service}/aws4_request`;
  const toSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonical)].join('\n');
  let k = hmac(`AWS4${secretAccessKey}`, amzDate.slice(0, 8));
  for (const part of [region, service, 'aws4_request']) k = hmac(k, part);
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(';')}, Signature=${createHmac('sha256', k).update(toSign).digest('hex')}`;
}

export const addressList = (v) => (Array.isArray(v) ? v : (v == null ? [] : [v])).map((x) => String(x ?? '').trim()).filter(Boolean);
// One header-safe line: no control characters, collapsed whitespace.
export const oneLine = (s, max = 200) => String(s ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);

export function createEmail({ getConfig = () => ({}), fetch = (...a) => globalThis.fetch(...a), readFile = fsReadFile, now = () => Date.now(), log = () => {} } = {}) {
  const cfg = () => getConfig()?.email || {};

  // Inline keys, else an AWS shared-credentials file (aws_access_key_id / aws_secret_access_key lines).
  async function credentials(c) {
    if (c.aws_access_key_id && c.aws_secret_access_key) return { id: String(c.aws_access_key_id), secret: String(c.aws_secret_access_key) };
    if (!c.credentials_file) return null;
    let text;
    try { text = await readFile(String(c.credentials_file), 'utf8'); } catch { return null; }
    const id = /^\s*aws_access_key_id\s*=\s*(\S+)/m.exec(text)?.[1];
    const secret = /^\s*aws_secret_access_key\s*=\s*(\S+)/m.exec(text)?.[1];
    return id && secret ? { id, secret } : null;
  }

  // SES itself: the sender + keys. `gaps` names what is missing by key NAME only.
  async function ready(c) {
    const creds = await credentials(c);
    return { creds, gaps: [...(String(c.from ?? '').trim() ? [] : ['email.from']), ...(creds ? [] : ['email credentials'])] };
  }

  /**
   * The ONE SendEmail. `to` is decided by the caller from config; content is Simple
   * ({subject, text}) or a raw MIME message ({raw}). Never throws.
   */
  async function ses({ to, subject, text, raw = null, what = 'ses' } = {}) {
    const c = cfg();
    const dest = addressList(to);
    const { creds, gaps } = await ready(c);
    if (!dest.length) gaps.push('recipients');
    if (gaps.length) { log(`${what} -> not-configured (missing ${gaps.join(', ')})`); return 'not-configured'; }
    const scrub = (s) => String(s ?? '').split(creds.secret).join('***').split(creds.id).join('***');
    try {
      const region = String(c.region || 'us-east-1');
      const host = `email.${region}.amazonaws.com`;
      const content = raw != null
        ? { Raw: { Data: Buffer.from(String(raw), 'utf8').toString('base64') } }
        : { Simple: { Subject: { Data: oneLine(subject), Charset: 'UTF-8' }, Body: { Text: { Data: String(text ?? ''), Charset: 'UTF-8' } } } };
      const body = JSON.stringify({ FromEmailAddress: String(c.from).trim(), Destination: { ToAddresses: dest }, Content: content });
      const amzDate = new Date(now()).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
      const headers = { 'content-type': 'application/json' };
      const authorization = sigv4({ method: 'POST', host, path: SES_PATH, headers, body, region, service: 'ses', accessKeyId: creds.id, secretAccessKey: creds.secret, amzDate });
      const res = await fetch(`https://${host}${SES_PATH}`, { method: 'POST', headers: { ...headers, 'x-amz-date': amzDate, authorization }, body, signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (res.ok) { log(`${what} -> sent (${dest.length} recipient${dest.length === 1 ? '' : 's'})`); return 'sent'; }
      let detail = '';
      try { detail = await res.text(); } catch { /* no body */ }
      log(`${what} -> failed (HTTP ${res.status} ${oneLine(scrub(detail), 160)})`);
      return 'failed';
    } catch (e) {
      log(`${what} -> failed (${oneLine(scrub(e?.name === 'TimeoutError' ? 'timeout' : e?.message), 120)})`);
      return 'failed';
    }
  }

  // The /email limb: the lead summary to the FIXED email.to list under the FIXED subject prefix.
  async function email(a, ev = {}, being = '') {
    const c = cfg();
    const where = ev?.chatName ?? ev?.chatId ?? '?';
    const subject = `${c.subject_prefix ?? '[eGPT]'} ${where}`;
    const text = `${String(a?.text ?? '')}\n\n--\n${where} · ${ev?.surface ?? '?'} · eGPT ${being}`;
    return { outcome: await ses({ to: c.to, subject, text, what: 'email' }) };
  }

  return { ses, email, missing: async () => (await ready(cfg())).gaps };
}
