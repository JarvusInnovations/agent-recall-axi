/** `sessions` (specs/cli.md#sessions): sessions in scope with their stats, most recently active first. */
import { AxiError } from "axi-sdk-js";
import { hintName, sharedShorts } from "../lib/ids.js";
import { sessionListing, type SessionInfo } from "../lib/session.js";
import { headerTitle } from "../lib/stats.js";
import type { Session } from "../lib/model.js";
import type { Scope } from "../lib/scope.js";
import { formatAgo, formatMonthDayMinute } from "../lib/time.js";
import { findCommand, SESSIONS_FIELDS } from "../reference.js";
import { getBool, getNumber, getString, parseFlags } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { DEFAULT_HEAD, headCut, oneLine, renderDocument } from "../output/render.js";
import { BIN, carry, collapseHome, parseRange, shellPath, unreadableNote, zoneOf, type Io } from "./common.js";
import { jsonOutTarget, withJsonOutLine, writeJsonOut } from "./json-out.js";

type Field = (typeof SESSIONS_FIELDS)[number];

/** `live`: `last` within 5 minutes of now (data-model.md#session). */
const LIVE_MS = 5 * 60 * 1000;
export const isLive = (last: string, now: Date) => Math.abs(now.getTime() - Date.parse(last)) <= LIVE_MS;

/** A title cell: one line, cut to the row head (data-model.md#session); empty when there is none. */
export function titleCell(title: string | undefined): string {
  return title === undefined ? "" : headCut(oneLine(title).trim(), DEFAULT_HEAD).text;
}

/**
 * `<s8> <title>` for a single-session header (cli.md#conventions): the cheap, cache-free title
 * sources only, so cold and warm runs print the same bytes; `(untitled)` when none has one.
 */
export async function headerName(session: Session): Promise<string> {
  const title = titleCell(await headerTitle(session));
  return `${session.short} ${title || "(untitled)"}`;
}

function parseFields(text: string | undefined): Field[] {
  if (text === undefined) return [];
  const names = text.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !(SESSIONS_FIELDS as readonly string[]).includes(n));
  if (bad.length || names.length === 0) {
    throw new AxiError(`unknown field: ${bad.join(", ") || "(empty)"}`, "VALIDATION_ERROR", [`fields: ${SESSIONS_FIELDS.join(", ")}`]);
  }
  return [...new Set(names)] as Field[];
}

export function sessionRow(s: SessionInfo, tz: string, now: Date, extra: readonly string[]): Record<string, string | number | boolean> {
  const row: Record<string, string | number | boolean> = {
    id: s.short,
    started: s.started ? formatMonthDayMinute(new Date(s.started), tz) : "",
    last: `${formatMonthDayMinute(new Date(s.last), tz)} (${formatAgo(new Date(s.last), now)})`,
    turns: s.turns,
    title: titleCell(s.title),
  };
  for (const f of extra) {
    switch (f) {
      case "uuid":
        row.uuid = s.id;
        break;
      case "path":
        row.path = collapseHome(s.path);
        break;
      case "project":
        row.project = s.project ? collapseHome(s.project.cwd) : "";
        break;
      case "bytes":
      case "lines":
      case "calls":
      case "compactions":
      case "humans":
        row[f] = s[f];
        break;
      case "live":
        row.live = isLive(s.last, now);
        break;
      case "kind":
        row.kind = s.kind;
        break;
      case "parent":
        row.parent = s.parent ? s.parent.slice(0, 8) : "";
        break;
      case "model":
        row.model = s.model ?? "";
        break;
    }
  }
  return row;
}

export async function sessionsCommand(args: string[], io: Io): Promise<string> {
  const spec = findCommand("sessions")!;
  const p = parseFlags("sessions", args, spec.flags ?? []);
  if (p.help) return renderCommandHelp("sessions") ?? "";
  if (p.positionals.length) throw new AxiError(`sessions takes no arguments (got ${p.positionals[0]})`, "USAGE", [`usage: ${BIN} ${spec.usage}`]);
  const project = getString(p, "project");
  const all = getBool(p, "all");
  if (project !== undefined && all) throw new AxiError("--project and --all both set the scope; pass one", "USAGE", [`usage: ${BIN} ${spec.usage}`]);
  const tz = zoneOf(p, io);
  const range = parseRange("sessions", p, tz, io.now, false);
  const fields = parseFields(getString(p, "fields"));
  const subagents = getBool(p, "subagents");
  const limit = getNumber(p, "limit") ?? 20;
  const extra = [...(subagents ? (["kind", "parent"] as Field[]) : []), ...fields.filter((f) => !(subagents && (f === "kind" || f === "parent")))];
  const jsonOut = await jsonOutTarget("sessions", p, io);

  const scope: Scope = { cwd: io.cwd, env: io.env, subagents };
  if (all) scope.project = "all";
  else if (project !== undefined) scope.project = project;
  const window = { ...(range.from instanceof Date ? { from: range.from } : {}), ...(range.to instanceof Date ? { to: range.to } : {}) };
  const listing = await sessionListing(scope, { ...window, limit: 0, cache: { env: io.env } });
  const every = listing.sessions;
  const shownSessions = limit > 0 ? every.slice(0, limit) : every;

  const scopeFlag = all ? " --all" : project !== undefined ? ` --project ${shellPath(project)}` : "";
  const header: Record<string, unknown> = {};
  const where = listing.scope.all
    ? `all projects under ${collapseHome(listing.scope.root)}`
    : collapseHome(listing.scope.projects[0]?.cwd ?? listing.scope.root);
  if (listing.scope.all) header.projects = `${listing.scope.projects.length} under ${collapseHome(listing.scope.root)}`;
  else header.project = `${where} (${listing.total} session${listing.total === 1 ? "" : "s"})`;
  header.tz = tz;
  const skipped = unreadableNote(listing);
  if (skipped.count) header.unreadable = skipped.count;
  const help: string[] = [];
  let out: string;
  if (shownSessions.length === 0) {
    header.sessions = `0 sessions in ${where}${range.from || range.to ? " in that time window" : ""}`;
    if (!listing.scope.all) help.push(`Run \`${BIN} sessions --all${carry(p)}\` to list every project's sessions`);
    if (skipped.help) help.push(skipped.help);
    out = renderDocument(header, help);
  } else {
    header.count = `${shownSessions.length} of ${listing.matching}`;
    header.sessions = shownSessions.map((s) => sessionRow(s, tz, io.now, extra));
    const top = shownSessions[0]!;
    const name = hintName(top, await sharedShorts(listing.scope));
    help.push(`Run \`${BIN} turns ${name}${scopeFlag}${carry(p)}\` for one row per prompt of ${top.short}`);
    if (findCommand("resume-pack")?.status === "available") help.push(`Run \`${BIN} resume-pack ${name}${scopeFlag}${carry(p)}\` for a cold-start pack of ${top.short}`);
    help.push(`Run \`${BIN} find "<phrase>"${scopeFlag}${carry(p)}\` to search these sessions`);
    if (shownSessions.length < listing.matching) {
      help.push(`Run \`${BIN} sessions${scopeFlag}${rangeFlags(p)} --limit 0${subagents ? " --subagents" : ""}${fields.length ? ` --fields ${fields.join(",")}` : ""}${carry(p)}\` for all ${listing.matching} sessions`);
    }
    if (skipped.help) help.push(skipped.help);
    out = renderDocument(header, help);
  }
  if (!jsonOut) return out;
  const path = await writeJsonOut(jsonOut, async (j) => {
    await j.begin({ count: every.length }, "sessions");
    for (const s of every) await j.item({ ...s, live: isLive(s.last, io.now) });
    await j.end();
  });
  return withJsonOutLine(out, path);
}

/** `--since`/`--from`/`--to` as given, for the paging hint. */
function rangeFlags(p: ReturnType<typeof parseFlags>): string {
  let out = "";
  for (const f of ["since", "from", "to"]) {
    const v = getString(p, f);
    if (v !== undefined) out += ` --${f} ${shellPath(v)}`;
  }
  return out;
}
