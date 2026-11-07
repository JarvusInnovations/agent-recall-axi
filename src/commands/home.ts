/** The home view: content first (specs/cli.md#home-view-no-arguments). Minimal until stats land. */
import { AgentSessionError } from "../lib/errors.js";
import { hintName, sharedShorts } from "../lib/ids.js";
import { sessionListing } from "../lib/session.js";
import { formatAgo, formatMonthDayMinute, resolveZone } from "../lib/time.js";
import { renderDocument } from "../output/render.js";
import { BIN, collapseHome, unreadableNote, type Io } from "./common.js";
import { TITLE_PENDING } from "./sessions.js";

const HOME_LIMIT = 5;

export async function homeCommand(io: Io): Promise<string> {
  const tz = resolveZone(undefined, io.env);
  const body: Record<string, unknown> = {};
  let listing;
  try {
    listing = await sessionListing({ cwd: io.cwd, env: io.env }, { limit: HOME_LIMIT });
    body.project = `${collapseHome(listing.scope.projects[0]!.cwd)} (${listing.total} session${listing.total === 1 ? "" : "s"})`;
  } catch (err) {
    if (!(err instanceof AgentSessionError) || err.code !== "NO_SESSIONS") throw err;
    body.project = `none for ${collapseHome(io.cwd)}`;
    listing = await sessionListing({ cwd: io.cwd, env: io.env, project: "all" }, { limit: HOME_LIMIT });
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
    id: s.short,
    last: `${formatMonthDayMinute(new Date(s.last), tz)} (${formatAgo(new Date(s.last), io.now)})`,
    title: TITLE_PENDING,
  }));
  const latest = listing.sessions[0]!;
  body.latest = latest.short;
  const name = hintName(latest, await sharedShorts(listing.scope));
  help.push(`Run \`${BIN} tail ${name}${listing.scope.all ? " --all" : ""}\` for the last 20 rows of the latest session`);
  if (listing.scope.all) help.push(`Run \`${BIN} sessions --project <path>\` for one project's sessions`);
  else help.push(`Run \`${BIN} sessions --fields path\` for every session in this project`);
  if (skipped.help) help.push(skipped.help);
  help.push(`Run \`${BIN} --help\` for the full command list, or \`${BIN} <command> --help\` for usage on any command`);
  return renderDocument(body, help);
}
