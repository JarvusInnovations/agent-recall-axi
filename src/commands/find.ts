/** `find [<session>] [<phrase>] …` in one session (specs/cli.md#find). */
import { AxiError } from "axi-sdk-js";
import { AgentSessionError } from "../lib/errors.js";
import { comparePosition, formatId } from "../lib/ids.js";
import { compileQuery, findListing, type FindQuery, type Hit, type Why } from "../lib/find.js";
import type { Event, EventId, Kind } from "../lib/model.js";
import { findCommand, type RowField } from "../reference.js";
import { getBool, getNumber, getString, parseFlags, usageLine, type Parsed } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { DEFAULT_HEAD, renderDocument, renderRows } from "../output/render.js";
import { VERSION } from "../version.js";
import { BIN, carry, parseKinds, parseRange, rewriteNotice, scopeCarry, scopeOf, sessionFromArg, sessionHint, shellArg, withNotice, zoneOf, type Io } from "./common.js";
import { parseRowFields } from "./events.js";

/**
 * cli.md#find: with one positional, it is the session when it has a session reference's form
 * (a path, a hex string of at least 8 characters, a uuid, `latest`), else the phrase.
 */
export function looksLikeSessionRef(text: string): boolean {
  if (text === "latest") return true;
  if (text.includes("/") || text.startsWith(".") || text.startsWith("~") || text.endsWith(".jsonl")) return true;
  return /^[0-9a-f]{8}[0-9a-f-]*$/i.test(text);
}

/** The position just after `id`, for an inclusive `--from` that continues past it. */
function after(id: EventId): string {
  return id.block === undefined ? `${id.session}:${id.seq + 1}` : `${id.session}:${id.seq}.${id.block + 1}`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** `phrase "redirect" + file *.env*` (cli.md#find). */
function describeQuery(q: FindQuery): string {
  const parts: string[] = [];
  if (q.phrase) parts.push(q.regex ? `phrase /${q.phrase}/` : `phrase "${q.phrase}"`);
  if (q.file !== undefined) parts.push(`file ${q.file}`);
  if (q.tool !== undefined) parts.push(`tool ${q.tool}`);
  if (q.kinds?.length) parts.push(`kind ${q.kinds.join(",")}`);
  return parts.join(" + ");
}

/** One query handle as it reappears in a hint. */
type Handle = Why | "range";

export async function runFind(args: string[], io: Io): Promise<string> {
  const p = parseFlags("find", args, findCommand("find")?.flags ?? []);
  if (p.help) return renderCommandHelp("find") ?? "";
  const usage = usageLine("find");
  if (p.positionals.length > 2) throw new AxiError("find takes at most <session> and <phrase>", "USAGE", [usage, "quote a phrase with spaces: find <session> \"two words\""]);
  let ref: string | undefined;
  let phrase: string | undefined;
  if (p.positionals.length === 2) [ref, phrase] = p.positionals as [string, string];
  else if (p.positionals.length === 1) {
    if (looksLikeSessionRef(p.positionals[0]!)) ref = p.positionals[0];
    else phrase = p.positionals[0];
  }
  if (phrase === "") throw new AxiError("the phrase is empty", "USAGE", [usage]);

  const tz = zoneOf(p, io);
  const kinds = parseKinds(getString(p, "kind"));
  if (kinds === "all") {
    throw new AxiError("find --kind takes a list of kinds, not all", "VALIDATION_ERROR", ["e.g. --kind human,assistant; without --kind every kind but thinking and result is searched"]);
  }
  const file = getString(p, "file");
  const tool = getString(p, "tool");
  if (phrase === undefined && file === undefined && tool === undefined && !kinds) {
    throw new AxiError("find needs something to look for: a <phrase>, --file, --tool or --kind", "USAGE", [
      usage,
      `Run \`${BIN} find ${ref !== undefined ? shellArg(ref) : "latest"} "<phrase>"${scopeCarry(p)}${carry(p)}\` to search for a phrase, or add --tool <name> / --file <pattern> / --kind <a,b>`,
    ]);
  }
  const window = getString(p, "window");
  if (window !== undefined && window !== "all") {
    throw new AxiError(`--window ${window} is not available yet in ${VERSION} (planned: views); only --window all is accepted`, "USAGE", [usage]);
  }
  const range = parseRange("find", p, tz, io.now, true);
  const full = getBool(p, "full");
  const context = getNumber(p, "context") ?? 1;
  const before = getNumber(p, "before") ?? context;
  const afterN = getNumber(p, "after") ?? context;
  const explicitLimit = getNumber(p, "limit");
  const limit = explicitLimit ?? (full ? 0 : 20);
  const head = full ? 0 : (getNumber(p, "head") ?? DEFAULT_HEAD);
  const fields = parseRowFields(getString(p, "fields"));
  const deep = getBool(p, "deep");
  scopeOf("find", p, io);

  const q: FindQuery = { context: { before, after: afterN }, limit, deep };
  if (phrase !== undefined) q.phrase = phrase;
  if (getBool(p, "regex")) {
    if (phrase === undefined) throw new AxiError("--regex needs a <phrase>", "USAGE", [usage]);
    q.regex = true;
  }
  if (file !== undefined) q.file = file;
  if (tool !== undefined) q.tool = tool;
  if (kinds) q.kinds = kinds as Kind[];
  if (range.from) q.from = range.from;
  if (range.to) q.to = range.to;
  try {
    compileQuery(q); // regex and pattern validation, before any file is opened
  } catch (err) {
    if (err instanceof AgentSessionError) throw new AxiError(err.message, err.code, err.suggestions);
    throw err;
  }

  if (ref === undefined) {
    // Cross-session scope (the project, or --all) lands with sessions-and-recall.
    throw new AxiError(`find without a <session> (searching the whole project or every project) is not available yet in ${VERSION} (planned: sessions-and-recall)`, "USAGE", [
      usage,
      `Run \`${BIN} find latest${phrase !== undefined && !phrase.startsWith("-") ? ` ${shellArg(phrase)}` : ""}${tail(p)}${scopeCarry(p)}${phrase?.startsWith("-") ? ` -- ${shellArg(phrase)}` : ""}\` to search the newest session here, or name another one`,
      `Run \`${BIN} sessions${scopeCarry(p)}\` to pick a session`,
    ]);
  }

  const session = await sessionFromArg("find", ref, p, io);
  const notice = await rewriteNotice(session, io, tz);
  const listing = await withNotice(notice, () => findListing(session, q));
  const hint = await sessionHint("find", ref, session, p, io);

  // ---- render
  const header: Record<string, unknown> = {};
  if (notice) header.notice = notice;
  header.scope = `${session.short} (title pending)`;
  if (session.kind === "subagent") {
    header.kind = "subagent";
    if (session.parent) header.parent = session.parent.slice(0, 8);
  }
  const query = describeQuery(q);
  header.query = query;
  if (deep) header.deep = "yes";
  const lines = plural(listing.lines, "line");
  const tzc = carry(p);
  const help: string[] = [];
  const s = hint.ref;

  /** `find <session> <handles…> <view…>`, dropping one handle when asked. */
  const findHint = (opts: { drop?: Handle; extra?: string; from?: string } = {}) => {
    let cmd = `${BIN} find ${s}`;
    const ph = opts.drop === "phrase" ? undefined : phrase;
    let trailing = "";
    if (ph !== undefined) {
      if (ph.startsWith("-")) trailing = ` -- ${shellArg(ph)}`;
      else cmd += ` ${shellArg(ph)}`;
      if (q.regex) cmd += " --regex";
    }
    if (file !== undefined && opts.drop !== "file") cmd += ` --file ${shellArg(file)}`;
    if (tool !== undefined && opts.drop !== "tool") cmd += ` --tool ${shellArg(tool)}`;
    if (kinds && opts.drop !== "kind") cmd += ` --kind ${shellArg(getString(p, "kind")!)}`;
    if (opts.drop !== "range") {
      if (opts.from !== undefined) cmd += ` --from ${opts.from}`;
      else {
        if (getString(p, "from") !== undefined) cmd += ` --from ${shellArg(getString(p, "from")!)}`;
        if (getString(p, "since") !== undefined) cmd += ` --since ${shellArg(getString(p, "since")!)}`;
      }
      if (getString(p, "to") !== undefined) cmd += ` --to ${shellArg(getString(p, "to")!)}`;
    }
    for (const f of ["context", "before", "after", "limit", "head"]) if (getString(p, f) !== undefined) cmd += ` --${f} ${getString(p, f)}`;
    if (full) cmd += " --full";
    if (fields.length) cmd += ` --fields ${fields.join(",")}`;
    if (deep) cmd += " --deep";
    if (window !== undefined) cmd += ` --window ${window}`;
    return `${cmd}${opts.extra ?? ""}${tzc}${trailing}`;
  };

  if (listing.hits.length === 0) {
    header.tz = tz;
    if (listing.malformed > 0) header.malformed = plural(listing.malformed, "line");
    header.hits = `0 events match ${query} in ${session.short} (${lines} scanned)`;
    const handles: Why[] = [];
    if (phrase !== undefined) handles.push("phrase");
    if (file !== undefined) handles.push("file");
    if (tool !== undefined) handles.push("tool");
    if (kinds) handles.push("kind");
    if (handles.length > 1) for (const h of handles) help.push(`Run \`${findHint({ drop: h })}\` to drop the ${h} filter`);
    if (range.from || range.to) help.push(`Run \`${findHint({ drop: "range" })}\` to search the whole session`);
    if (phrase !== undefined && !deep) help.push(`Run \`${findHint({ extra: " --deep" })}\` to also search persisted outputs`);
    if (!kinds && phrase !== undefined) help.push(`Run \`${findHint({ extra: " --kind thinking,result" })}\` to search thinking and result rows instead`);
    return renderDocument(header, help);
  }

  // Hits and their contexts, each row once, in file order.
  const rowsById = new Map<string, Event>();
  const whyById = new Map<string, string>();
  for (const h of listing.hits) {
    rowsById.set(formatId(h.event.id), h.event);
    whyById.set(formatId(h.event.id), h.why.join("+"));
    for (const c of h.context) if (!rowsById.has(formatId(c.id))) rowsById.set(formatId(c.id), c);
  }
  const events = [...rowsById.values()].sort((a, b) => comparePosition(a.id, b.id));
  const rendered = renderRows(events, tz, { head, fields: fields as readonly RowField[] });
  Object.assign(header, rendered.header);
  header.tz = tz;
  const shown = listing.hits.length;
  header.count = `${shown} of ${plural(listing.matching, "hit")} (${lines} scanned)`;
  if (listing.malformed > 0) header.malformed = plural(listing.malformed, "line");
  const label = before === 0 && afterN === 0 ? "hits" : "rows";
  header[label] = rendered.rows.map((r) => {
    const { id, t, kind, text, ...extra } = r;
    return { id, t, kind, why: whyById.get(String(id)) ?? "", text, ...extra };
  });

  const first: Hit = listing.hits[0]!;
  const firstId = formatId(first.event.id);
  const last = listing.hits[shown - 1]!.event.id;
  if (findCommand("around")?.status === "available") {
    help.push(`Run \`${BIN} around ${firstId} --before 10 --after 10${hint.showCarry}${tzc}\` for more context`);
  } else {
    const kindFlag = kinds ? ` --kind ${shellArg(getString(p, "kind")!)}` : "";
    help.push(`Run \`${BIN} events ${s} --from ${firstId} --limit 10${kindFlag}${tzc}\` for the rows from the first hit on`);
  }
  help.push(`Run \`${BIN} show ${firstId}${hint.showCarry}${tzc}\` ${first.event.kind === "call" ? "for the whole call and result" : "to see the first hit whole"}`);
  if (listing.matching > shown) help.push(`Run \`${findHint({ from: after(last) })}\` for the hits after ${formatId(last)}`);
  if (rendered.cut > 0) {
    help.push(`Run \`${findHint({ extra: " --full" })}\` for the whole text of the ${plural(rendered.cut, "row")} cut to ${head} chars`);
  }
  return renderDocument(header, help);
}

/** The non-phrase handles as given, for the no-session hint. */
function tail(p: Parsed): string {
  let out = "";
  for (const f of ["file", "tool", "kind"]) if (getString(p, f) !== undefined) out += ` --${f} ${shellArg(getString(p, f)!)}`;
  if (getBool(p, "regex")) out += " --regex";
  return out + carry(p);
}

