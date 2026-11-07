/**
 * `show <id>` and its alias `zoom` (specs/cli.md#show-id-alias-zoom): one entry or one event,
 * whole, in block form. Caps and marks follow specs/behaviors/truncation.md; `authority:` on
 * every event (specs/behaviors/authority.md).
 */
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { AgentSessionError } from "../lib/errors.js";
import { formatId, resolveId } from "../lib/ids.js";
import { pointerAccess, readPointer, show, type Shown, type ShownEvent } from "../lib/events.js";
import type { Event, EventId, Session } from "../lib/model.js";
import { formatClock, formatDay } from "../lib/time.js";
import { findCommand, SHOW_FIELDS } from "../reference.js";
import { getBool, getString, parseFlags, usageLine, type Parsed } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { renderHelp, renderStatus } from "../output/render.js";
import { formatSize } from "../output/sizes.js";
import { detail, DETAIL_CAP } from "../output/truncate.js";
import { BIN, carry, collapseHome, rewriteNotice, scopeCarry, scopeOf, shellArg, zoneOf, type Io } from "./common.js";

type Doc = Record<string, unknown>;

interface Ctx {
  session: Session;
  full: boolean;
  tz: string;
  /** Hints for the next call: what was cut, where a pointer leads. */
  help: string[];
  /** Flags every hint carries so its id resolves the same way (`--session`, scope, `--tz`). */
  carry: string;
}

const isEventId = (v: unknown): v is EventId =>
  typeof v === "object" && v !== null && typeof (v as EventId).session === "string" && typeof (v as EventId).seq === "number";

function localTime(iso: string, tz: string): string {
  const d = new Date(iso);
  return `${formatDay(d, tz)} ${formatClock(d, tz)} ${tz}`;
}

/** A capped detail field; records the `--full` hint when it was cut. */
function capped(text: string, ctx: Ctx, id: EventId, label: string): string {
  if (ctx.full) return text;
  const d = detail(text, DETAIL_CAP);
  if (d.cut) ctx.help.push(`Run \`${BIN} show ${formatId(id)} --full${ctx.carry}\` for the complete ${label} (${formatSize(text.length)} chars)`);
  return d.text;
}

/** Meta values as printable data: ids formatted, everything else as stored. */
function metaOf(meta: Record<string, unknown>, skip: readonly string[]): Doc | undefined {
  const out: Doc = {};
  for (const [k, v] of Object.entries(meta)) {
    if (skip.includes(k)) continue;
    out[k] = isEventId(v) ? formatId(v) : v;
  }
  return Object.keys(out).length ? out : undefined;
}

function pointerLine(path: string, bytes: number, exists: boolean): string {
  return `${collapseHome(path)} (${formatSize(bytes)}, ${exists ? "exists" : "missing"})`;
}

/** A result's text: the stored text, or for a persisted output the preview (`--full`: the file). */
async function resultBody(ev: Event, ctx: Ctx, idForHint: EventId, label: string, into: Doc, textKey: string): Promise<void> {
  const p = ev.pointer;
  if (!p) {
    into[textKey] = capped(ev.text, ctx, idForHint, label);
    return;
  }
  const access = await pointerAccess(p, ctx.session);
  const missing = !access.followable && access.reason === "the file is missing";
  into.pointer = pointerLine(p.path, p.bytes, !missing && p.exists);
  if (!access.followable && !missing) {
    // Named in the log but outside this session's tool-results: shown, never read.
    into.followed = false;
    into.reason = access.reason;
  }
  if (ctx.full && access.followable) {
    const read = await readPointer(p, ctx.session);
    if (read.followed) {
      into[textKey] = read.text;
      return;
    }
    into.pointer = pointerLine(p.path, p.bytes, false);
  }
  into.preview = capped(p.preview, ctx, idForHint, "preview");
  if (access.followable && !ctx.full) {
    ctx.help.push(`Run \`${BIN} show ${formatId(idForHint)} --full${ctx.carry}\` for the persisted output (${formatSize(p.bytes)})`);
  }
}

const COMPACTION_META = ["trigger", "pre_tokens", "post_tokens", "dropped_tokens", "summary", "preserved"] as const;

async function eventDoc(s: ShownEvent, ctx: Ctx, withTime: boolean): Promise<Doc> {
  const ev = s.event;
  const doc: Doc = { event: formatId(ev.id) };
  if (withTime && ev.t) doc.t = localTime(ev.t, ctx.tz);
  doc.kind = ev.kind;
  doc.authority = ev.authority;
  if (s.turn) doc.turn = formatId(s.turn);
  doc.window = s.window;
  const meta = ev.meta ?? {};
  switch (ev.kind) {
    case "call": {
      if (ev.tool !== undefined) doc.tool = ev.tool;
      if (ev.target !== undefined) doc.target = ev.target;
      if (ev.input !== undefined) {
        if (typeof ev.input === "string") doc.input = capped(ev.input, ctx, ev.id, "input");
        else {
          const json = JSON.stringify(ev.input) ?? "";
          // Whole as structure under the cap; over it, the JSON text cut with the house marker.
          doc.input = ctx.full || json.length <= DETAIL_CAP ? ev.input : capped(json, ctx, ev.id, "input");
        }
      }
      if (ev.result) doc.result = formatId(ev.result);
      doc.result_status = renderStatus(ev.status);
      if (s.linked) await resultBody(s.linked, ctx, ev.id, "result", doc, "result_text");
      break;
    }
    case "result":
    case "human.answer": {
      if (ev.tool !== undefined) doc.tool = ev.tool;
      if (ev.call) doc.call = formatId(ev.call);
      if (ev.error) doc.error = true;
      await resultBody(ev, ctx, ev.id, ev.kind === "result" ? "result" : "text", doc, "text");
      break;
    }
    case "compaction": {
      for (const k of ["trigger", "pre_tokens", "post_tokens", "dropped_tokens"] as const) if (meta[k] !== undefined) doc[k] = meta[k];
      if (isEventId(meta.summary)) doc.summary = formatId(meta.summary);
      doc.preserved = `${s.preserved ?? 0} events`;
      break;
    }
    case "summary": {
      if (isEventId(meta.compaction)) doc.compaction = formatId(meta.compaction);
      doc.text = capped(ev.text, ctx, ev.id, "text");
      break;
    }
    default:
      doc.text = capped(ev.text, ctx, ev.id, "text");
  }
  if (ev.agent) doc.agent = ev.agent;
  if (ev.files?.length) doc.files = ev.files;
  const skip = ev.kind === "compaction" ? COMPACTION_META : ev.kind === "summary" ? ["compaction"] : [];
  const m = metaOf(meta, skip);
  if (m) doc.meta = m;
  return doc;
}

/** `--raw`: every string value capped at 4,000 chars with the house marker unless `--full`. */
function capRaw(value: unknown, ctx: Ctx, cut: { any: boolean }): unknown {
  if (typeof value === "string") {
    if (ctx.full) return value;
    const d = detail(value, DETAIL_CAP);
    if (d.cut) cut.any = true;
    return d.text;
  }
  if (Array.isArray(value)) return value.map((v) => capRaw(v, ctx, cut));
  if (typeof value === "object" && value !== null) {
    const out: Doc = {};
    for (const [k, v] of Object.entries(value)) out[k] = capRaw(v, ctx, cut);
    return out;
  }
  return value;
}

function entryTail(shown: Shown, doc: Doc): void {
  if (shown.entry.uuid) doc.uuid = shown.entry.uuid;
  if (shown.entry.parentUuid) doc.parent_uuid = shown.entry.parentUuid;
}

function rawDoc(shown: Shown, ctx: Ctx, silent: boolean): Doc {
  const entryId: EventId = { session: shown.id.session, seq: shown.id.seq };
  const doc: Doc = { entry: formatId(entryId) };
  if (shown.entry.t) doc.t = localTime(shown.entry.t, ctx.tz);
  if (silent) doc.kind = "silent";
  if (shown.entry.type !== undefined) doc.type = shown.entry.type;
  const cut = { any: false };
  if (shown.entry.raw) doc.raw = capRaw(shown.entry.raw, ctx, cut);
  else {
    if (shown.partial) doc.partial = true;
    else if (shown.entry.malformed) doc.malformed = true;
    doc.raw = capRaw(shown.line, ctx, cut);
  }
  entryTail(shown, doc);
  if (cut.any) ctx.help.push(`Run \`${BIN} show ${formatId(entryId)} --raw --full${ctx.carry}\` for the whole line`);
  return doc;
}

function project(doc: Doc, fields: ReadonlySet<string> | undefined): Doc {
  if (!fields) return doc;
  const out: Doc = {};
  for (const [k, v] of Object.entries(doc)) {
    if (k === "event" || k === "entry") out[k] = v;
    else if (k === "blocks" && Array.isArray(v)) out[k] = v.map((b) => project(b as Doc, fields));
    else if (fields.has(k)) out[k] = v;
  }
  return out;
}

function parseShowFields(text: string | undefined): Set<string> | undefined {
  if (text === undefined) return undefined;
  const names = text.split(",").map((f) => f.trim()).filter(Boolean);
  const bad = names.filter((n) => !(SHOW_FIELDS as readonly string[]).includes(n));
  if (bad.length || names.length === 0) {
    throw new AxiError(`unknown field: ${bad.join(", ") || "(empty)"}`, "VALIDATION_ERROR", [`fields: ${SHOW_FIELDS.join(", ")}`]);
  }
  return new Set(names);
}

function hintCarry(p: Parsed): string {
  const session = getString(p, "session");
  return `${session !== undefined ? ` --session ${shellArg(session)}` : ""}${scopeCarry(p)}${carry(p)}`;
}

/** The handler for both `show` and `zoom`: same arguments, same bytes out. */
export async function showCommand(args: string[], io: Io, name: "show" | "zoom" = "show"): Promise<string> {
  const p = parseFlags("show", args, findCommand("show")!.flags ?? []);
  if (p.help) return renderCommandHelp(name) ?? "";
  if (p.positionals.length !== 1) {
    throw new AxiError(p.positionals.length ? "show takes one <id>" : "show needs an <id>", "USAGE", [usageLine("show")]);
  }
  const fields = parseShowFields(getString(p, "fields"));
  const tz = zoneOf(p, io);
  const scope = scopeOf("show", p, io);
  const session = getString(p, "session");
  const { session: s, id } = await resolveId(p.positionals[0]!, scope, session !== undefined ? { session } : {});
  const raw = getBool(p, "raw");
  let shown: Shown;
  try {
    // `--raw` prints the stored line, so any seq works and a block index only names the line.
    shown = await show(s, raw ? { session: id.session, seq: id.seq } : id);
  } catch (err) {
    // Beyond the end: the `tail` hint must resolve the way this id did.
    if (err instanceof AgentSessionError && err.code === "NOT_FOUND" && typeof err.details?.lines === "number") {
      const ref = `${session !== undefined ? shellArg(session) : s.short}${scopeCarry(p)}`;
      throw new AgentSessionError(err.message, "NOT_FOUND", [`Run \`${BIN} tail ${ref}${carry(p)}\` for the last rows of this session`]);
    }
    throw err;
  }
  const ctx: Ctx = { session: s, full: getBool(p, "full"), tz, help: [], carry: hintCarry(p) };

  let doc: Doc;
  if (raw || shown.silent) {
    doc = rawDoc(shown, ctx, shown.silent && !raw);
    if (shown.silent && !raw) {
      if (shown.before) ctx.help.push(`Run \`${BIN} show ${formatId(shown.before)}${ctx.carry}\` for the nearest event before`);
      if (shown.after) ctx.help.push(`Run \`${BIN} show ${formatId(shown.after)}${ctx.carry}\` for the nearest event after`);
      if (!shown.before && !shown.after) {
        // Name the session the way the caller did: a path stays a path.
        const ref = session !== undefined ? shellArg(session) : s.short;
        ctx.help.push(`The session has no events; run \`${BIN} events ${ref}${scopeCarry(p)} --kind all${carry(p)}\` to confirm`);
      }
    }
  } else if (shown.events.length === 1) {
    doc = await eventDoc(shown.events[0]!, ctx, true);
    entryTail(shown, doc);
  } else {
    doc = { entry: formatId({ session: id.session, seq: id.seq }) };
    if (shown.entry.t) doc.t = localTime(shown.entry.t, tz);
    const blocks: Doc[] = [];
    for (const e of shown.events) blocks.push(await eventDoc(e, ctx, false));
    doc.blocks = blocks;
    entryTail(shown, doc);
  }
  doc = project(doc, fields);

  const notice = await rewriteNotice(s, io, tz);
  const parts: string[] = [];
  if (notice) parts.push(encode({ notice }));
  parts.push(encode(doc));
  const help = renderHelp([...new Set(ctx.help)]);
  if (help) parts.push(help);
  return parts.join("\n");
}
