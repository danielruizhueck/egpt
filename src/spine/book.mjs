// book.mjs — the /book limb. Availability comes from the team calendar's SECRET iCal address
// (book.ics_url). A free slot is booked by an iCalendar invitation (METHOD:REQUEST) to
// book.calendar_email, sent over the /email SES path (src/spine/email.mjs `ses`); a taken one
// returns the nearest free slots inside working hours.
//
// THE SECRET BOUNDARY (as src/spine/login.mjs): ics_url is a local — fetched, never returned,
// logged or posted. Outputs: 'booked' | 'busy' (+ slots) | 'not-configured' | 'failed'. The
// attendee is book.calendar_email and the organizer email.from; the being supplies the time and
// the title only.
//
// RRULE: FREQ=DAILY|WEEKLY with INTERVAL/BYDAY/UNTIL/COUNT/WKST is expanded; any other rule is
// busy at its first instance only (logged). EXDATE / RECURRENCE-ID exceptions are not applied:
// the original instance stays busy (conservative — never a double booking).
import { randomUUID } from 'node:crypto';
import { oneLine, mimeMessage } from './email.mjs';

export const BOOK_OUTCOMES = ['booked', 'busy', 'not-configured', 'failed'];
const DEFAULT_TZ = 'America/Caracas';
const DEFAULT_MINUTES = 30;
const DEFAULT_HOURS = { days: ['mon', 'tue', 'wed', 'thu', 'fri'], start: '08:00', end: '17:00' };
const STEP_MIN = 30;     // slot grid
const OFFER = 3;         // free slots offered when busy
const BEFORE_DAYS = 2;   // search window around the requested day
const AFTER_DAYS = 7;
const TIMEOUT_MS = 20_000;
const DAY_MS = 86_400_000;

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const ICS_DAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const pad = (n) => String(n).padStart(2, '0');

// ── wall clock <-> instant in an IANA zone ──
const fmts = new Map();
function fmt(tz) {
  if (!fmts.has(tz)) fmts.set(tz, new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' }));
  return fmts.get(tz);
}
const validZone = (tz) => { try { fmt(String(tz)); return true; } catch { return false; } };
function partsIn(tz, ms) {
  const p = Object.fromEntries(fmt(tz).formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: +p.year, mo: +p.month, d: +p.day, h: +p.hour % 24, mi: +p.minute, s: +p.second, dow: DAY_NAMES.indexOf(p.weekday.slice(0, 3).toLowerCase()) };
}
function zoned(tz, y, mo, d, h = 0, mi = 0, s = 0) {
  const wall = Date.UTC(y, mo - 1, d, h, mi, s);
  const off = (t) => { const p = partsIn(tz, t); return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s) - t; };
  return wall - off(wall - off(wall));
}
function addDays({ y, mo, d }, n) {
  const t = new Date(Date.UTC(y, mo - 1, d + n));
  return { y: t.getUTCFullYear(), mo: t.getUTCMonth() + 1, d: t.getUTCDate(), dow: t.getUTCDay() };
}
const dayNo = ({ y, mo, d }) => Date.UTC(y, mo - 1, d) / DAY_MS;
const local = (tz, ms) => { const p = partsIn(tz, ms); return `${p.y}-${pad(p.mo)}-${pad(p.d)} ${pad(p.h)}:${pad(p.mi)}`; };

// ── iCalendar in ──
// Content lines, unfolded (RFC 5545 3.1), as { name, params, value }.
function contentLines(text) {
  return String(text ?? '').replace(/\r?\n[ \t]/g, '').split(/\r?\n/).map((line) => {
    let quoted = false, i = 0;
    for (; i < line.length; i++) { if (line[i] === '"') quoted = !quoted; else if (line[i] === ':' && !quoted) break; }
    if (i >= line.length) return null;
    const [name, ...ps] = line.slice(0, i).split(';');
    const params = {};
    for (const p of ps) { const j = p.indexOf('='); if (j > 0) params[p.slice(0, j).toUpperCase()] = p.slice(j + 1).replace(/^"|"$/g, ''); }
    return { name: name.toUpperCase(), params, value: line.slice(i + 1).trim() };
  }).filter(Boolean);
}

// Each VEVENT's own properties (first occurrence; a nested VALARM's are not its).
function vevents(text) {
  const out = [];
  let cur = null, nested = 0;
  for (const p of contentLines(text)) {
    const v = p.value.toUpperCase();
    if (p.name === 'BEGIN') { if (v === 'VEVENT') { cur = {}; nested = 0; } else if (cur) nested++; continue; }
    if (p.name === 'END') { if (v === 'VEVENT') { if (cur) out.push(cur); cur = null; } else if (cur && nested) nested--; continue; }
    if (cur && !nested && !(p.name in cur)) cur[p.name] = p;
  }
  return out;
}

// DATE / DATE-TIME -> wall clock + zone. All-day and floating times read in the calendar zone.
function stamp(p, tz) {
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(p.value);
  if (m) return { y: +m[1], mo: +m[2], d: +m[3], h: 0, mi: 0, s: 0, tz, allDay: true };
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(p.value);
  if (!m) return null;
  const zone = m[7] ? 'UTC' : (p.params.TZID && validZone(p.params.TZID) ? p.params.TZID : tz);
  return { y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6], tz: zone, allDay: false };
}
const instantOf = (w) => zoned(w.tz, w.y, w.mo, w.d, w.h, w.mi, w.s);

function durationMs(v) {
  const m = /^\+?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(String(v ?? ''));
  return m ? (+m[1] || 0) * 7 * DAY_MS + (+m[2] || 0) * DAY_MS + (+m[3] || 0) * 3_600_000 + (+m[4] || 0) * 60_000 + (+m[5] || 0) * 1000 : null;
}

const SIMPLE_RULE_KEYS = new Set(['FREQ', 'INTERVAL', 'BYDAY', 'UNTIL', 'COUNT', 'WKST']);
function parseRule(v) {
  const r = {};
  for (const kv of String(v).split(';')) { const [k, x = ''] = kv.split('='); if (k) r[k.toUpperCase()] = x.toUpperCase(); }
  const byday = r.BYDAY ? r.BYDAY.split(',').map((c) => ICS_DAYS.indexOf(c)) : null;
  const simple = (r.FREQ === 'DAILY' || r.FREQ === 'WEEKLY') && Object.keys(r).every((k) => SIMPLE_RULE_KEYS.has(k))
    && !(byday ?? []).includes(-1) && (!r.WKST || ICS_DAYS.includes(r.WKST));
  return { ...r, byday, simple, interval: Math.max(1, parseInt(r.INTERVAL || '1', 10) || 1), count: r.COUNT ? parseInt(r.COUNT, 10) : Infinity };
}
function untilMs(v, tz) {
  let m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) return zoned(tz, +m[1], +m[2], +m[3] + 1) - 1;   // the whole UNTIL day
  m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (!m) return Infinity;
  return m[7] ? Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]) : zoned(tz, +m[1], +m[2], +m[3], +m[4], +m[5], +m[6]);
}
// The local DAYS a simple rule occurs on in [from, horizon). Earlier ones are only counted (COUNT).
function* occurrences(w, r, from, horizon) {
  const until = r.UNTIL ? untilMs(r.UNTIL, w.tz) : Infinity;
  const first = addDays(w, 0);
  const lead = (first.dow - ICS_DAYS.indexOf(r.WKST || 'MO') + 7) % 7;   // DTSTART's offset into its week
  let n = 0;
  for (let k = 0; ; k++) {
    const day = addDays(w, k);
    const midnight = dayNo(day) * DAY_MS;
    if (midnight - DAY_MS > horizon || midnight - DAY_MS > until) return;
    const hit = k === 0 || (r.FREQ === 'WEEKLY'
      ? (r.byday ?? [first.dow]).includes(day.dow) && Math.floor((k + lead) / 7) % r.interval === 0
      : k % r.interval === 0 && (!r.byday || r.byday.includes(day.dow)));
    if (!hit) continue;
    if (n++ >= r.count) return;
    if (midnight + DAY_MS < from) continue;
    const s = zoned(w.tz, day.y, day.mo, day.d, w.h, w.mi, w.s);
    if (s > until || s >= horizon) return;
    yield day;
  }
}

/**
 * Busy intervals [{s, e}] (epoch ms) overlapping [from, to) in an iCalendar feed. Skips
 * STATUS:CANCELLED and TRANSP:TRANSPARENT. `tz` reads all-day and floating times.
 */
export function busyFromIcs(text, { tz, from, to, onNote = () => {} }) {
  const busy = [];
  let exotic = 0;
  for (const e of vevents(text)) {
    if (e.STATUS?.value.toUpperCase() === 'CANCELLED' || e.TRANSP?.value.toUpperCase() === 'TRANSPARENT') continue;
    const w = e.DTSTART ? stamp(e.DTSTART, tz) : null;
    if (!w) continue;
    const end = e.DTEND ? stamp(e.DTEND, tz) : null;
    const days = w.allDay ? Math.max(1, end ? dayNo(end) - dayNo(w) : Math.round((durationMs(e.DURATION?.value) ?? DAY_MS) / DAY_MS)) : 0;
    const ms = w.allDay ? 0 : (end ? instantOf(end) - instantOf(w) : (durationMs(e.DURATION?.value) ?? 0));
    const rule = e.RRULE ? parseRule(e.RRULE.value) : null;
    if (rule && !rule.simple) exotic++;
    for (const day of (rule?.simple ? occurrences(w, rule, from - days * DAY_MS - ms, to) : [w])) {
      const s = zoned(w.tz, day.y, day.mo, day.d, w.h, w.mi, w.s);
      const iv = { s, e: days ? zoned(w.tz, day.y, day.mo, day.d + days) : s + ms };
      if (iv.s < to && iv.e > from) busy.push(iv);
    }
  }
  if (exotic) onNote(`${exotic} recurring event(s) with an unsupported RRULE counted at their first instance only`);
  return busy;
}

// ── iCalendar + MIME out ──
const icsText = (s) => String(s ?? '').replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
const icsTime = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[-:]/g, '');
function fold(line) {   // RFC 5545 3.1: 75 octets, CRLF + space
  const out = [];
  let cur = '', bytes = 0;
  for (const ch of line) {
    const b = Buffer.byteLength(ch);
    if (bytes + b > 75) { out.push(cur); cur = ' '; bytes = 1; }
    cur += ch; bytes += b;
  }
  out.push(cur);
  return out.join('\r\n');
}
export function invitation({ uid, stamp: at, start, end, title, description, organizer, attendee }) {
  return [
    'BEGIN:VCALENDAR', 'PRODID:-//eGPT//book//EN', 'VERSION:2.0', 'CALSCALE:GREGORIAN', 'METHOD:REQUEST',
    'BEGIN:VEVENT', `UID:${uid}`, `DTSTAMP:${icsTime(at)}`, `DTSTART:${icsTime(start)}`, `DTEND:${icsTime(end)}`,
    `SUMMARY:${icsText(title)}`, `DESCRIPTION:${icsText(description)}`,
    `ORGANIZER:mailto:${organizer}`,
    `ATTENDEE;ROLE=REQ-PARTICIPANT;PARTSTAT=NEEDS-ACTION;RSVP=TRUE:mailto:${attendee}`,
    'SEQUENCE:0', 'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR',
  ].map(fold).join('\r\n') + '\r\n';
}
// ── config readers ──
function workWindow(h) {
  const hm = (s) => { const m = /^(\d{1,2}):(\d{2})$/.exec(String(s ?? '').trim()); return m && +m[1] < 24 && +m[2] < 60 ? +m[1] * 60 + +m[2] : null; };
  const names = Array.isArray(h?.days) ? h.days : [];
  const days = new Set(names.map((d) => DAY_NAMES.indexOf(String(d).trim().slice(0, 3).toLowerCase())).filter((i) => i >= 0));
  const start = hm(h?.start), end = hm(h?.end);
  return days.size && start != null && end != null && end > start ? { days, start, end, text: `${names.join(',')} ${h.start}-${h.end}` } : null;
}
function parseWhen(date, time) {
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(date ?? ''));
  const t = /^(\d{1,2}):(\d{2})$/.exec(String(time ?? ''));
  if (!d || !t) return null;
  const v = { y: +d[1], mo: +d[2], d: +d[3], h: +t[1], mi: +t[2] };
  const check = new Date(Date.UTC(v.y, v.mo - 1, v.d));
  return check.getUTCMonth() === v.mo - 1 && check.getUTCDate() === v.d && v.h < 24 && v.mi < 60 ? v : null;
}

/**
 * @param {object} o
 * @param {function} o.ses          src/spine/email.mjs `ses` — the ONE SendEmail path
 * @param {function} o.missingMail  src/spine/email.mjs `missing` — SES gaps by key name
 * @param {function} [o.fetch]      reads the calendar feed
 */
export function createBookLimb({ getConfig = () => ({}), fetch = (...a) => globalThis.fetch(...a), ses, missingMail = async () => [], now = () => Date.now(), log = () => {} } = {}) {
  const booked = [];   // invitations this process sent: busy before the feed shows them

  const done = (outcome, detail, note) => { log(`-> ${outcome}${note ? ` (${note})` : ''}`); return { outcome, detail }; };

  async function book(a, ev = {}, being = '') {
    const c = getConfig()?.book || {};
    const url = String(c.ics_url ?? '').trim();
    const attendee = String(c.calendar_email ?? '').trim();
    const gaps = [...(url ? [] : ['book.ics_url']), ...(attendee ? [] : ['book.calendar_email']), ...(await missingMail())];
    if (gaps.length) return done('not-configured', null, `missing ${gaps.join(', ')}`);
    const tz = String(c.timezone || DEFAULT_TZ);
    if (!validZone(tz)) return done('failed', null, 'book.timezone is not an IANA zone');
    const win = workWindow({ ...DEFAULT_HOURS, ...(c.working_hours || {}) });
    if (!win) return done('failed', null, 'book.working_hours unreadable');
    const minutes = Number(c.duration_minutes) > 0 ? Number(c.duration_minutes) : DEFAULT_MINUTES;
    const req = parseWhen(a?.date, a?.time);
    if (!req) return done('failed', 'expected /book YYYY-MM-DD HH:MM <summary>', 'unreadable date');

    const durMs = minutes * 60_000;
    const start = zoned(tz, req.y, req.mo, req.d, req.h, req.mi);
    const from = zoned(tz, req.y, req.mo, req.d - BEFORE_DAYS);
    const to = zoned(tz, req.y, req.mo, req.d + AFTER_DAYS + 1);
    let busy;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
      if (!res.ok) throw new Error(`calendar feed HTTP ${res.status}`);
      busy = [...busyFromIcs(await res.text(), { tz, from, to, onNote: (m) => log(m) }), ...booked];
    } catch (e) {
      return done('failed', null, oneLine(String(e?.name === 'TimeoutError' ? 'calendar feed timeout' : e?.message).split(url).join('<ics_url>'), 120));
    }
    const free = (s) => s > now() && !busy.some((b) => b.s < s + durMs && s < b.e);
    const inHours = (s) => { const p = partsIn(tz, s); const m = p.h * 60 + p.mi; return win.days.has(p.dow) && m >= win.start && m + minutes <= win.end; };

    if (free(start) && inHours(start)) {
      const sender = String(getConfig()?.email?.from ?? '').trim();
      const title = oneLine(a?.summary) || 'Demo';
      const where = `${ev?.chatName ?? ev?.chatId ?? '?'} · ${ev?.surface ?? '?'} · eGPT ${being}`;
      const when = `${local(tz, start)}-${local(tz, start + durMs).slice(11)} (${tz})`;
      const ics = invitation({ uid: `${randomUUID()}@egpt`, stamp: now(), start, end: start + durMs, title, description: `${title}\n${when}\n\n${where}`, organizer: /<([^>]+)>/.exec(sender)?.[1] ?? sender, attendee });
      const raw = mimeMessage({ from: sender, to: [attendee], subject: title, date: now(), kind: 'alternative', parts: [
        { type: 'text/plain; charset=UTF-8', body: `${title}\n${when}\n\n${where}` },
        { type: 'text/calendar; charset=UTF-8; method=REQUEST', body: ics },
      ] });
      const sent = await ses({ to: [attendee], raw, what: 'book invitation' });
      if (sent !== 'sent') return done(sent === 'not-configured' ? 'not-configured' : 'failed', null, `invitation ${sent}`);
      booked.push({ s: start, e: start + durMs });
      return done('booked', `invitation sent to the team calendar for ${when}`, local(tz, start));
    }

    const slots = [];
    for (let k = -BEFORE_DAYS; k <= AFTER_DAYS; k++) {
      const day = addDays(req, k);
      if (!win.days.has(day.dow)) continue;
      for (let m = win.start; m + minutes <= win.end; m += STEP_MIN) {
        const s = zoned(tz, day.y, day.mo, day.d, Math.floor(m / 60), m % 60);
        if (free(s)) slots.push(s);
      }
    }
    const nearest = slots.sort((x, y) => Math.abs(x - start) - Math.abs(y - start) || x - y).slice(0, OFFER).sort((x, y) => x - y);
    const why = start <= now() ? 'that time has passed' : !inHours(start) ? `outside working hours (${win.text})` : 'that slot is taken';
    const detail = nearest.length
      ? `${why}; nearest free slots (${tz}): ${nearest.map((s) => local(tz, s)).join(', ')}`
      : `${why}; no free slot in working hours within ${AFTER_DAYS} days`;
    return done('busy', detail, local(tz, start));
  }

  return { book };
}
