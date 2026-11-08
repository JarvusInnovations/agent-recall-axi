/** `find` without a `<session>`: the project, or every project (specs/cli.md#find, cross-session). */
import { AxiError } from "axi-sdk-js";
import { AgentSessionError } from "../lib/errors.js";
import { comparePosition, formatId, hintName, parseId, sharedShorts } from "../lib/ids.js";
import { findAcross, findAcrossListing, type FindQuery, type ScopedHit, type Why } from "../lib/find.js";
import { parseSpan } from "../lib/time.js";
import type { Event, EventId, Kind, Session } from "../lib/model.js";
import type { RowField } from "../reference.js";
import { getBool, getString, type Parsed } from "../flags.js";
import { renderDocument, renderRows } from "../output/render.js";
import { formatBytes } from "../output/sizes.js";
import { BIN, carry, collapseHome, scopeCarry, scopeOf, shellArg, unreadableNote, type Io } from "./common.js";
import { describeQuery } from "./find.js";
import { withJsonOutLine, writeJsonOut, type JsonOutTarget } from "./json-out.js";

/** The default window of a search across every project (cli.md#find). */
export const ALL_SINCE = "90d";

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** A time bound as given, unless it is an id (an id is one session's position). */
function timeFlag(p: Parsed, name: string): string {
  const v = getString(p, name);
  if (v === undefined || parseId(v.toLowerCase())) return "";
  return ` --${name} ${shellArg(v)}`;
}

/** The query's handles as given: the phrase (placed after `--` when it starts with a dash), --regex, --file, --tool, --kind. */
function handles(p: Parsed, phrase: string | undefined, regex: boolean): { args: string; trailing: string } {
  let args = "";
  let trailing = "";
  if (phrase !== undefined) {
    if (phrase.startsWith("-")) trailing = ` -- ${shellArg(phrase)}`;
    else args += ` ${shellArg(phrase)}`;
    if (regex) args += " --regex";
  }
  for (const f of ["file", "tool", "kind"]) if (getString(p, f) !== undefined) args += ` --${f} ${shellArg(getString(p, f)!)}`;
  return { args, trailing };
}

/** `find <query> --all`: the same handles and time bounds (never an id bound), `--tz` carried. */
export function allHint(p: Parsed, phrase: string | undefined, regex: boolean): string {
  const h = handles(p, phrase, regex);
  return `${BIN} find${h.args}${timeFlag(p, "since")}${timeFlag(p, "from")}${timeFlag(p, "to")} --all${carry(p)}${h.trailing}`;
}

/** The position just after `id`, for an inclusive `--from` that continues past it. */
function after(id: EventId): string {
  return id.block === undefined ? `${id.session}:${id.seq + 1}` : `${id.session}:${id.seq}.${id.block + 1}`;
}

export interface AcrossArgs {
  p: Parsed;
  io: Io;
  q: FindQuery;
  phrase: string | undefined;
  file: string | undefined;
  tool: string | undefined;
  kinds: readonly Kind[] | undefined;
  tz: string;
  head: number;
  fields: readonly string[];
  deep: boolean;
  before: number;
  afterN: number;
  full: boolean;
  jsonOut: JsonOutTarget | undefined;
}

export async function runFindAcross(a: AcrossArgs): Promise<string> {
  const { p, io, q, phrase, tz } = a;
  const all = getBool(p, "all");
  for (const f of ["from", "to"]) {
    const v = getString(p, f);
    if (v !== undefined && parseId(v.toLowerCase())) {
      throw new AxiError(`--${f} ${v} is an id, a position in one session: name its session to search from it`, "VALIDATION_ERROR", [
        `Run \`${BIN} find ${v.split(":")[0]}${handles(p, phrase, q.regex === true).args} --${f} ${v}${scopeCarry(p)}${carry(p)}${handles(p, phrase, q.regex === true).trailing}\` to search that session`,
        "a cross-session search is bounded by time (--since 7d, --from 2026-11-01)",
      ]);
    }
  }
  const scope = scopeOf("find", p, io);
  // --all defaults to the last 90 days (cli.md#find); a project search to everything.
  const defaulted = all && getString(p, "since") === undefined && getString(p, "from") === undefined;
  const query: FindQuery & { since?: Date } = { ...q };
  if (defaulted) query.since = new Date(io.now.getTime() - parseSpan(ALL_SINCE));
  let listing;
  try {
    listing = await findAcrossListing(scope, query);
  } catch (err) {
    if (err instanceof AgentSessionError && err.code === "VALIDATION_ERROR") throw new AxiError(err.message, err.code, err.suggestions);
    throw err;
  }
  const shared = await sharedShorts(listing.scope);
  const sc = scopeCarry(p);
  const tzc = carry(p);
  const regex = q.regex === true;
  const h = handles(p, phrase, regex);
  const query_ = describeQuery(q, getString(p, "kind"));
  const where = listing.scope.all ? "all projects" : `${collapseHome(listing.scope.projects[0]?.cwd ?? listing.scope.root)} (project)`;
  const header: Record<string, unknown> = { scope: where, query: query_ };
  if (a.deep) header.deep = "yes";
  if (defaulted) header.since = `${ALL_SINCE} (the --all default)`;
  const scanned = `${plural(listing.scanned.sessions, "session")}, ${formatBytes(listing.scanned.bytes)}`;
  header.scanned = scanned;
  const skipped = unreadableNote(listing);
  if (skipped.count) header.unreadable = skipped.count;
  const help: string[] = [];
  /** How a hint names a hit's session, so its id resolves in this scope. */
  const idCarry = (s: Session) => (shared.has(s.short) && /^[0-9a-f]{8}/i.test(s.id) ? ` --session ${s.id}${sc}` : sc);
  const range = `${timeFlag(p, "since")}${timeFlag(p, "from")}${timeFlag(p, "to")}`;
  const view = `${getString(p, "window") !== undefined ? ` --window ${shellArg(getString(p, "window")!)}` : ""}${a.deep ? " --deep" : ""}`;
  const findAll = (extra: string) => `${BIN} find${h.args}${range}${view}${extra}${sc}${tzc}${h.trailing}`;

  let out: string;
  if (listing.hits.length === 0) {
    header.tz = tz;
    header.hits = `0 events match ${query_} in ${listing.scope.all ? "all projects" : collapseHome(listing.scope.projects[0]?.cwd ?? "")} (${scanned} scanned)`;
    if (!listing.scope.all) help.push(`Run \`${allHint(p, phrase, regex)}\` to search every project`);
    else if (defaulted) help.push(`Run \`${BIN} find${h.args}${view} --all --since 1y${tzc}${h.trailing}\` to search the last year`);
    const given: Why[] = [];
    if (phrase !== undefined) given.push("phrase");
    if (a.file !== undefined) given.push("file");
    if (a.tool !== undefined) given.push("tool");
    if (a.kinds) given.push("kind");
    if (given.length > 1) help.push("Drop one of the filters (the phrase, --file, --tool, --kind) to widen the search");
    if (skipped.help) help.push(skipped.help);
    out = renderDocument(header, help);
  } else {
    // Hits and their contexts, each row once, grouped by session in the order read, file order within.
    const order = new Map(listing.sessions.map((s, i) => [s, i]));
    const rows = new Map<string, { ev: Event; session: Session }>();
    const why = new Map<string, string>();
    const key = (s: Session, id: EventId) => `${s.path}\u0000${formatId(id)}`;
    for (const hit of listing.hits) {
      rows.set(key(hit.session, hit.event.id), { ev: hit.event, session: hit.session });
      why.set(key(hit.session, hit.event.id), hit.why.join("+"));
      for (const c of hit.context) if (!rows.has(key(hit.session, c.id))) rows.set(key(hit.session, c.id), { ev: c, session: hit.session });
    }
    for (const hit of listing.inContext) why.set(key(hit.session, hit.event.id), hit.why.join("+"));
    const sorted = [...rows.entries()].sort(([, x], [, y]) => (x.session === y.session ? comparePosition(x.ev.id, y.ev.id) : order.get(x.session)! - order.get(y.session)!));
    const rendered = renderRows(sorted.map(([, r]) => r.ev), tz, { head: a.head, fields: a.fields as readonly RowField[] });
    Object.assign(header, rendered.header);
    header.tz = tz;
    const shown = listing.hits.length + listing.inContext.length;
    header.count = `${shown} of ${plural(listing.matching, "hit")}`;
    const label = a.before === 0 && a.afterN === 0 ? "hits" : "rows";
    header[label] = rendered.rows.map((r, i) => {
      const { id, t, kind, text, ...extra } = r;
      return { id, t, kind, why: why.get(sorted[i]![0]) ?? "", text, ...extra };
    });
    const first: ScopedHit = listing.hits[0]!;
    const firstId = formatId(first.event.id);
    help.push(`Run \`${BIN} around ${firstId} --before 10 --after 10${idCarry(first.session)}${tzc}\` for more context`);
    help.push(`Run \`${BIN} show ${firstId}${idCarry(first.session)}${tzc}\` ${first.event.kind === "call" ? "for the whole call and result" : "to see the first hit whole"}`);
    if (listing.matching > shown) {
      const last = listing.inContext.length ? listing.inContext[listing.inContext.length - 1]! : listing.hits[listing.hits.length - 1]!;
      const name = hintName(last.session, shared);
      // Continued by position, so the caller's start bound gives way to the id (as in one session).
      help.push(`Run \`${BIN} find ${name}${h.args} --from ${after(last.event.id)}${timeFlag(p, "to")}${view}${sc}${tzc}${h.trailing}\` for the rest of ${last.session.short}'s hits`);
      help.push(`Run \`${findAll(" --limit 0")}\` for all ${plural(listing.matching, "hit")}`);
    }
    if (rendered.cut > 0) help.push(`Run \`${findAll(" --full")}\` for the whole text of the ${plural(rendered.cut, "row")} cut to ${a.head} chars`);
    if (!listing.scope.all) help.push(`Run \`${allHint(p, phrase, regex)}\` to search every project`);
    if (skipped.help) help.push(skipped.help);
    out = renderDocument(header, help);
  }
  if (!a.jsonOut) return out;
  const path = await writeJsonOut(a.jsonOut, async (j) => {
    await j.begin({ scope: where, query: query_ }, "hits");
    for await (const hit of findAcross(scope, { ...query, limit: 0 })) await j.item({ ...hit, session: hit.session.id });
    await j.end({ matching: listing.matching, scanned: listing.scanned });
  });
  return withJsonOutLine(out, path);
}
