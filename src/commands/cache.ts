/** `cache status` and `cache clear` (specs/cli.md#cache). Nothing else depends on the cache. */
import { AxiError } from "axi-sdk-js";
import { cacheStatus, clearCache } from "../lib/cache/index.js";
import { claudeCode } from "../lib/adapters/claude-code/index.js";
import { resolveScope } from "../lib/scope.js";
import { findCommand } from "../reference.js";
import { getBool, getString, parseFlags, usageLine } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { renderDocument } from "../output/render.js";
import { formatSize } from "../output/sizes.js";
import { BIN, collapseHome, scopeOf, type Io } from "./common.js";

export async function cacheCommand(args: string[], io: Io): Promise<string> {
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    if (sub === undefined) throw new AxiError("cache needs a subcommand: status or clear", "USAGE", [usageLine("cache")]);
    return renderCommandHelp("cache") ?? "";
  }
  if (sub !== "status" && sub !== "clear") {
    throw new AxiError(`unknown cache subcommand ${sub}`, "USAGE", [usageLine("cache")]);
  }
  // Flags are per subcommand: status takes none, clear takes the scope.
  const flags = sub === "clear" ? (findCommand("cache")!.flags ?? []) : [];
  const p = parseFlags(`cache ${sub}`, args.slice(1), flags);
  if (p.help) return renderCommandHelp("cache") ?? "";
  if (p.positionals.length) throw new AxiError(`cache ${sub} takes no arguments`, "USAGE", [usageLine("cache")]);
  const opts = { env: io.env };
  return sub === "status" ? status(opts) : clear(p, io, opts);
}

async function status(opts: { env: Io["env"] }): Promise<string> {
  const s = await cacheStatus(opts);
  const dir = collapseHome(s.dir);
  if (!s.exists) {
    return renderDocument({ cache: `${dir} (absent)` }, [`Run \`${BIN} around <id>\` to index a session (the cache is optional)`]);
  }
  const header: Record<string, unknown> = { cache: dir, size: formatSize(s.size), tracked: `${s.tracked} file${s.tracked === 1 ? "" : "s"}` };
  header.count = `${s.indexed.length} indexed`;
  if (s.indexed.length) {
    header.indexed = s.indexed.map((f) => ({
      session: claudeCode.sessionForPath(f.path).short,
      lines: f.lines,
      checkpoints: f.checkpoints,
      size: f.size < 1000 ? f.size : formatSize(f.size),
      state: f.state,
      path: collapseHome(f.path),
    }));
  }
  return renderDocument(header, [
    `Run \`${BIN} cache clear\` to delete the cache (it is rebuilt on demand)`,
    `Run \`${BIN} around <id>\` to index a session`,
  ]);
}

async function clear(p: ReturnType<typeof parseFlags>, io: Io, opts: { env: Io["env"] }): Promise<string> {
  const project = getString(p, "project");
  const all = getBool(p, "all");
  // Validates --project/--all together before anything is touched.
  scopeOf("cache", p, io);
  if (project === undefined || all) {
    const r = await clearCache(opts);
    const dir = collapseHome((await cacheStatus(opts)).dir);
    return renderDocument({ cleared: r.existed ? `${dir} (deleted)` : "nothing to clear" });
  }
  const resolved = await resolveScope(scopeOf("cache", p, io));
  const paths: string[] = [];
  for (const proj of resolved.projects) for await (const s of claudeCode.listSessions(proj, { subagents: true })) paths.push(s.path);
  const r = await clearCache({ ...opts, paths });
  const where = resolved.projects[0]?.cwd ?? project;
  if (!r.existed || r.removed === 0) return renderDocument({ cleared: `nothing to clear for ${collapseHome(where)}` });
  return renderDocument({ cleared: `${r.removed} record${r.removed === 1 ? "" : "s"} for ${collapseHome(where)} (${paths.length} session files in scope)` });
}
