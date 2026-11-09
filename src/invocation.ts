/**
 * How hints name this tool (specs/cli.md#conventions). The npm bin is on PATH by installation,
 * so hints say `agent-session-axi`. The skill bundle is not: run from it, hints name the shim by
 * its path, unless `agent-session-axi` on PATH resolves to that shim or bundle. Leaf module: node
 * builtins only, evaluated once per process.
 */
import { accessSync, constants, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";

export const NAME = "agent-session-axi";
export const BUNDLE_FILE = `${NAME}.mjs`;

function real(path: string): string | undefined {
  try {
    if (!statSync(path).isFile()) return undefined;
    return realpathSync(path);
  } catch {
    return undefined;
  }
}

/** The entrypoint is the committed skill bundle: its sibling shim, when that is executable. */
export function bundleShim(entrypoint: string | undefined): { bundle: string; shim?: string } | undefined {
  if (!entrypoint || basename(entrypoint) !== BUNDLE_FILE) return undefined;
  const bundle = real(entrypoint) ?? entrypoint;
  const shim = join(dirname(bundle), NAME);
  try {
    accessSync(shim, constants.X_OK);
    return { bundle, shim };
  } catch {
    return { bundle };
  }
}

/** The PATH entry named `agent-session-axi` that resolves to one of `targets`, if any. */
export function onPath(targets: string[], pathVar: string | undefined): boolean {
  const want = new Set(targets.map((t) => real(t) ?? t));
  for (const dir of (pathVar ?? "").split(delimiter)) {
    if (!dir) continue;
    const r = real(join(dir, NAME));
    if (r && want.has(r)) return true;
  }
  return false;
}

/** A word as a shell would need it: unquoted when safe, else single-quoted. */
export function shellWord(text: string): string {
  return /^[\w@%+=:,./-]+$/.test(text) ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

/**
 * A path as a hint prints it: `~/` for the home directory, kept outside any quotes so the shell
 * still expands it (`~/'my skills/…'`), and only the rest quoted when it needs it.
 */
export function pathWord(path: string): string {
  const home = homedir();
  if (path === home) return "~";
  if (path.startsWith(`${home}/`)) return `~/${shellWord(path.slice(home.length + 1))}`;
  return shellWord(path);
}

/** The command prefix hints print, for a process started from `entrypoint`. */
export function cliInvocation(entrypoint: string | undefined = process.argv[1], pathVar: string | undefined = process.env.PATH): string {
  const b = bundleShim(entrypoint);
  if (!b) return NAME;
  const targets = b.shim ? [b.shim, b.bundle] : [b.bundle];
  if (onPath(targets, pathVar)) return NAME;
  return b.shim ? pathWord(b.shim) : `node ${pathWord(b.bundle)}`;
}

/** The tool as every hint in this process names it. */
export const BIN = cliInvocation();
