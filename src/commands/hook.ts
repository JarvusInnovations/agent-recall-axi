/**
 * `hook install|status|uninstall` (specs/cli.md#hook): explicit opt-in registration of the
 * SessionStart hook that runs the home view, the one command that writes outside the cache
 * (specs/behaviors/privacy.md). The settings merges are this tool's own (hook-settings.ts); the
 * SDK supplies the OpenCode plugin source and PATH-portable command resolution
 * (specs/architecture.md#session-hook).
 */
import { mkdtempSync, realpathSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join, resolve } from "node:path";
import { AxiError, installSessionStartHooks, resolvePortableHookCommand } from "axi-sdk-js";
import { findCommand, HOOK_AGENTS, HOOK_FLAGS, HOOK_SCOPES } from "../reference.js";
import { getString, parseFlags, usageLine } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { renderDocument } from "../output/render.js";
import { bundleShim, NAME } from "../invocation.js";
import { BIN, type Io } from "./common.js";
import {
  atomicWrite,
  codexHooksEnabled,
  OUR_FILES,
  ourCommands,
  readHooksJson,
  readText,
  serializeJson,
  SettingsError,
  shellQuote,
  TIMEOUT_SECONDS,
  withCodexHooksFeature,
  withOurEntry,
  withoutOurEntries,
} from "./hook-settings.js";

export const MARKER = NAME;
export const DISABLE_ENV = "AGENT_SESSION_AXI_DISABLE_HOOKS";
const OPENCODE_FILE = "axi-agent-session-axi.js";
/** The first line of the SDK's managed plugin for this marker: the only plugin file that is ours. */
const OPENCODE_MANAGED = `// axi-sdk-js managed opencode plugin: ${MARKER}`;
const COMMAND_LINE = /^const command = (".*");$/m;

type Scope = (typeof HOOK_SCOPES)[number];
type Agent = (typeof HOOK_AGENTS)[number];

export interface HookIo extends Io {
  /** The running entrypoint (default process.argv[1]): what the hook will run. */
  entrypoint?: string;
}

interface Targets {
  claude: string;
  codex: string;
  /** The user's Codex config: the only place Codex reads its hooks feature flag. */
  codexConfig: string;
  opencode: string;
}

/** The files each scope writes (cli.md#hook); user scope honours the agents' config-dir variables. */
export function hookTargets(scope: Scope, env: Record<string, string | undefined>, home: string, projectDir: string): Targets {
  const codexHome = env.CODEX_HOME || join(home, ".codex");
  const codexConfig = join(codexHome, "config.toml");
  if (scope === "project") {
    const root = resolve(projectDir);
    return {
      claude: join(root, ".claude", "settings.json"),
      codex: join(root, ".codex", "hooks.json"),
      codexConfig,
      opencode: join(root, ".opencode", "plugins", OPENCODE_FILE),
    };
  }
  return {
    claude: join(env.CLAUDE_CONFIG_DIR || join(home, ".claude"), "settings.json"),
    codex: join(codexHome, "hooks.json"),
    codexConfig,
    opencode: join(env.XDG_CONFIG_HOME || join(home, ".config"), "opencode", "plugins", OPENCODE_FILE),
  };
}

function installFromBuildHints(): string[] {
  return [
    `Run \`bun run build && node dist/bin/${NAME}.js hook install\` to install the built bin`,
    `Run \`skills/${NAME}/scripts/${NAME} hook install\` to install the skill shim`,
  ];
}

/** The executable the hook runs: the skill shim (or bundle), else the npm bin; one of the forms install writes. */
export function hookExecPath(entrypoint: string | undefined): string {
  if (!entrypoint) throw new AxiError("cannot tell which binary is running", "VALIDATION_ERROR", installFromBuildHints());
  const b = bundleShim(entrypoint);
  if (b) return b.shim ?? b.bundle;
  if (/\.[cm]?ts$/.test(entrypoint)) {
    throw new AxiError(`a hook cannot run the TypeScript source (${entrypoint})`, "VALIDATION_ERROR", installFromBuildHints());
  }
  const path = resolve(entrypoint);
  // Only these names are recognised as ours later (status, path repair, uninstall).
  if (!OUR_FILES.has(basename(path))) {
    throw new AxiError(`the running binary (${path}) is not one ${NAME} installs as a hook (${[...OUR_FILES].join(", ")})`, "VALIDATION_ERROR", installFromBuildHints());
  }
  return path;
}

function realFile(path: string): string | undefined {
  try {
    return statSync(path).isFile() ? realpathSync(path) : undefined;
  } catch {
    return undefined;
  }
}

/** The command, unquoted: the bare name when it is on PATH and resolves to execPath, else the path. */
export function hookCommandString(execPath: string, pathVar: string | undefined): string {
  return resolvePortableHookCommand(execPath, [NAME], MARKER, {
    pathEntries: (pathVar ?? "").split(delimiter).filter(Boolean),
    pathExtensions: [""],
    resolveRealPath: realFile,
  });
}

function collapseUnder(path: string, home: string): string {
  return path === home ? "~" : path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

function readOrUndefined(path: string): string | undefined {
  try {
    return readText(path);
  } catch {
    return undefined;
  }
}

// ── OpenCode plugin ───────────────────────────────────────────────────────────────────────────

function isOurPlugin(text: string | undefined): boolean {
  return text !== undefined && text.split(/\r?\n/, 1)[0] === OPENCODE_MANAGED;
}

function pluginCommand(text: string | undefined): string | undefined {
  if (!isOurPlugin(text)) return undefined;
  const m = COMMAND_LINE.exec(text!);
  try {
    return m ? (JSON.parse(m[1]!) as string) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The SDK's plugin source, its command set to `raw` (spawned without a shell, so unquoted). The
 * SDK writes it only alongside its other targets, so it is generated into a throwaway home.
 */
function pluginSource(execPath: string, raw: string): string {
  const scratch = mkdtempSync(join(tmpdir(), `${NAME}-hook-`));
  try {
    installSessionStartHooks({ marker: MARKER, execPath, binaryNames: [], shouldInstall: () => true, timeoutSeconds: TIMEOUT_SECONDS, homeDir: scratch, scope: "user" });
    const text = readText(join(scratch, ".config", "opencode", "plugins", OPENCODE_FILE));
    if (text === undefined || !isOurPlugin(text)) throw new SettingsError("the plugin source could not be generated");
    if ((text.match(new RegExp(COMMAND_LINE.source, "gm")) ?? []).length !== 1) throw new SettingsError("the generated plugin has no single command line");
    return text.replace(COMMAND_LINE, () => `const command = ${JSON.stringify(raw)};`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── the subcommands ───────────────────────────────────────────────────────────────────────────

interface Row {
  agent: Agent;
  path: string;
  state: string;
}

interface Ctx {
  scope: Scope;
  targets: Targets;
  scopeFlag: string;
  show: (path: string) => string;
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

export async function hookCommand(args: string[], io: HookIo): Promise<string> {
  const doc = findCommand("hook");
  const sub = args[0];
  if (sub === undefined) throw new AxiError("hook needs a subcommand: install, status or uninstall", "USAGE", [usageLine("hook")]);
  if (sub === "--help" || sub === "-h") return renderCommandHelp("hook") ?? "";
  if (!(SUBCOMMANDS as readonly string[]).includes(sub)) throw new AxiError(`unknown hook subcommand ${sub}`, "USAGE", [usageLine("hook")]);
  // Per-subcommand flag sets: --agent belongs to install alone.
  const specs = (doc?.flags ?? HOOK_FLAGS).filter((f) => sub === "install" || f.name !== "agent");
  const p = parseFlags(`hook ${sub}`, args.slice(1), specs);
  if (p.help) return renderCommandHelp("hook") ?? "";
  if (p.positionals.length) throw new AxiError(`hook ${sub} takes no arguments (got ${p.positionals[0]})`, "USAGE", [usageLine("hook")]);
  const scope = parseScope(p);
  const agent = sub === "install" ? parseAgent(p) : undefined;
  const home = io.env.HOME || homedir();
  const ctx: Ctx = {
    scope,
    targets: hookTargets(scope, io.env, home, io.cwd),
    scopeFlag: getString(p, "scope") !== undefined ? ` --scope ${scope}` : "",
    show: (path) => collapseUnder(path, home),
  };
  if (sub === "status") return status(ctx, io);
  if (sub === "uninstall") return uninstall(ctx);
  return install(ctx, agent, io);
}

function rowsFor(targets: Targets): Array<{ agent: Agent; path: string }> {
  return [
    { agent: "claude", path: targets.claude },
    { agent: "codex", path: targets.codex },
    { agent: "opencode", path: targets.opencode },
  ];
}

/** The Codex feature flag line: on, or what is left for the user to set. */
function codexFeatures(ctx: Ctx): string {
  const path = ctx.show(ctx.targets.codexConfig);
  if (codexHooksEnabled(readOrUndefined(ctx.targets.codexConfig))) return `${path} (hooks = true)`;
  return ctx.scope === "project"
    ? `not set (needs [features] hooks = true in ${path}; run hook install --scope user or set it yourself)`
    : `${path} (not set)`;
}

function finish(body: Record<string, unknown>, help: string[], failed: boolean): string {
  if (failed) process.exitCode = 1;
  return renderDocument(body, help);
}

/**
 * One hooks JSON target brought to our entry; its row state. Nothing is written when the file
 * fails its checks; `before` runs just ahead of this file's write (the Codex feature flag).
 */
function installJson(path: string, command: string, before?: () => void): string {
  const file = readHooksJson(path);
  const had = ourCommands(file.doc).length > 0;
  const { doc, changed } = withOurEntry(file.doc, command);
  before?.();
  if (!changed) return "unchanged";
  atomicWrite(path, serializeJson(file, doc));
  if (!ourCommands(readHooksJson(path).doc).includes(command)) throw new SettingsError("the hook was not in the file after writing");
  return had ? "updated" : "added";
}

function install(ctx: Ctx, agent: Agent | undefined, io: HookIo): string {
  if (io.env[DISABLE_ENV] === "1") return renderDocument({ hook: `disabled by ${DISABLE_ENV}=1 (no changes)` });
  const execPath = hookExecPath(io.entrypoint ?? process.argv[1]);
  const raw = hookCommandString(execPath, io.env.PATH ?? process.env.PATH);
  // Claude Code and Codex run the command through a shell; the OpenCode plugin takes it raw.
  const command = shellQuote(raw);
  const chosen = rowsFor(ctx.targets).filter((r) => agent === undefined || r.agent === agent);
  let failed = false;
  const rows: Row[] = chosen.map(({ agent: a, path }) => {
    const row = (state: string): Row => ({ agent: a, path: ctx.show(path), state });
    try {
      if (a === "claude" || (a === "codex" && ctx.scope === "project")) return row(installJson(path, command));
      if (a === "codex") {
        // Both Codex files pass their checks before either is written.
        const cfg = withCodexHooksFeature(readText(ctx.targets.codexConfig) ?? "");
        readHooksJson(path);
        const state = installJson(path, command, () => {
          if (!cfg.changed) return;
          atomicWrite(ctx.targets.codexConfig, cfg.text);
          if (!codexHooksEnabled(readText(ctx.targets.codexConfig))) throw new SettingsError("the feature flag was not set after writing");
        });
        return row(state === "unchanged" && cfg.changed ? "updated" : state);
      }
      const current = readText(path);
      if (current !== undefined && !isOurPlugin(current)) return row("unmanaged (left in place)");
      const next = pluginSource(execPath, raw);
      if (current === next) return row("unchanged");
      atomicWrite(path, next);
      if (pluginCommand(readText(path)) !== raw) throw new SettingsError("the plugin was not in place after writing");
      return row(current === undefined ? "added" : "updated");
    } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      failed = true;
      return row(`error: ${err.message}`);
    }
  });
  const changed = rows.some((r) => r.state === "added" || r.state === "updated");
  // A row that errored means the hook is not where it was asked to be: never headline success.
  const headline = failed
    ? changed
      ? `partly installed (${ctx.scope} scope; see errors)`
      : `not installed (${ctx.scope} scope; see errors)`
    : changed
      ? `installed (${ctx.scope} scope)`
      : `already installed (${ctx.scope} scope; no changes)`;
  const body: Record<string, unknown> = {
    hook: headline,
    command,
    targets: rows,
  };
  if (chosen.some((r) => r.agent === "codex")) body.codex_features = codexFeatures(ctx);
  return finish(body, [`Run \`${BIN} hook status${ctx.scopeFlag}\` to check it`, `Run \`${BIN} hook uninstall${ctx.scopeFlag}\` to remove it`], failed);
}

function status(ctx: Ctx, io: HookIo): string {
  let expected: string | undefined;
  try {
    expected = hookCommandString(hookExecPath(io.entrypoint ?? process.argv[1]), io.env.PATH ?? process.env.PATH);
  } catch {
    expected = undefined; // a source checkout: nothing to compare against
  }
  const seen = new Set<string>();
  let failed = false;
  const rows: Row[] = rowsFor(ctx.targets).map(({ agent, path }) => {
    const row = (state: string): Row => ({ agent, path: ctx.show(path), state });
    try {
      if (agent === "opencode") {
        const cmd = pluginCommand(readText(path));
        if (cmd === undefined) return row("absent");
        seen.add(shellQuote(cmd));
        return row(expected !== undefined && cmd !== expected ? "stale" : "installed");
      }
      const cmds = ourCommands(readHooksJson(path).doc);
      if (!cmds.length) return row("absent");
      for (const c of cmds) seen.add(c);
      const stale = expected !== undefined && (cmds.length > 1 || cmds[0] !== shellQuote(expected));
      return row(stale ? "stale" : "installed");
    } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      failed = true;
      return row(`error: ${err.message}`);
    }
  });
  const present = rows.filter((r) => r.state === "installed" || r.state === "stale").length;
  const word = present === 0 ? "not installed" : rows.some((r) => r.state === "stale") ? "stale" : present < rows.length ? "partly installed" : "installed";
  const body: Record<string, unknown> = { hook: `${word} (${ctx.scope} scope)` };
  if (seen.size === 1) body.command = [...seen][0];
  else if (seen.size > 1) body.commands = [...seen];
  body.targets = rows;
  body.codex_features = codexFeatures(ctx);
  const help = rows.every((r) => r.state === "installed")
    ? [`Run \`${BIN} hook uninstall${ctx.scopeFlag}\` to remove it`]
    : [`Run \`${BIN} hook install${ctx.scopeFlag}\` to ${present === 0 ? "install" : "repair"} it`];
  return finish(body, help, failed);
}

function uninstall(ctx: Ctx): string {
  let failed = false;
  const rows: Row[] = rowsFor(ctx.targets).map(({ agent, path }) => {
    const row = (state: string): Row => ({ agent, path: ctx.show(path), state });
    try {
      if (agent === "opencode") {
        const text = readText(path);
        if (text === undefined) return row("absent");
        if (!isOurPlugin(text)) return row("unmanaged (left in place)");
        try {
          rmSync(path);
        } catch (err) {
          throw new SettingsError(`cannot remove: ${(err as Error).message}`);
        }
        return row("removed");
      }
      const file = readHooksJson(path);
      const { doc, changed } = withoutOurEntries(file.doc);
      if (!changed) return row("absent");
      atomicWrite(path, serializeJson(file, doc));
      if (ourCommands(readHooksJson(path).doc).length) throw new SettingsError("the hook was still in the file after writing");
      return row("removed");
    } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      failed = true;
      return row(`error: ${err.message}`);
    }
  });
  const removed = rows.some((r) => r.state === "removed");
  const headline = failed
    ? `${removed ? "partly removed" : "not removed"} (${ctx.scope} scope; see errors)`
    : removed
      ? `removed (${ctx.scope} scope)`
      : `nothing to remove (${ctx.scope} scope)`;
  return finish({ hook: headline, targets: rows }, [
    `Run \`${BIN} hook status${ctx.scopeFlag}\` to confirm`,
    `Run \`${BIN} hook install${ctx.scopeFlag}\` to add it back`,
  ], failed);
}
