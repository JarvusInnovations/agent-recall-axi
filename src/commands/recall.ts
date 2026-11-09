/** `search <phrase>` (specs/cli.md#search-phrase): a cross-project search grouped by session (library `recall`). */
import { AxiError } from "axi-sdk-js";
import { AgentSessionError } from "../lib/errors.js";
import { formatId, hintName, sharedShorts } from "../lib/ids.js";
import { KINDS, type Kind } from "../lib/model.js";
import { recall, type RecallOpts } from "../lib/recall.js";
import { formatMonthDayMinute, parseSpan } from "../lib/time.js";
import { findCommand } from "../reference.js";
import { getBool, getNumber, getString, parseFlags, usageLine } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { renderDocument } from "../output/render.js";
import { formatBytes } from "../output/sizes.js";
import { BIN, carry, collapseHome, parseKinds, parseRange, scopeOf, shellArg, unreadableNote, zoneOf, type Io } from "./common.js";
import { jsonOutTarget, withJsonOutLine, writeJsonOut } from "./json-out.js";

/** search's default window (cli.md#search-phrase). */
const RECALL_SINCE = "90d";
/** How many sessions get their own `find` hint. */
const FIND_HINTS = 5;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

export async function recallCommand(args: string[], io: Io): Promise<string> {
  const p = parseFlags("search", args, findCommand("search")?.flags ?? []);
  if (p.help) return renderCommandHelp("search") ?? "";
  const usage = usageLine("search");
  if (p.positionals.length !== 1) {
    throw new AxiError(p.positionals.length ? 'search takes one <phrase> (quote a phrase with spaces: search "two words")' : "search needs a <phrase>", "USAGE", [usage]);
  }
  const phrase = p.positionals[0]!;
  if (phrase === "") throw new AxiError("the phrase is empty", "USAGE", [usage]);
  const tz = zoneOf(p, io);
  const range = parseRange("search", p, tz, io.now, false);
  const parsedKinds = parseKinds(getString(p, "kind"));
  const kinds = parsedKinds === "all" ? [...KINDS] : parsedKinds;
  const limit = getNumber(p, "limit") ?? 20;
  const scope = scopeOf("search", p, io);
  const project = getString(p, "project");
  const defaulted = getString(p, "since") === undefined && getString(p, "from") === undefined;
  const opts: RecallOpts = { scope, limit: 0, cache: { env: io.env } };
  if (getBool(p, "regex")) opts.regex = true;
  if (getString(p, "file") !== undefined) opts.file = getString(p, "file")!;
  if (getString(p, "tool") !== undefined) opts.tool = getString(p, "tool")!;
  if (kinds) opts.kinds = kinds as Kind[];
  if (defaulted) opts.from = new Date(io.now.getTime() - parseSpan(RECALL_SINCE));
  else if (range.from instanceof Date) opts.from = range.from;
  if (range.to instanceof Date) opts.to = range.to;
  const jsonOut = await jsonOutTarget("search", p, io);
  let r;
  try {
    // Validates the regex, patterns and kinds before any log is read.
    r = await recall(phrase, opts);
  } catch (err) {
    if (err instanceof AgentSessionError && (err.code === "VALIDATION_ERROR" || err.code === "USAGE")) throw new AxiError(err.message, err.code, err.suggestions);
    throw err;
  }
  const shown = limit > 0 ? r.sessions.slice(0, limit) : r.sessions;

  // ---- render
  const sinceText = defaulted ? RECALL_SINCE : getString(p, "since") ?? getString(p, "from");
  let handles = "";
  if (opts.regex) handles += " --regex";
  for (const f of ["file", "tool", "kind"]) if (getString(p, f) !== undefined) handles += ` --${f} ${shellArg(getString(p, f)!)}`;
  const dash = phrase.startsWith("-");
  const phraseArg = dash ? "" : ` ${shellArg(phrase)}`;
  const trailing = dash ? ` -- ${shellArg(phrase)}` : "";
  const scopeFlag = project !== undefined ? ` --project ${shellArg(project)}` : " --all";
  const time = `${getString(p, "since") !== undefined ? ` --since ${shellArg(getString(p, "since")!)}` : ""}${getString(p, "from") !== undefined ? ` --from ${shellArg(getString(p, "from")!)}` : ""}${getString(p, "to") !== undefined ? ` --to ${shellArg(getString(p, "to")!)}` : ""}`;
  const tzc = carry(p);
  const header: Record<string, unknown> = {};
  header.query = `phrase ${opts.regex ? `/${phrase}/` : `"${phrase}"`}${opts.file !== undefined ? ` + file ${opts.file}` : ""}${opts.tool !== undefined ? ` + tool ${opts.tool}` : ""}${kinds ? ` + kind ${getString(p, "kind")}` : ""}`;
  header.scope = r.scope.all ? "all projects" : `${collapseHome(r.scope.projects[0]?.cwd ?? "")} (project)`;
  if (sinceText !== undefined) header.since = defaulted ? `${RECALL_SINCE} (the default)` : sinceText;
  header.scanned = `${plural(r.scanned.sessions, "session")}, ${formatBytes(r.scanned.bytes)}, ${(r.scanned.ms / 1000).toFixed(1)}s`;
  header.index = r.scanned.index;
  const skipped = unreadableNote(r);
  if (skipped.count) header.unreadable = skipped.count;
  header.tz = tz;
  const help: string[] = [];
  let out: string;
  if (shown.length === 0) {
    header.sessions = `0 of ${r.scanned.sessions} scanned mention ${opts.regex ? `/${phrase}/` : `"${phrase}"`}${sinceText !== undefined ? ` since ${sinceText}` : ""}`;
    help.push(`Run \`${BIN} search${phraseArg}${handles} --since 1y${getString(p, "to") !== undefined ? ` --to ${shellArg(getString(p, "to")!)}` : ""}${project !== undefined ? scopeFlag : ""}${tzc}${trailing}\` to look back a year`);
    help.push(`Run \`${BIN} find${phraseArg} --all${time}${tzc}${trailing}\` to search tool output too`);
    if (skipped.help) help.push(skipped.help);
    out = renderDocument(header, help);
  } else {
    header.count = `${shown.length} of ${plural(r.matching, "session")}`;
    header.sessions = shown.map((s) => ({
      id: s.session.short,
      project: s.session.project ? collapseHome(s.session.project.cwd) : "",
      last: formatMonthDayMinute(s.last, tz),
      hits: s.hits,
      first: formatId(s.first),
    }));
    const shared = await sharedShorts(r.scope);
    for (const s of shown.slice(0, FIND_HINTS)) {
      help.push(`Run \`${BIN} find ${hintName(s.session, shared)}${phraseArg}${handles}${scopeFlag}${tzc}${trailing}\` to dig into ${s.session.short}`);
    }
    if (shown.length < r.matching) help.push(`Run \`${BIN} search${phraseArg}${handles}${time}${project !== undefined ? scopeFlag : ""} --limit 0${tzc}${trailing}\` for all ${plural(r.matching, "session")}`);
    if (skipped.help) help.push(skipped.help);
    out = renderDocument(header, help);
  }
  if (!jsonOut) return out;
  const path = await writeJsonOut(jsonOut, async (j) => {
    await j.begin({ query: header.query, scanned: r.scanned }, "sessions");
    for (const s of r.sessions) await j.item({ id: s.session.id, short: s.session.short, kind: s.session.kind, path: s.session.path, project: s.session.project?.cwd, last: s.last, hits: s.hits, first: s.first });
    await j.end({ matching: r.matching });
  });
  return withJsonOutLine(out, path);
}
