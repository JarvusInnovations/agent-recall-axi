/** Claude Code project dirs, session files, sidecars and subagents (data-model.md#project, #session). */
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import type { Project, Session } from "../../model.js";
import { readLines } from "../../reader.js";

export const ADAPTER_ID = "claude-code";

/** `CLAUDE_CONFIG_DIR/projects`, else `~/.claude/projects`. */
export function defaultRoot(env: Record<string, string | undefined> = process.env): string {
  const config = env.CLAUDE_CONFIG_DIR;
  return join(config && config.length ? config : join(homedir(), ".claude"), "projects");
}

/** Claude Code's directory naming: every character outside [A-Za-z0-9] becomes `-` (lossy). */
export function encodeCwd(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, "-");
}

/** The lossy fallback when no entry carries `cwd`. */
export function decodeDirName(encoded: string): string {
  return encoded.replace(/-/g, "/");
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

async function jsonlFiles(dir: string): Promise<string[]> {
  try {
    const names = await readdir(dir, { withFileTypes: true });
    return names
      .filter((d) => d.isFile() && d.name.endsWith(".jsonl"))
      .map((d) => d.name)
      .sort();
  } catch {
    return [];
  }
}

/** The `cwd` of the first entry that has one, within the head of a file. */
export async function firstCwd(path: string, maxLines = 200): Promise<string | undefined> {
  let n = 0;
  try {
    for await (const line of readLines(path)) {
      if (++n > maxLines) break;
      if (!line.text.includes('"cwd"')) continue;
      try {
        const obj = JSON.parse(line.text) as { cwd?: unknown };
        if (typeof obj.cwd === "string" && obj.cwd) return obj.cwd;
      } catch {
        // malformed: keep looking
      }
    }
  } catch {
    return undefined;
  }
  return undefined;
}

export async function projectForDir(dir: string): Promise<Project> {
  const encoded = basename(dir);
  const files = await jsonlFiles(dir);
  let cwd: string | undefined;
  // A session can change directory mid-run; its first cwd is where it started, which is what
  // names the directory. Prefer a cwd whose encoding matches the directory name.
  let fallback: string | undefined;
  for (const f of files.slice(0, 8)) {
    const c = await firstCwd(join(dir, f));
    if (!c) continue;
    if (encodeCwd(c) === encoded) {
      cwd = c;
      break;
    }
    fallback ??= c;
  }
  cwd ??= fallback;
  return {
    dir,
    encoded,
    cwd: cwd ?? decodeDirName(encoded),
    cwdFromEntry: cwd !== undefined,
    sessions: files.length,
  };
}

export async function* listProjects(root: string): AsyncGenerator<Project> {
  let names: string[];
  try {
    names = (await readdir(root, { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort();
  } catch {
    return;
  }
  for (const name of names) yield await projectForDir(join(root, name));
}

export function sessionForPath(path: string, project?: Project): Session {
  const file = basename(path).replace(/\.jsonl$/, "");
  const parentDir = dirname(path);
  if (basename(parentDir) === "subagents") {
    const id = file.replace(/^agent-/, "");
    const sidecar = dirname(parentDir);
    const s: Session = {
      id,
      short: id.slice(0, 8),
      kind: "subagent",
      parent: basename(sidecar),
      path,
      sidecar,
      adapter: ADAPTER_ID,
    };
    if (project) s.project = project;
    return s;
  }
  const s: Session = {
    id: file,
    short: file.slice(0, 8),
    kind: "main",
    path,
    sidecar: join(parentDir, file),
    adapter: ADAPTER_ID,
  };
  if (project) s.project = project;
  return s;
}

export async function* listSessions(project: Project, opts: { subagents?: boolean } = {}): AsyncGenerator<Session> {
  const files = await jsonlFiles(project.dir);
  for (const f of files) {
    const main = sessionForPath(join(project.dir, f), project);
    yield main;
    if (!opts.subagents) continue;
    const subDir = join(main.sidecar, "subagents");
    if (!(await isDir(subDir))) continue;
    for (const sf of await jsonlFiles(subDir)) {
      if (sf.startsWith("agent-")) yield sessionForPath(join(subDir, sf), project);
    }
  }
}
