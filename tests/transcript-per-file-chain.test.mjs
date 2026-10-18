// transcript-per-file-chain.test.mjs — one append chain PER transcript file (operator
// 2026-10-18: "same channel is linear, different channels in parallel"). A turn streaming into
// chat A's transcript must not hold chat B's inbound line, and every write to ONE file lands in
// call order however long each append takes.
import { describe, it, expect } from 'vitest';
import { createTranscript } from '../src/spine/transcript.mjs';
import { Room } from '../src/room-core.mjs';

const contacts = {
  resolve: async (_s, chatId) => `slug-${chatId}`,
  transcriptTarget: async (surface, chatId) => { const room = Room.forChat(surface, `slug-${chatId}`); return { slug: `slug-${chatId}`, room, path: `/t/${chatId}.md` }; },
};
// An fs whose appends to one path can be held open (a slow disk, a long write).
function slowIo() {
  const files = new Map();
  const order = [];
  const gates = new Map();   // path -> Promise that holds every append to it
  return {
    files, order, gates,
    io: {
      appendFile: async (p, d) => { await (gates.get(p) ?? null); order.push([p, d]); files.set(p, (files.get(p) ?? '') + d); },
      mkdir: async () => {}, existsSync: (p) => files.has(p),
      readFile: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); }, writeFile: async () => {}, readdir: async () => [],
    },
  };
}
const ev = (chatId, body, extra = {}) => ({ surface: 'whatsapp', chatId, chatName: chatId, senderId: 'u-1', senderName: 'An', ts: Date.UTC(2026, 9, 18, 12), body, line: `An: ${body}`, kind: 'text', ...extra });

describe('transcript — a chain per file', () => {
  it('a stream held open in chat A does not hold chat B\'s inbound line', async () => {
    const f = slowIo();
    const t = createTranscript({ contacts, io: f.io });
    let open;
    f.gates.set('/t/A.md', new Promise((r) => { open = r; }));
    const streaming = t.logStream(ev('A', 'q'), '', 'partial answer');
    const b = await Promise.race([t.log(ev('B', 'hola')), new Promise((r) => setTimeout(() => r('HELD'), 300))]);
    open();
    await streaming;
    expect(b).toBe(true);
    expect(f.files.get('/t/B.md')).toContain('An: hola');
  });

  it('one file: every write lands in call order, whatever each append costs', async () => {
    const f = slowIo();
    const t = createTranscript({ contacts, io: f.io });
    const e = ev('A', 'first');
    let open;
    f.gates.set('/t/A.md', new Promise((r) => { open = r; }));
    const writes = [
      t.log(e),
      t.logStream(e, '', 'tok1'),
      t.logStream(e, 'tok1', 'tok1 tok2'),
      t.log(e, { text: 'the reply', being: 'egpt' }),
      t.log(ev('A', 'second')),
    ];
    setTimeout(() => { f.gates.delete('/t/A.md'); open(); }, 20);
    await Promise.all(writes);
    const text = f.files.get('/t/A.md');
    const at = (s) => text.indexOf(s);
    expect(at('An: first')).toBeGreaterThanOrEqual(0);
    expect(at('An: first')).toBeLessThan(at('tok1'));
    expect(at('tok1')).toBeLessThan(at(' tok2'));
    expect(at(' tok2')).toBeLessThan(at('the reply'));
    expect(at('the reply')).toBeLessThan(at('An: second'));
  });
});
