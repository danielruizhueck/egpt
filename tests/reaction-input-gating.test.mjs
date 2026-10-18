// A PERSON'S REACTION IS INPUT (operator 2026-10-18): it "obeys the same rules as all messages,
// meaning mention|accum|mute|on|off". A reaction gates exactly as a text reply to the same message:
// it wakes by the reply-to-being attribute (beeper.mjs sets it as for a text reply), never by words
// in the quoted snippet. A being's own reaction never gets here (dropped at the bridge).
import { describe, it, expect } from 'vitest';
import { createRouter } from '../src/spine/router.mjs';
import { createGating } from '../src/spine/gating.mjs';
import { createIdentity } from '../src/spine/identity.mjs';
import { createSpine } from '../src/spine/spine.mjs';

const OP = '+16468217865';
const base = { chatId: '!g', chatName: 'grupo', chatType: 'group', network: 'whatsapp', userId: OP, senderName: 'An', authorized: true, atEStart: false, atEAnywhere: false };
// The two shapes the bridge hands the spine for one target message #m1.
const reactionTo = (snippet, extra = {}) => ({ body: `reacted 👍 to #m1 "${snippet}"`, from: { ...base, isReaction: true, msgKey: 'm1', replyToBot: false, ...extra } });
const textReply = (body, extra = {}) => ({ body, from: { ...base, msgKey: `t-${Math.random()}`, replyToId: 'm1', replyToBot: false, ...extra } });
const toBeing = { replyToBeing: 'egpt', replyToBot: true };

function build(mode) {
  const agents = {
    egpt: { configuration: 'egpt', handles: ['e', 'egpt'], default: true, mode },
    wren: { configuration: 'egpt', handles: ['wren'], mode },
  };
  let cb = null;
  const bridge = { onMessage(fn) { cb = fn; }, send() {}, emit(m) { return cb(m); }, stop() {} };
  const brain = { calls: [], async turn(being, ev) { this.calls.push({ being, kind: ev.kind }); return { text: 'ok', sessionId: 's', being }; } };
  const transcript = { entries: [], async log(ev, reply) { if (reply == null) this.entries.push(ev.kind); } };
  const opens = [];
  const sender = { open(chatId, o) { opens.push(o); return { update() {}, fail() {}, async finish() {} }; } };
  const config = { agents };
  const spine = createSpine({
    bridge, brain, sender, transcript, defaultBeing: 'egpt',
    router: createRouter({ getAgents: () => agents, getConfig: () => config, defaultBeing: 'egpt' }),
    gating: createGating({ getConfig: () => config, defaultKey: 'egpt' }),
    identity: createIdentity({ now: () => 1 }),
    heartbeats: { runDue() {} }, readTranscript: async () => '', clock: { now: () => 1 },
  });
  spine.start();
  return { bridge, brain, opens, recorded: transcript.entries };
}

// Same message, same attributes: the reaction and the text reply must take the same decision.
async function both(mode, r, t) {
  const a = build(mode); await a.bridge.emit(r);
  const b = build(mode); await b.bridge.emit(t);
  return { reaction: a, text: b };
}

describe('a person\'s reaction gates like a text reply to the same message', () => {
  it('on: wakes the being, as a text would', async () => {
    const { reaction, text } = await both('on', reactionTo('hola'), textReply('👍'));
    expect(text.brain.calls.map((c) => c.being)).toEqual(['egpt']);
    expect(reaction.brain.calls).toEqual([{ being: 'egpt', kind: 'reaction' }]);
    expect(reaction.opens).toHaveLength(1);
  });

  it('mention: a reaction to the BEING\'s post wakes it, as a reply to that post does', async () => {
    const { reaction, text } = await both('mention', reactionTo('🐶 e: listo', toBeing), textReply('👍', toBeing));
    expect(text.brain.calls.map((c) => c.being)).toEqual(['egpt']);
    expect(reaction.brain.calls.map((c) => c.being)).toEqual(['egpt']);
  });

  it('REPRODUCE mention: a handle inside the QUOTED snippet addresses nobody — a reply "👍" to it wakes nobody either', async () => {
    const { reaction, text } = await both('mention', reactionTo('hola @wren mirá'), textReply('👍'));
    expect(text.brain.calls).toEqual([]);
    expect(reaction.brain.calls).toEqual([]);
    expect(reaction.opens).toEqual([]);
    expect(reaction.recorded).toEqual(['reaction']);
  });

  it('accum: same gate as mention — the being\'s post wakes it, anyone else\'s does not', async () => {
    expect((await both('accum', reactionTo('🐶 e: listo', toBeing), textReply('👍', toBeing))).reaction.brain.calls.map((c) => c.being)).toEqual(['egpt']);
    const { reaction, text } = await both('accum', reactionTo('hola'), textReply('👍'));
    expect(text.brain.calls).toEqual([]);
    expect(reaction.brain.calls).toEqual([]);
    expect(reaction.recorded).toEqual(['reaction']);
  });

  it('mute: recorded, no turn — off: not even recorded', async () => {
    const mute = build('mute'); await mute.bridge.emit(reactionTo('🐶 e: listo', toBeing));
    expect(mute.brain.calls).toEqual([]);
    expect(mute.recorded).toEqual(['reaction']);
    const off = build('off'); await off.bridge.emit(reactionTo('🐶 e: listo', toBeing));
    expect(off.brain.calls).toEqual([]);
    expect(off.recorded).toEqual([]);
  });
});
