/** `around <id>`, `next <id> [<n>]`, `prev <id> [<n>]` (specs/cli.md#around-id--next-id--prev-id). */
import { AxiError } from "axi-sdk-js";
import { AgentSessionError } from "../lib/errors.js";
import { formatId, resolveId } from "../lib/ids.js";
import { around, next, prev, type PanOpts, type PanResult } from "../lib/events.js";
import type { EventId } from "../lib/model.js";
import { findCommand } from "../reference.js";
import { getBool, getNumber, getString, parseFlags, usageLine, type Parsed } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { DEFAULT_HEAD, renderDocument, renderRows } from "../output/render.js";
import { parseRowFields } from "./events.js";
import { BIN, carry, parseKinds, rewriteNotice, scopeCarry, scopeOf, shellArg, zoneOf, type Io } from "./common.js";

type Verb = "around" | "next" | "prev";

const LABEL: Record<Verb, string> = { around: "rows", next: "next", prev: "prev" };

/** `<n>` positional and `--limit` agree, or a usage error (as on `tail`). */
function countArg(verb: Verb, p: Parsed): number | undefined {
  const usage = usageLine(verb);
  let n = getNumber(p, "limit");
  const pos = p.positionals[1];
  if (pos !== undefined) {
    if (!/^\d+$/.test(pos)) throw new AxiError(`<n> must be a non-negative integer, got ${pos}`, "VALIDATION_ERROR", [usage]);
    if (n !== undefined && n !== Number(pos)) throw new AxiError(`<n> ${pos} and --limit ${n} disagree; pass one`, "USAGE", [usage]);
    n = Number(pos);
  }
  return n;
}

function anchorNote(r: PanResult, verb: Verb): string | undefined {
  const note = r.anchorNote;
  if (!note) return undefined;
  const what = note.kind === "silent" ? "silent entry" : `${note.kind} (not a shown kind)`;
  const starts: string[] = [];
  if (verb !== "next" && note.before) starts.push(verb === "around" ? `before at ${formatId(note.before)}` : formatId(note.before));
  if (verb !== "prev" && note.after) starts.push(verb === "around" ? `after at ${formatId(note.after)}` : formatId(note.after));
  const travel = starts.length ? `; travel starts at the nearest visible event${verb === "around" ? "s" : ""} (${starts.join(", ")})` : "; no visible event in the direction of travel";
  return `${what}, not shown${travel}`;
}

export async function panCommand(verb: Verb, args: string[], io: Io): Promise<string> {
  const doc = findCommand(verb)!;
  const p = parseFlags(verb, args, doc.flags ?? []);
  if (p.help) return renderCommandHelp(verb) ?? "";
  const maxArgs = verb === "around" ? 1 : 2;
  if (p.positionals.length < 1 || p.positionals.length > maxArgs) {
    const what = verb === "around" ? "one <id>" : "<id> and an optional <n>";
    throw new AxiError(p.positionals.length ? `${verb} takes ${what}` : `${verb} needs an <id>`, "USAGE", [usageLine(verb)]);
  }
  const tz = zoneOf(p, io);
  const kinds = parseKinds(getString(p, "kind"));
  const full = getBool(p, "full");
  const head = full ? 0 : (getNumber(p, "head") ?? DEFAULT_HEAD);
  const fields = parseRowFields(getString(p, "fields"));
  const n = verb === "around" ? undefined : countArg(verb, p);
  const context = getNumber(p, "context");
  const before = getNumber(p, "before") ?? context ?? 5;
  const after = getNumber(p, "after") ?? context ?? 5;
  const scope = scopeOf(verb, p, io);
  const sessionRef = getString(p, "session");

  const { session, id } = await resolveId(p.positionals[0]!, scope, sessionRef !== undefined ? { session: sessionRef } : {});
  const notice = await rewriteNotice(session, io, tz);
  const opts: PanOpts = { cache: { env: io.env } };
  if (kinds) opts.kinds = kinds;
  const limit = n ?? (full ? 0 : 20);
  let r: PanResult;
  try {
    r = verb === "around" ? await around(session, id, before, after, opts) : verb === "next" ? await next(session, id, limit, opts) : await prev(session, id, limit, opts);
  } catch (err) {
    if (err instanceof AgentSessionError) {
      const details = { ...(err.details ?? {}), ...(notice ? { notice } : {}) };
      // Beyond the end: the `tail` hint must resolve the way this id did.
      const suggestions =
        err.code === "NOT_FOUND" && typeof err.details?.lines === "number"
          ? [`Run \`${BIN} tail ${sessionRef !== undefined ? shellArg(sessionRef) : session.short}${scopeCarry(p)}${carry(p)}\` for the last rows of this session`]
          : err.suggestions;
      throw new AgentSessionError(err.message, err.code, suggestions, Object.keys(details).length ? details : undefined);
    }
    throw err;
  }

  // Every hint resolves its id the way this one did: --session, scope, zone.
  const idCarry = `${sessionRef !== undefined ? ` --session ${shellArg(sessionRef)}` : ""}${scopeCarry(p)}${carry(p)}`;
  const kindFlag = getString(p, "kind") !== undefined ? ` --kind ${shellArg(getString(p, "kind")!)}` : "";
  const headFlag = getString(p, "head") !== undefined ? ` --head ${getString(p, "head")}` : "";
  const fieldsFlag = fields.length ? ` --fields ${fields.join(",")}` : "";
  const limitFlag = n !== undefined ? ` --limit ${n}` : "";
  const view = `${kindFlag}${verb === "around" ? "" : limitFlag}${headFlag}${full ? " --full" : ""}${fieldsFlag}`;

  const rendered = renderRows(r.rows, tz, { head, fields });
  const header: Record<string, unknown> = {};
  if (notice) header.notice = notice;
  header.session = `${session.short} (title pending)`;
  if (session.kind === "subagent") {
    header.kind = "subagent";
    if (session.parent) header.parent = session.parent.slice(0, 8);
  }
  header.anchor = formatId(id);
  const note = anchorNote(r, verb);
  if (note) header.anchor_note = note;
  Object.assign(header, rendered.header);
  header.tz = tz;
  header.count = `${r.rows.length} of ${r.matching}`;
  if (r.atStart) header.at_start = true;
  if (r.atEnd) header.at_end = true;
  if (r.malformed > 0) header.malformed = `${r.malformed} line${r.malformed === 1 ? "" : "s"}`;

  const label = LABEL[verb];
  const help: string[] = [];
  const first: EventId = r.rows[0]?.id ?? id;
  const last: EventId = r.rows[r.rows.length - 1]?.id ?? id;
  if (r.rows.length === 0) {
    const where = verb === "prev" ? `before ${formatId(id)}${r.atStart ? " (at start of session)" : ""}` : verb === "next" ? `after ${formatId(id)}${r.atEnd ? " (at end of session)" : ""}` : `around ${formatId(id)}`;
    header[label] = `0 events ${where}`;
  } else {
    header[label] = rendered.rows;
  }
  if (!r.atStart) help.push(`Run \`${BIN} prev ${formatId(first)}${view}${idCarry}\` for earlier rows`);
  if (!r.atEnd) help.push(`Run \`${BIN} next ${formatId(last)}${view}${idCarry}\` for later rows`);
  if (rendered.cut > 0) {
    const rows = `${rendered.cut} row${rendered.cut === 1 ? "" : "s"}`;
    help.push(`Run \`${BIN} show ${formatId(rendered.firstCut!)}${idCarry}\` to see one of the ${rows} cut to ${head} chars whole`);
  }
  help.push(`Run \`${BIN} show ${formatId(id)}${idCarry}\` to zoom into the anchor`);
  if (r.rows.length === 0 && !kinds) help.push(`Run \`${BIN} ${verb} ${formatId(id)} --kind all${idCarry}\` to include thinking and result rows`);
  return renderDocument(header, help);
}
