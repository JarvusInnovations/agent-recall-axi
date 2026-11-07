/** `events <session>` and `tail <session> [<n>]` (specs/cli.md#events-session, #tail-session). */
import { AxiError } from "axi-sdk-js";
import { formatId } from "../lib/ids.js";
import type { EventId, Session } from "../lib/model.js";
import { listEvents, type ListOpts, type Listing } from "../lib/events.js";
import { findCommand, ROW_FIELDS, type RowField } from "../reference.js";
import { getBool, getNumber, getString, parseFlags, type Parsed } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { DEFAULT_HEAD, renderDocument, renderRows } from "../output/render.js";
import { formatSize } from "../output/sizes.js";
import { BIN, carry, parseKinds, parseRange, rewriteNotice, scopeOf, sessionFromArg, sessionHint, shellArg, zoneOf, type Io, type SessionHint } from "./common.js";

function flagsOf(name: string) {
  return findCommand(name)?.flags ?? [];
}

/** The position just after `id`, for an inclusive `--from` that continues past it. */
function after(id: EventId): string {
  return id.block === undefined ? `${id.session}:${id.seq + 1}` : `${id.session}:${id.seq}.${id.block + 1}`;
}

interface RenderArgs {
  label: "events" | "tail";
  parsed: Parsed;
  /** The row cap the caller asked for (`--limit`, or tail's `<n>`); undefined for the default. */
  explicitLimit: number | undefined;
  listing: Listing;
  session: Session;
  /** How hints name the session (path, `<s8>` or full id, + scope flags). */
  hint: SessionHint;
  notice: string | undefined;
  fields: readonly RowField[];
  tz: string;
  head: number;
  defaultKinds: boolean;
  full: boolean;
  limit: number;
}

function render(a: RenderArgs): string {
  const { listing } = a;
  const rendered = renderRows(listing.rows, a.tz, { head: a.head, fields: a.fields });
  const short = a.session.short;
  const header: Record<string, unknown> = {};
  if (a.notice) header.notice = a.notice;
  header.session = `${short} (title pending)`;
  if (a.session.kind === "subagent") {
    header.kind = "subagent";
    if (a.session.parent) header.parent = a.session.parent.slice(0, 8);
  }
  Object.assign(header, rendered.header);
  header.tz = a.tz;
  const shown = listing.rows.length;
  if (shown > 0) {
    header.count = listing.matching !== undefined ? `${shown} of ${listing.matching}` : `${shown} (newest; earlier rows exist)`;
  }
  if (listing.malformed > 0) header.malformed = `${listing.malformed} line${listing.malformed === 1 ? "" : "s"}`;
  if (a.full && a.limit === 0) header.size = `${formatSize(rendered.chars)} chars`;

  const s = a.hint.ref;
  const tz = carry(a.parsed);
  const p = a.parsed;
  const kind = getString(p, "kind") !== undefined ? ` --kind ${shellArg(getString(p, "kind")!)}` : "";
  const head = getString(p, "head") !== undefined ? ` --head ${getString(p, "head")}` : "";
  const fullFlag = a.full ? " --full" : "";
  const limitFlag = a.explicitLimit !== undefined ? ` --limit ${a.explicitLimit}` : "";
  // Paging keeps the caller's view: kinds, row cap, head, --full, zone, and the far bound.
  const fieldsFlag = a.fields.length ? ` --fields ${a.fields.join(",")}` : "";
  const view = `${kind}${limitFlag}${head}${fullFlag}${fieldsFlag}${tz}`;
  const toBound = getString(p, "to") !== undefined ? ` --to ${shellArg(getString(p, "to")!)}` : "";
  const help: string[] = [];
  if (shown === 0) {
    header[a.label] = `0 events in ${short} (${listing.lines} line${listing.lines === 1 ? "" : "s"})`;
    if (a.defaultKinds) help.push(`Run \`${BIN} events ${s} --kind all${tz}\` to include thinking and result rows`);
    return renderDocument(header, help);
  }
  header[a.label] = rendered.rows;
  const first = listing.rows[0]!.id;
  const last = listing.rows[shown - 1]!.id;
  if (!listing.atStart) help.push(`Run \`${BIN} events ${s} --to ${formatId(first)}${view}\` for earlier rows`);
  if (!listing.atEnd) help.push(`Run \`${BIN} events ${s} --from ${after(last)}${toBound}${view}\` for later rows`);
  if (rendered.cut > 0) {
    const rows = `${rendered.cut} row${rendered.cut === 1 ? "" : "s"}`;
    help.push(`Run \`${BIN} events ${s} --from ${formatId(first)} --to ${after(last)}${kind}${fieldsFlag} --full${tz}\` for the whole text of the ${rows} cut to ${a.head} chars`);
    help.push(`Run \`${BIN} show ${formatId(rendered.firstCut!)}${scopeOnly(a)}${tz}\` to see one cut row whole`);
  } else {
    help.push(`Run \`${BIN} show ${formatId(last)}${scopeOnly(a)}${tz}\` to zoom into a row`);
  }
  return renderDocument(header, help);
}

/** What a `show` hint needs so its id resolves the way this listing's session did. */
function scopeOnly(a: RenderArgs): string {
  return a.hint.showCarry;
}

export function parseRowFields(text: string | undefined): RowField[] {
  if (text === undefined) return [];
  const names = text.split(",").map((f) => f.trim()).filter(Boolean);
  const bad = names.filter((n) => !(ROW_FIELDS as readonly string[]).includes(n));
  if (bad.length || names.length === 0) {
    throw new AxiError(`unknown field: ${bad.join(", ") || "(empty)"}`, "VALIDATION_ERROR", [`fields: ${ROW_FIELDS.join(", ")}`]);
  }
  return [...new Set(names)] as RowField[];
}

function headOf(p: Parsed, full: boolean): number {
  if (full) return 0;
  return getNumber(p, "head") ?? DEFAULT_HEAD;
}

export async function eventsCommand(args: string[], io: Io): Promise<string> {
  const p = parseFlags("events", args, flagsOf("events"));
  if (p.help) return helpOf("events");
  if (p.positionals.length !== 1) {
    throw new AxiError(p.positionals.length ? "events takes one <session>" : "events needs a <session>", "USAGE", [
      `usage: ${BIN} ${findCommand("events")!.usage}`,
    ]);
  }
  const tz = zoneOf(p, io);
  const kinds = parseKinds(p.flags.get("kind") as string | undefined);
  const range = parseRange("events", p, tz, io.now, true);
  const full = getBool(p, "full");
  const limit = getNumber(p, "limit") ?? (full ? 0 : 40);
  const head = headOf(p, full);
  const fields = parseRowFields(getString(p, "fields"));
  scopeOf("events", p, io);
  const ref = p.positionals[0]!;
  const session = await sessionFromArg("events", ref, p, io);
  const opts: ListOpts = { limit };
  if (kinds) opts.kinds = kinds;
  if (range.from) opts.from = range.from;
  if (range.to) opts.to = range.to;
  const listing = await listEvents(session, opts);
  const notice = await rewriteNotice(session, io, tz);
  return render({ label: "events", parsed: p, explicitLimit: getNumber(p, "limit"), listing, session, hint: await sessionHint("events", ref, session, p, io), notice, fields, tz, head, defaultKinds: !kinds, full, limit });
}

export async function tailCommand(args: string[], io: Io): Promise<string> {
  const p = parseFlags("tail", args, flagsOf("tail"));
  if (p.help) return helpOf("tail");
  const usage = `usage: ${BIN} ${findCommand("tail")!.usage}`;
  if (p.positionals.length < 1 || p.positionals.length > 2) {
    throw new AxiError(p.positionals.length ? "tail takes <session> and an optional <n>" : "tail needs a <session>", "USAGE", [usage]);
  }
  let n = getNumber(p, "limit");
  const pos = p.positionals[1];
  if (pos !== undefined) {
    if (!/^\d+$/.test(pos)) throw new AxiError(`<n> must be a non-negative integer, got ${pos}`, "VALIDATION_ERROR", [usage]);
    if (n !== undefined && n !== Number(pos)) throw new AxiError(`<n> ${pos} and --limit ${n} disagree; pass one`, "USAGE", [usage]);
    n = Number(pos);
  }
  const tz = zoneOf(p, io);
  const kinds = parseKinds(p.flags.get("kind") as string | undefined);
  const full = getBool(p, "full");
  const limit = n ?? (full ? 0 : 20);
  const head = headOf(p, full);
  const fields = parseRowFields(getString(p, "fields"));
  scopeOf("tail", p, io);
  const ref = p.positionals[0]!;
  const session = await sessionFromArg("tail", ref, p, io);
  const opts: ListOpts = { limit };
  if (kinds) opts.kinds = kinds;
  const listing = await listEvents(session, opts);
  const notice = await rewriteNotice(session, io, tz);
  return render({ label: "tail", parsed: p, explicitLimit: n, listing, session, hint: await sessionHint("tail", ref, session, p, io), notice, fields, tz, head, defaultKinds: !kinds, full, limit });
}

function helpOf(name: string): string {
  return renderCommandHelp(name) ?? "";
}
