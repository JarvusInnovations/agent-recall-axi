/** `sessions` (specs/cli.md#sessions). Minimal schema for now: no stats, title pending. */
import { AxiError } from "axi-sdk-js";
import { sessionListing, type SessionInfo } from "../lib/session.js";
import type { Scope } from "../lib/scope.js";
import { formatAgo, formatMonthDayMinute } from "../lib/time.js";
import { findCommand, SESSIONS_FIELDS } from "../reference.js";
import { getBool, getNumber, getString, parseFlags } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { renderDocument } from "../output/render.js";
import { BIN, carry, collapseHome, parseRange, shellPath, unreadableNote, zoneOf, type Io } from "./common.js";

/** Titles land with sessions-and-recall; until then the column says so instead of guessing. */
export const TITLE_PENDING = "(pending)";

type Field = (typeof SESSIONS_FIELDS)[number];

function parseFields(text: string | undefined): Field[] {
  if (text === undefined) return [];
  const names = text.split(",").map((s) => s.trim()).filter(Boolean);
  const bad = names.filter((n) => !(SESSIONS_FIELDS as readonly string[]).includes(n));
  if (bad.length) {
    throw new AxiError(`unknown field: ${bad.join(", ")}`, "VALIDATION_ERROR", [
      `fields: ${SESSIONS_FIELDS.join(", ")} (turns, calls, compactions, humans, lines, live arrive with sessions-and-recall)`,
    ]);
  }
  return names as Field[];
}

export function sessionRow(s: SessionInfo, tz: string, now: Date, extra: readonly string[]): Record<string, string | number> {
  const row: Record<string, string | number> = {
    id: s.short,
    started: s.started ? formatMonthDayMinute(new Date(s.started), tz) : "",
    last: `${formatMonthDayMinute(new Date(s.last), tz)} (${formatAgo(new Date(s.last), now)})`,
    title: TITLE_PENDING,
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
        row.bytes = s.bytes;
        break;
      case "kind":
        row.kind = s.kind;
        break;
      case "parent":
        row.parent = s.parent ? s.parent.slice(0, 8) : "";
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

  const scope: Scope = { cwd: io.cwd, env: io.env, subagents };
  if (all) scope.project = "all";
  else if (project !== undefined) scope.project = project;
  const listing = await sessionListing(scope, { ...(range.from instanceof Date ? { from: range.from } : {}), ...(range.to instanceof Date ? { to: range.to } : {}), limit });

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
  if (listing.sessions.length === 0) {
    header.sessions = `0 sessions in ${where}${range.from || range.to ? " in that time window" : ""}`;
    if (!listing.scope.all) help.push(`Run \`${BIN} sessions --all${carry(p)}\` to list every project's sessions`);
    if (skipped.help) help.push(skipped.help);
    return renderDocument(header, help);
  }
  header.count = `${listing.sessions.length} of ${listing.matching}`;
  header.sessions = listing.sessions.map((s) => sessionRow(s, tz, io.now, extra));
  const top = listing.sessions[0]!;
  help.push(`Run \`${BIN} tail ${top.short}${scopeFlag}${carry(p)}\` for the last rows of ${top.short}`);
  if (!fields.includes("path")) help.push(`Run \`${BIN} sessions${scopeFlag} --fields path${carry(p)}\` for each session's file path`);
  if (listing.sessions.length < listing.matching) {
    help.push(`Run \`${BIN} sessions${scopeFlag} --limit 0${carry(p)}\` for all ${listing.matching} sessions`);
  }
  if (skipped.help) help.push(skipped.help);
  return renderDocument(header, help);
}
