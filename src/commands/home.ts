/** The home view: content first (specs/cli.md#home-view-no-arguments). Never a whole-file pass. */
import { AgentSessionError } from "../lib/errors.js";
import { formatId, hintName } from "../lib/ids.js";
import { homeListing, LAST_HUMAN_BYTES, type HomeListing } from "../lib/home.js";
import { formatAgo, formatClock, formatDay, formatMonthDayClock, formatMonthDayMinute, resolveZone } from "../lib/time.js";
import { findCommand } from "../reference.js";
import { DEFAULT_HEAD, headCut, oneLine, renderDocument } from "../output/render.js";
import { BIN, collapseHome, unreadableNote, type Io } from "./common.js";
import { titleCell } from "./sessions.js";

const HOME_LIMIT = 5;

function lastHumanLine(listing: HomeListing, tz: string, now: Date): string {
  const lh = listing.lastHuman;
  if (!lh?.event) return lh?.missing === "bound" ? `none in the last ${LAST_HUMAN_BYTES >> 20}M` : "none";
  const ev = lh.event;
  const t = ev.t ? new Date(ev.t) : undefined;
  const time = t ? (formatDay(t, tz) === formatDay(now, tz) ? formatClock(t, tz) : formatMonthDayClock(t, tz)) : "";
  // Without a line number from the cache the id is left out: the home view never counts a whole file.
  const id = lh.numbered ? `${formatId(ev.id)} ` : "";
  return `${id}${time}${time ? " " : ""}"${headCut(oneLine(ev.text), DEFAULT_HEAD).text}"`;
}

export async function homeCommand(io: Io): Promise<string> {
  const tz = resolveZone(undefined, io.env);
  const body: Record<string, unknown> = {};
  const cache = { env: io.env };
  let listing: HomeListing;
  let none = false;
  try {
    listing = await homeListing({ cwd: io.cwd, env: io.env }, { limit: HOME_LIMIT, cache });
    body.project = `${collapseHome(listing.scope.projects[0]!.cwd)} (${listing.total} session${listing.total === 1 ? "" : "s"})`;
  } catch (err) {
    if (!(err instanceof AgentSessionError) || err.code !== "NO_SESSIONS") throw err;
    none = true;
    body.project = `none for ${collapseHome(io.cwd)}`;
    listing = await homeListing({ cwd: io.cwd, env: io.env, project: "all" }, { limit: HOME_LIMIT, cache });
  }
  const skipped = unreadableNote(listing);
  if (skipped.count) body.unreadable = skipped.count;
  const help: string[] = [];
  if (listing.sessions.length === 0) {
    body.sessions = `0 sessions under ${collapseHome(listing.scope.root)}`;
    if (skipped.help) help.push(skipped.help);
    help.push(`Run \`${BIN} --help\` for the full command list`);
    return renderDocument(body, help);
  }
  body.sessions = listing.sessions.map((s) => ({
    id: s.session.short,
    last: `${formatMonthDayMinute(new Date(s.last), tz)} (${formatAgo(new Date(s.last), io.now)})`,
    turns: s.turns ?? "",
    title: titleCell(s.title),
  }));
  const latest = listing.sessions[0]!.session;
  body.latest = latest.short;
  body.last_human = lastHumanLine(listing, tz, io.now);
  const name = hintName(latest, listing.shared);
  const scope = none ? " --all" : "";
  if (findCommand("resume-pack")?.status === "available") help.push(`Run \`${BIN} resume-pack ${name}${scope}\` for a cold-start pack of the latest session`);
  else help.push(`Run \`${BIN} human ${name} --window last${scope}\` for what the human asked in the latest session's live window`);
  const unnumbered = listing.lastHuman?.event !== undefined && !listing.lastHuman.numbered;
  help.push(`Run \`${BIN} tail ${name}${scope}\` for the last 20 rows${unnumbered ? " with their ids" : ""}`);
  if (none) help.push(`Run \`${BIN} sessions --project <path>\` for one project's sessions`);
  else help.push(`Run \`${BIN} find "<phrase>"\` to search this project's sessions`);
  help.push(`Run \`${BIN} recall "<phrase>"\` to search every project`);
  if (skipped.help) help.push(skipped.help);
  help.push(`Run \`${BIN} --help\` for the full command list, or \`${BIN} <command> --help\` for usage on any command`);
  return renderDocument(body, help);
}
