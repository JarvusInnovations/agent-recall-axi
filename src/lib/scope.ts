/**
 * Which sessions: log root, cwd → project, `--project`, `--all`
 * (specs/behaviors/time-and-scope.md#which-sessions-session---project---all).
 */
import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { AgentSessionError } from "./errors.js";
import type { Project } from "./model.js";
import { claudeCode } from "./adapters/claude-code/index.js";
import { encodeCwd, projectForDir } from "./adapters/claude-code/sessions.js";

export interface Scope {
  /** Log root; default from the adapter (`CLAUDE_CONFIG_DIR/projects` or `~/.claude/projects`). */
  root?: string;
  /** A project path, encoded dir name or unique cwd substring; or "all". */
  project?: string;
  /** Working directory for the default scope; default `process.cwd()`. */
  cwd?: string;
  subagents?: boolean;
  env?: Record<string, string | undefined>;
}

export interface ResolvedScope {
  root: string;
  all: boolean;
  projects: Project[];
}

export function rootOf(scope: Scope = {}): string {
  return scope.root ?? claudeCode.root(scope.env ?? process.env);
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function allProjects(root: string): Promise<Project[]> {
  const out: Project[] = [];
  for await (const p of claudeCode.listProjects(root)) out.push(p);
  return out;
}

const NO_SESSIONS_HINTS = [
  "Pass `--project <path>` naming a directory an agent ran in",
  "Pass `--all` to use every project under the log root",
];

/** The project whose cwd is `dir`, looked up by encoded name first, then by scanning. */
async function projectForCwd(root: string, dir: string, scanned?: Project[]): Promise<Project | undefined> {
  const candidate = join(root, encodeCwd(dir));
  if (await isDir(candidate)) {
    const p = await projectForDir(candidate);
    if (p.cwd === dir || !p.cwdFromEntry) return p;
  }
  const projects = scanned ?? (await allProjects(root));
  return projects.find((p) => p.cwd === dir);
}

function expandHome(value: string): string {
  if (value === "~") return homedir();
  if (value.startsWith("~/")) return join(homedir(), value.slice(2));
  return value;
}

function looksLikePath(value: string): boolean {
  return value.startsWith("/") || value.startsWith(".") || value.startsWith("~");
}

export async function resolveScope(scope: Scope = {}): Promise<ResolvedScope> {
  const root = rootOf(scope);
  if (scope.project === "all") return { root, all: true, projects: await allProjects(root) };

  if (scope.project !== undefined) {
    const value = scope.project;
    const abs = resolve(scope.cwd ?? process.cwd(), expandHome(value));
    if (looksLikePath(value) || (await isDir(abs))) {
      const p = await projectForCwd(root, abs);
      if (p) return { root, all: false, projects: [p] };
      throw new AgentSessionError(`no session logs for ${value}`, "NO_SESSIONS", NO_SESSIONS_HINTS, { project: abs });
    }
    if (await isDir(join(root, value))) {
      return { root, all: false, projects: [await projectForDir(join(root, value))] };
    }
    const matches = (await allProjects(root)).filter((p) => p.cwd.includes(value));
    if (matches.length === 1) return { root, all: false, projects: matches };
    if (matches.length > 1) {
      throw new AgentSessionError(
        `--project ${value} matches ${matches.length} projects`,
        "VALIDATION_ERROR",
        matches.slice(0, 10).map((p) => `--project ${p.cwd}`),
        { candidates: matches.map((p) => p.cwd) },
      );
    }
    throw new AgentSessionError(`no project matches ${value}`, "NO_SESSIONS", NO_SESSIONS_HINTS);
  }

  const cwd = resolve(scope.cwd ?? process.cwd());
  let scanned: Project[] | undefined;
  for (let dir = cwd; ; dir = dirname(dir)) {
    const candidate = join(root, encodeCwd(dir));
    if (await isDir(candidate)) {
      const p = await projectForDir(candidate);
      if (p.cwd === dir || !p.cwdFromEntry) return { root, all: false, projects: [p] };
    }
    scanned ??= await allProjects(root);
    const hit = scanned.find((p) => p.cwd === dir);
    if (hit) return { root, all: false, projects: [hit] };
    if (dirname(dir) === dir) break;
  }
  throw new AgentSessionError(`no session logs for ${cwd}`, "NO_SESSIONS", NO_SESSIONS_HINTS, { cwd });
}
