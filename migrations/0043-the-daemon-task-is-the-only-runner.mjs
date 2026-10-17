// 0043 — the session 1 logon task egpt-daemon says it is the node's only runner.
//
// 0005 stamped "Disable it and the spine stays in session 0 (the egpt-daemon service) ..." on kg
// and do. Since 2026-10-17 that service is stopped and Disabled on both, so the line is false.
// The new text comes from setup/egpt-daemon-task-labels.ps1, which the registrar also stamps.
//
// Same mechanism as 0005 (its probe, update and lossless re-register, IN PLACE, the running
// instance left alone), changing exactly the <Description> line. Only the session 0 era line is
// replaced; any other text is refused - replacing it is a human decision.
//
// NOT ELEVATED, as 0005: the task's DACL gives the owning user full access.
import { readTask, reRegisterLossless, sessionZeroDescription } from './0005-daemon-task-has-description.mjs';

export const elevated = false;
export const summary = "the egpt-daemon task Description says it is the node's only runner";

const refuse = (why) => { throw new Error(`0043 refuses: ${why}`); };

export async function plan(ctx) {
  if (ctx.platform !== 'win32') return { satisfied: true, notes: [`no scheduled tasks on ${ctx.platform}`] };

  const { name, probe, facts, current } = readTask(ctx, refuse);
  if (!facts.exists) return { satisfied: true, notes: [`no ${name} scheduled task on this node`] };
  const { xml, dacl, target } = facts;
  if (current.length === 1 && current[0] === target) return { satisfied: true, notes: [`${name}: "${target}"`] };
  if (!current.length) return { satisfied: true, notes: [`${name} carries no Description - nothing points at session 0`] };
  const old = sessionZeroDescription(name);
  if (current.length !== 1 || current[0] !== old) {
    refuse(`${name} carries a Description that is neither this one nor the session 0 era one (${JSON.stringify(current.join(' | '))}) - replacing it is a human decision`);
  }

  const next = xml.replace(`<Description>${old}</Description>`, () => `<Description>${target}</Description>`);
  const running = facts.state === 4;
  return {
    satisfied: false,
    changes: [
      `re-register scheduled task ${name} from its own exported XML, with its Description replaced:`,
      `  - ${old}`,
      `  + ${target}`,
      `verify: the re-export equals that byte for byte and the DACL is unchanged (${dacl}) - else re-register the original export and refuse`,
      running
        ? `${name} is RUNNING: that instance is left running - an update of the registration does not stop or restart it`
        : `${name} is not running (state ${facts.state}); nothing is started or stopped`,
    ],
    apply: async () => reRegisterLossless(ctx, { name, xml, dacl, next, probe, refuse }),
  };
}
