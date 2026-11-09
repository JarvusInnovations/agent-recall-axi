/**
 * `resume-pack <session>` (specs/cli.md#resume-pack-session): a thin rendering of
 * buildResumePack through the same renderResumePack the `agent-recall-axi/render` subpath
 * exports, so the CLI and a library caller print the same bytes.
 */
import { AxiError } from "axi-sdk-js";
import { AgentSessionError } from "../lib/errors.js";
import { buildResumePack, resumeOpts, type ResumePackOpts } from "../lib/resume.js";
import { findCommand } from "../reference.js";
import { getNumber, getString, parseFlags, usageLine } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { renderResumePack } from "../output/resume.js";
import { jsonOutTarget, withJsonOutLine, writeJsonOut } from "./json-out.js";
import { carry, rewriteNotice, scopeOf, sessionFromArg, sessionHint, withNotice, zoneOf, type Io } from "./common.js";

const NAME = "resume-pack";

/** `--window`: an index or `last` only (a pack is one window). */
function windowArg(text: string | undefined): number | "last" | undefined {
  if (text === undefined) return undefined;
  const v = text.trim();
  if (v === "last") return v;
  if (/^\d+$/.test(v)) return Number(v);
  throw new AxiError(`--window ${text} is not a window for a resume pack`, "VALIDATION_ERROR", ["resume-pack --window takes a 0-based window index or last (a pack is one window)"]);
}

export async function resumePackCommand(args: string[], io: Io): Promise<string> {
  const p = parseFlags(NAME, args, findCommand(NAME)?.flags ?? []);
  if (p.help) return renderCommandHelp(NAME) ?? "";
  if (p.positionals.length !== 1) {
    throw new AxiError(p.positionals.length ? `${NAME} takes one <session>` : `${NAME} needs a <session>`, "USAGE", [usageLine(NAME)]);
  }
  const tz = zoneOf(p, io);
  const opts: ResumePackOpts = { cache: { env: io.env } };
  const window = windowArg(getString(p, "window"));
  if (window !== undefined) opts.window = window;
  for (const k of ["budget", "tools", "claims"] as const) {
    const v = getNumber(p, k);
    if (v !== undefined) opts[k] = v;
  }
  try {
    resumeOpts(opts); // every value checked before any file is opened
  } catch (err) {
    if (err instanceof AgentSessionError) throw new AxiError(err.message, err.code, err.suggestions);
    throw err;
  }
  scopeOf(NAME, p, io);
  const jsonOut = await jsonOutTarget(NAME, p, io);
  const ref = p.positionals[0]!;
  const session = await sessionFromArg(NAME, ref, p, io);
  const notice = await rewriteNotice(session, io, tz);
  const pack = await withNotice(notice, () => buildResumePack(session, opts));
  const hint = await sessionHint(NAME, ref, session, p, io);
  const out = renderResumePack(pack, { tz, ref: hint.ref, showCarry: hint.showCarry, carry: carry(p), ...(notice ? { notice } : {}) });
  if (!jsonOut) return out;
  // --json-out (cli.md#conventions): the pack the library built, its layers whole.
  const { human, ...rest } = pack;
  const path = await writeJsonOut(jsonOut, async (j) => {
    await j.begin({ ...rest, session: pack.session.id }, "human");
    for (const ev of human) await j.item(ev);
    await j.end();
  });
  return withJsonOutLine(out, path);
}
