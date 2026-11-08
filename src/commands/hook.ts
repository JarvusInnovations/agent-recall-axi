/**
 * `hook install|status|uninstall` (specs/cli.md#hook): explicit opt-in registration of the
 * SessionStart hook that runs the home view. The only code in this tool that writes outside its
 * own cache. Built on the SDK's helpers with marker `agent-session-axi`: a full install is the
 * SDK's `installSessionStartHooks`; `--agent` installs one target through the primitives that
 * helper is built on (architecture.md#session-hook).
 */
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import {
  computeCodexConfigUpdate,
  computeSessionStartHookUpdate,
  installSessionStartHooks,
  resolvePortableHookCommand,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
  type HookSettings,
} from "axi-sdk-js";
import { AxiError } from "axi-sdk-js";
import { findCommand, HOOK_AGENTS, HOOK_FLAGS, HOOK_SCOPES } from "../reference.js";
import { getString, parseFlags, usageLine } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { renderDocument } from "../output/render.js";
import { bundleShim, NAME } from "../invocation.js";
import { BIN, type Io } from "./common.js";

export const MARKER = NAME;
export const DISABLE_ENV = "AGENT_SESSION_AXI_DISABLE_HOOKS";
const TIMEOUT_SECONDS = 10;
const OPENCODE_FILE = "axi-agent-session-axi.js";
const OPENCODE_MANAGED = `axi-sdk-js managed opencode plugin: ${MARKER}`;

type Scope = (typeof HOOK_SCOPES)[number];
type Agent = (typeof HOOK_AGENTS)[number];

export interface HookIo extends Io {
  /** The running entrypoint (default process.argv[1]): what the hook will run. */
  entrypoint?: string;
}

interface Targets {
  claude: string;
  codex: string;
  codexConfig: string;
  opencode: string;
}

/** The files each scope writes (the SDK's own layout, cli.md#hook). */
export function hookTargets(scope: Scope, home: string, projectDir: string): Targets {
  const root = scope === "project" ? resolve(projectDir) : home;
  return {
    claude: join(root, ".claude", "settings.json"),
    codex: join(root, ".codex", "hooks.json"),
    codexConfig: join(home, ".codex", "config.toml"),
    opencode: scope === "project" ? join(root, ".opencode", "plugins", OPENCODE_FILE) : join(home, ".config", "opencode", "plugins", OPENCODE_FILE),
  };
}

/** The executable the hook runs: the skill shim, else the npm bin. A `.ts` source entry cannot run as a hook. */
export function hookExecPath(entrypoint: string | undefined): string {
  if (!entrypoint) throw new AxiError("cannot tell which binary is running", "VALIDATION_ERROR", installFromBuildHints());
  const b = bundleShim(entrypoint);
  if (b) return b.shim ?? b.bundle;
  if (/\.[cm]?ts$/.test(entrypoint)) {
    throw new AxiError(`a hook cannot run the TypeScript source (${entrypoint})`, "VALIDATION_ERROR", installFromBuildHints());
  }
  const path = resolve(entrypoint);
  // The marker is how every later install, status and uninstall finds this entry again.
  if (!path.includes(NAME)) {
    throw new AxiError(`the running binary's path does not name ${NAME} (${path}), so its hook could not be found again`, "VALIDATION_ERROR", installFromBuildHints());
  }
  return path;
}

function installFromBuildHints(): string[] {
  return [
    `Run \`bun run build && node dist/bin/${NAME}.js hook install\` to install the built bin`,
    `Run \`skills/${NAME}/scripts/${NAME} hook install\` to install the skill shim`,
  ];
}

function realFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/** The command string `install` writes: the bare name when it is on PATH and resolves to execPath. */
export function hookCommandString(execPath: string, pathVar: string | undefined): string {
  return resolvePortableHookCommand(execPath, [NAME], MARKER, {
    pathEntries: (pathVar ?? "").split(delimiter).filter(Boolean),
    pathExtensions: [""],
    resolveRealPath: realFile,
  });
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The command of this tool's entry in a Claude Code / Codex hooks file, if any. */
function jsonHookCommand(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  try {
    const settings = JSON.parse(text) as HookSettings;
    for (const group of settings.hooks?.SessionStart ?? []) {
      for (const h of group.hooks ?? []) if (typeof h.command === "string" && h.command.includes(MARKER)) return h.command;
    }
    for (const h of settings.hooks?.session_start ?? []) if (typeof h.command === "string" && h.command.includes(MARKER)) return h.command;
  } catch {
    return undefined;
  }
  return undefined;
}

function pluginCommand(text: string | undefined): string | undefined {
  if (text === undefined || !text.includes(OPENCODE_MANAGED)) return undefined;
  const m = /^const command = (".*");$/m.exec(text);
  try {
    return m ? (JSON.parse(m[1]!) as string) : undefined;
  } catch {
    return undefined;
  }
}

function installedCommand(agent: Agent, text: string | undefined): string | undefined {
  return agent === "opencode" ? pluginCommand(text) : jsonHookCommand(text);
}

/** This tool's entry (or managed plugin) is present in the file's text. */
function hasManaged(agent: Agent, text: string | undefined): boolean {
  return agent === "opencode" ? text?.includes(OPENCODE_MANAGED) === true : jsonHookCommand(text) !== undefined;
}

function collapseUnder(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function writeJson(path: string, settings: HookSettings): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8");
}

/** One JSON hooks file brought to the managed entry (the SDK's own merge). */
function installJson(path: string, command: string, errors: Map<string, string>): void {
  try {
    const text = read(path);
    const current = text === undefined ? {} : (JSON.parse(text) as HookSettings);
    const [updated, changed] = computeSessionStartHookUpdate(current, { marker: MARKER, command, timeoutSeconds: TIMEOUT_SECONDS });
    if (changed) writeJson(path, updated);
  } catch (err) {
    errors.set(path, err instanceof Error ? err.message : String(err));
  }
}

function installCodexFeature(path: string, errors: Map<string, string>): void {
  try {
    const [updated, changed] = computeCodexConfigUpdate(read(path) ?? "");
    if (changed) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, updated, "utf8");
    }
  } catch (err) {
    errors.set(path, err instanceof Error ? err.message : String(err));
  }
}

/**
 * The OpenCode plugin alone. The SDK writes its plugin source only together with the other two
 * targets, so it is generated into a throwaway home and copied, never rewritten by hand: the bytes
 * are the SDK's.
 */
function installOpenCode(path: string, execPath: string, errors: Map<string, string>): void {
  const scratch = mkdtempSync(join(tmpdir(), `${NAME}-hook-`));
  try {
    installSessionStartHooks({
      marker: MARKER,
      execPath,
      binaryNames: [NAME],
      shouldInstall: () => true,
      timeoutSeconds: TIMEOUT_SECONDS,
      homeDir: scratch,
      scope: "user",
    });
    const next = read(join(scratch, ".config", "opencode", "plugins", OPENCODE_FILE));
    if (next === undefined) throw new Error("the plugin source could not be generated");
    const current = read(path);
    if (current !== undefined && !current.includes(OPENCODE_MANAGED)) {
      errors.set(path, "refusing to overwrite unmanaged OpenCode plugin");
      return;
    }
    if (current !== next) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, next, "utf8");
    }
  } catch (err) {
    errors.set(path, err instanceof Error ? err.message : String(err));
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

/** `<path>: <message>` from the SDK's onError, keyed by the path. */
function collect(errors: Map<string, string>, paths: string[]): (message: string) => void {
  return (message) => {
    const path = paths.find((p) => message.startsWith(`${p}: `));
    if (path) errors.set(path, message.slice(path.length + 2));
    else errors.set("", message);
  };
}

function isUnmanaged(message: string | undefined): boolean {
  return message !== undefined && /unmanaged OpenCode plugin/.test(message);
}

interface Row {
  agent: Agent;
  path: string;
  state: string;
}

function parseScope(p: ReturnType<typeof parseFlags>): Scope {
  const v = getString(p, "scope");
  if (v === undefined) return "user";
  if ((HOOK_SCOPES as readonly string[]).includes(v)) return v as Scope;
  throw new AxiError(`--scope ${v} is not a scope`, "VALIDATION_ERROR", [`--scope takes ${HOOK_SCOPES.join(" or ")}`]);
}

function parseAgent(p: ReturnType<typeof parseFlags>): Agent | undefined {
  const v = getString(p, "agent");
  if (v === undefined) return undefined;
  if ((HOOK_AGENTS as readonly string[]).includes(v)) return v as Agent;
  throw new AxiError(`--agent ${v} is not an agent`, "VALIDATION_ERROR", [`--agent takes one of ${HOOK_AGENTS.join(", ")}`]);
}

const SUBCOMMANDS = ["install", "status", "uninstall"] as const;
type Sub = (typeof SUBCOMMANDS)[number];

export async function hookCommand(args: string[], io: HookIo): Promise<string> {
  const doc = findCommand("hook");
  const sub = args[0];
  if (sub === undefined || sub === "--help" || sub === "-h") {
    if (sub === undefined) throw new AxiError("hook needs a subcommand: install, status or uninstall", "USAGE", [usageLine("hook")]);
    return renderCommandHelp("hook") ?? "";
  }
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) {
    throw new AxiError(`unknown hook subcommand ${sub}`, "USAGE", [usageLine("hook")]);
  }
  // Per-subcommand flag sets: --agent belongs to install alone.
  const specs = (doc?.flags ?? HOOK_FLAGS).filter((f) => sub === "install" || f.name !== "agent");
  const p = parseFlags(`hook ${sub}`, args.slice(1), specs);
  if (p.help) return renderCommandHelp("hook") ?? "";
  if (p.positionals.length) throw new AxiError(`hook ${sub} takes no arguments (got ${p.positionals[0]})`, "USAGE", [usageLine("hook")]);
  const scope = parseScope(p);
  const agent = sub === "install" ? parseAgent(p) : undefined;
  const home = io.env.HOME || homedir();
  const targets = hookTargets(scope, home, io.cwd);
  const scopeFlag = getString(p, "scope") !== undefined ? ` --scope ${scope}` : "";
  const show = (path: string) => collapseUnder(path, home);
  if (sub === "status") return status(scope, home, io, targets, scopeFlag, show);
  if (sub === "uninstall") return uninstall(scope, home, io, targets, show);
  return install(scope, agent, home, io, targets, scopeFlag, show);
}

function rowsFor(targets: Targets): Array<{ agent: Agent; path: string }> {
  return [
    { agent: "claude", path: targets.claude },
    { agent: "codex", path: targets.codex },
    { agent: "opencode", path: targets.opencode },
  ];
}

function finish(body: Record<string, unknown>, help: string[], failed: boolean): string {
  if (failed) process.exitCode = 1;
  return renderDocument(body, help);
}

function install(scope: Scope, agent: Agent | undefined, home: string, io: HookIo, targets: Targets, scopeFlag: string, show: (p: string) => string): string {
  if (io.env[DISABLE_ENV] === "1") {
    return renderDocument({ hook: `disabled by ${DISABLE_ENV}=1 (no changes)` });
  }
  const execPath = hookExecPath(io.entrypoint ?? process.argv[1]);
  const command = hookCommandString(execPath, io.env.PATH ?? process.env.PATH);
  const chosen = rowsFor(targets).filter((r) => agent === undefined || r.agent === agent);
  const watched = [...chosen.map((r) => r.path), ...(chosen.some((r) => r.agent === "codex") ? [targets.codexConfig] : [])];
  const before = new Map(watched.map((p) => [p, read(p)]));
  const errors = new Map<string, string>();
  if (agent === undefined) {
    installSessionStartHooks({
      marker: MARKER,
      execPath,
      binaryNames: [NAME],
      shouldInstall: () => true,
      timeoutSeconds: TIMEOUT_SECONDS,
      homeDir: home,
      scope,
      projectDir: io.cwd,
      onError: collect(errors, watched),
    });
  } else if (agent === "claude") installJson(targets.claude, command, errors);
  else if (agent === "codex") {
    installJson(targets.codex, command, errors);
    installCodexFeature(targets.codexConfig, errors);
  } else installOpenCode(targets.opencode, execPath, errors);

  const rows: Row[] = chosen.map(({ agent: a, path }) => {
    const err = errors.get(path);
    if (isUnmanaged(err)) return { agent: a, path: show(path), state: "unmanaged (left in place)" };
    if (err !== undefined) return { agent: a, path: show(path), state: `error: ${err}` };
    const was = before.get(path);
    const now = read(path);
    const state = was === now ? "unchanged" : hasManaged(a, was) ? "updated" : "added";
    return { agent: a, path: show(path), state };
  });
  const body: Record<string, unknown> = {};
  const changed = rows.some((r) => r.state === "added" || r.state === "updated") || watched.some((p) => before.get(p) !== read(p));
  body.hook = changed ? `installed (${scope} scope)` : `already installed (${scope} scope, no changes)`;
  body.command = command;
  body.targets = rows;
  if (chosen.some((r) => r.agent === "codex")) {
    const err = errors.get(targets.codexConfig);
    body.codex_features = `${show(targets.codexConfig)} (${err === undefined ? "hooks = true" : `error: ${err}`})`;
  }
  const other = errors.get("");
  if (other !== undefined) body.error = other;
  const failed = errors.size > [...errors.values()].filter(isUnmanaged).length;
  return finish(body, [`Run \`${BIN} hook status${scopeFlag}\` to check it`, `Run \`${BIN} hook uninstall${scopeFlag}\` to remove it`], failed);
}

function status(scope: Scope, home: string, io: HookIo, targets: Targets, scopeFlag: string, show: (p: string) => string): string {
  const st = sessionStartHookStatus({ marker: MARKER, homeDir: home, scope, projectDir: io.cwd });
  let expected: string | undefined;
  try {
    expected = hookCommandString(hookExecPath(io.entrypoint ?? process.argv[1]), io.env.PATH ?? process.env.PATH);
  } catch {
    expected = undefined; // a source checkout: nothing to compare against
  }
  const installed = { claude: st.claude.installed, codex: st.codex.installed, opencode: st.opencode.installed };
  const rows: Row[] = rowsFor(targets).map(({ agent, path }) => {
    if (!installed[agent]) return { agent, path: show(path), state: "absent" };
    const cmd = installedCommand(agent, read(path));
    return { agent, path: show(path), state: expected !== undefined && cmd !== undefined && cmd !== expected ? "stale" : "installed" };
  });
  const n = rows.filter((r) => r.state !== "absent").length;
  const stale = rows.some((r) => r.state === "stale");
  const word = n === 0 ? "not installed" : stale ? "stale" : n < rows.length ? "partly installed" : "installed";
  const body: Record<string, unknown> = { hook: `${word} (${scope} scope)` };
  const commands = [
    ...new Set(
      rowsFor(targets)
        .filter(({ agent }) => installed[agent])
        .map(({ agent, path }) => installedCommand(agent, read(path)))
        .filter((c): c is string => c !== undefined),
    ),
  ];
  if (commands.length === 1) body.command = commands[0];
  else if (commands.length > 1) body.commands = commands;
  body.targets = rows;
  body.codex_features = `${show(st.codex.userFeaturePath)} (${st.codex.userFeatureEnabled ? "hooks = true" : "not set"})`;
  const help = rows.every((r) => r.state === "installed")
    ? [`Run \`${BIN} hook uninstall${scopeFlag}\` to remove it`]
    : [`Run \`${BIN} hook install${scopeFlag}\` to ${n === 0 ? "install" : "repair"} it`];
  return renderDocument(body, help);
}

function uninstall(scope: Scope, home: string, io: HookIo, targets: Targets, show: (p: string) => string): string {
  const all = rowsFor(targets);
  const before = new Map(all.map((r) => [r.path, hasManaged(r.agent, read(r.path))]));
  const errors = new Map<string, string>();
  uninstallSessionStartHooks({ marker: MARKER, homeDir: home, scope, projectDir: io.cwd, onError: collect(errors, all.map((r) => r.path)) });
  const rows: Row[] = all.map(({ agent, path }) => {
    const err = errors.get(path);
    if (isUnmanaged(err)) return { agent, path: show(path), state: "unmanaged (left in place)" };
    if (err !== undefined) return { agent, path: show(path), state: `error: ${err}` };
    return { agent, path: show(path), state: before.get(path) && !hasManaged(agent, read(path)) ? "removed" : "absent" };
  });
  const removed = rows.some((r) => r.state === "removed");
  const body: Record<string, unknown> = { hook: removed ? `removed (${scope} scope)` : `nothing to remove (${scope} scope)`, targets: rows };
  const other = errors.get("");
  if (other !== undefined) body.error = other;
  const failed = errors.size > [...errors.values()].filter(isUnmanaged).length;
  return finish(body, [], failed);
}
