/**
 * `setup hooks` and its `status` and `uninstall` actions (specs/cli.md#setup-hooks), and the
 * retired `hook` redirect: explicit opt-in registration of the
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
import { BIN, shellArg, type Io } from "./common.js";
import {
  atomicWrite,
  codexHooksEnabled,
  featuresState,
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
export const DISABLE_ENV = "AGENT_RECALL_AXI_DISABLE_HOOKS";
const OPENCODE_FILE = "axi-agent-recall-axi.js";
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

/** The files each scope writes (cli.md#setup-hooks); user scope honours the agents' config-dir variables. */
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
    `Run \`bun run build && node dist/bin/${NAME}.js setup hooks\` to install the built bin`,
    `Run \`skills/${NAME}/scripts/${NAME} setup hooks\` to install the skill shim`,
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

// ── the actions ───────────────────────────────────────────────────────────────────────────────

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

/** The words that may follow `setup hooks`; none of them is the install. */
const ACTIONS = ["status", "uninstall"] as const;
type Action = "install" | (typeof ACTIONS)[number];

function isAction(word: string): word is (typeof ACTIONS)[number] {
  return (ACTIONS as readonly string[]).includes(word);
}

function carry(args: string[]): string {
  return args.map((a) => ` ${shellArg(a)}`).join("");
}

/**
 * The pre-rename `hook install|status|uninstall`: one corrected call with the caller's own
 * arguments, never an alias (cli.md#setup-hooks). Reads and writes nothing.
 */
export function retiredHookCommand(args: string[]): never {
  const [sub, ...rest] = args;
  const hints =
    sub === "install"
      ? [`Run \`${BIN} setup hooks${carry(rest)}\` to install or repair the hook`]
      : sub === "status"
        ? [`Run \`${BIN} setup hooks status${carry(rest)}\` to see where the hook is installed`]
        : sub === "uninstall"
          ? [`Run \`${BIN} setup hooks uninstall${carry(rest)}\` to remove the hook`]
          : [`Run \`${BIN} setup hooks --help\` for the hook commands`];
  throw new AxiError("hook is now `setup hooks`", "VALIDATION_ERROR", [...hints, usageLine("setup")]);
}

/** `setup hooks [status|uninstall]`: the action word comes first, then that action's flags. */
export async function setupCommand(args: string[], io: HookIo): Promise<string> {
  const doc = findCommand("setup");
  const word = args[0];
  if (word === undefined) throw new AxiError("setup needs an action: hooks", "USAGE", [usageLine("setup")]);
  if (word === "--help" || word === "-h") return renderCommandHelp("setup") ?? "";
  if (word !== "hooks") {
    throw new AxiError(`unknown setup action \`${word}\``, "VALIDATION_ERROR", ["valid setup actions: hooks", usageLine("setup")]);
  }
  const first = args[1];
  let action: Action = "install";
  if (first !== undefined && !first.startsWith("-")) {
    if (first === "install") {
      // The habit from `hook install`: the bare form is the install, so say that with the call to make.
      throw new AxiError("`setup hooks` installs or repairs the hook; it takes no `install` action", "VALIDATION_ERROR", [
        `Run \`${BIN} setup hooks${carry(args.slice(2))}\` to install or repair the hook`,
        usageLine("setup"),
      ]);
    }
    if (!isAction(first)) {
      throw new AxiError(`unknown setup hooks action \`${first}\``, "VALIDATION_ERROR", [
        `valid setup hooks actions: ${ACTIONS.join(", ")} (none: install or repair)`,
        usageLine("setup"),
      ]);
    }
    action = first;
  }
  const command = action === "install" ? "setup hooks" : `setup hooks ${action}`;
  // Per-action flag sets: --agent belongs to the install alone.
  const specs = (doc?.flags ?? HOOK_FLAGS).filter((f) => action === "install" || f.name !== "agent");
  const p = parseFlags(command, args.slice(action === "install" ? 1 : 2), specs);
  if (p.help) return renderCommandHelp("setup") ?? "";
  if (p.positionals.length) {
    const got = p.positionals[0]!;
    // `setup hooks --scope project status`: an action after a flag is never read as one.
    const message = action === "install" && isAction(got) ? `the action comes before the flags: setup hooks ${got} [flags]` : `${command} takes no arguments (got ${got})`;
    throw new AxiError(message, "USAGE", [usageLine("setup")]);
  }
  const scope = parseScope(p);
  const agent = action === "install" ? parseAgent(p) : undefined;
  const home = io.env.HOME || homedir();
  const ctx: Ctx = {
    scope,
    targets: hookTargets(scope, io.env, home, io.cwd),
    scopeFlag: getString(p, "scope") !== undefined ? ` --scope ${scope}` : "",
    show: (path) => collapseUnder(path, home),
  };
  if (action === "status") return status(ctx, io);
  if (action === "uninstall") return uninstall(ctx);
  return install(ctx, agent, io);
}

function rowsFor(targets: Targets): Array<{ agent: Agent; path: string }> {
  return [
    { agent: "claude", path: targets.claude },
    { agent: "codex", path: targets.codex },
    { agent: "opencode", path: targets.opencode },
  ];
}

/**
 * The Codex feature flag line and whether it is an error. `not set` is said only for a config that
 * was read (or does not exist) and has no hooks key; a config that cannot be read, or whose
 * features this tool does not read, is `cannot read: …`, never a guess (cli.md#setup-hooks).
 */
function codexFeatures(ctx: Ctx): { line: string; failed: boolean } {
  const path = ctx.show(ctx.targets.codexConfig);
  let hooks: boolean | undefined;
  try {
    const st = featuresState(readText(ctx.targets.codexConfig) ?? "");
    if (st.kind === "bad") return { line: `cannot read: ${st.reason} (${path})`, failed: true };
    hooks = st.hooks;
  } catch (err) {
    if (!(err instanceof SettingsError)) throw err;
    return { line: err.message, failed: true };
  }
  if (hooks === true) return { line: `${path} (hooks = true)`, failed: false };
  const value = hooks === false ? "hooks = false" : "not set";
  return {
    line: ctx.scope === "project" ? `${value} (needs [features] hooks = true in ${path}; run setup hooks --scope user or set it yourself)` : `${path} (${value})`,
    failed: false,
  };
}

/** An OpenCode plugin file without the managed marker: never overwritten, never called installed or absent. */
const UNMANAGED = "error: unmanaged file, left in place (move or delete it, or add the managed marker)";

/**
 * What to do after an error, so no footer sends the reader back into a command that fails the
 * same way: the unmanaged plugin's path and marker line, and for any other error, fix it first.
 */
function fixHints(ctx: Ctx, unmanaged: boolean, otherErrors: boolean): string[] {
  const rerun = `\`${BIN} setup hooks${ctx.scopeFlag}\``;
  const out: string[] = [];
  if (unmanaged) out.push(`Move or delete ${ctx.show(ctx.targets.opencode)}, or make its first line \`${OPENCODE_MANAGED}\` so setup hooks replaces it; then run ${rerun}`);
  if (otherErrors) out.push(`Fix what each error names, then run ${rerun}`);
  return out;
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
  let unmanaged = false;
  let otherErrors = false;
  // The targets that hold the hook with this command once the run is over: what the headline counts.
  let present = 0;
  const rows: Row[] = chosen.map(({ agent: a, path }) => {
    const row = (state: string): Row => ({ agent: a, path: ctx.show(path), state });
    const ok = (state: string): Row => {
      present++;
      return row(state);
    };
    try {
      if (a === "claude" || (a === "codex" && ctx.scope === "project")) return ok(installJson(path, command));
      if (a === "codex") {
        // Both Codex files pass their checks before either is written.
        const cfg = withCodexHooksFeature(readText(ctx.targets.codexConfig) ?? "");
        readHooksJson(path);
        const state = installJson(path, command, () => {
          if (!cfg.changed) return;
          atomicWrite(ctx.targets.codexConfig, cfg.text);
          if (!codexHooksEnabled(readText(ctx.targets.codexConfig))) throw new SettingsError("the feature flag was not set after writing");
        });
        return ok(state === "unchanged" && cfg.changed ? "updated" : state);
      }
      const current = readText(path);
      if (current !== undefined && !isOurPlugin(current)) {
        failed = true;
        unmanaged = true;
        return row(UNMANAGED);
      }
      const next = pluginSource(execPath, raw);
      if (current === next) return ok("unchanged");
      atomicWrite(path, next);
      if (pluginCommand(readText(path)) !== raw) throw new SettingsError("the plugin was not in place after writing");
      return ok(current === undefined ? "added" : "updated");
    } catch (err) {
      if (!(err instanceof SettingsError)) throw err;
      failed = true;
      otherErrors = true;
      // The target errored; whether it holds the hook is read again, and only a clean read counts.
      try {
        if (a === "opencode" ? pluginCommand(readText(path)) === raw : ourCommands(readHooksJson(path).doc).includes(command)) present++;
      } catch (again) {
        if (!(again instanceof SettingsError)) throw again;
      }
      return row(`error: ${err.message}`);
    }
  });
  const features = chosen.some((r) => r.agent === "codex") ? codexFeatures(ctx) : undefined;
  if (features?.failed) {
    failed = true;
    otherErrors = true;
  }
  const changed = rows.some((r) => r.state === "added" || r.state === "updated");
  // After an error the headline says what is true: how many of the chosen targets hold the hook.
  const headline = failed
    ? present === rows.length
      ? changed
        ? `installed (${ctx.scope} scope; see errors)`
        : `already installed (${ctx.scope} scope; no changes; see errors)`
      : present > 0
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
  if (features) body.codex_features = features.line;
  return finish(
    body,
    [...fixHints(ctx, unmanaged, otherErrors), `Run \`${BIN} setup hooks status${ctx.scopeFlag}\` to check it`, `Run \`${BIN} setup hooks uninstall${ctx.scopeFlag}\` to remove it`],
    failed,
  );
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
  let unmanaged = false;
  let otherErrors = false;
  const rows: Row[] = rowsFor(ctx.targets).map(({ agent, path }) => {
    const row = (state: string): Row => ({ agent, path: ctx.show(path), state });
    try {
      if (agent === "opencode") {
        const text = readText(path);
        if (text === undefined) return row("absent");
        if (!isOurPlugin(text)) {
          failed = true;
          unmanaged = true;
          return row(UNMANAGED);
        }
        const cmd = pluginCommand(text);
        // Ours, with no command line to read: the install would rewrite it.
        if (cmd === undefined) return row("stale");
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
      otherErrors = true;
      return row(`error: ${err.message}`);
    }
  });
  const features = codexFeatures(ctx);
  if (features.failed) {
    failed = true;
    otherErrors = true;
  }
  const present = rows.filter((r) => r.state === "installed" || r.state === "stale").length;
  const word = present === 0 ? "not installed" : rows.some((r) => r.state === "stale") ? "stale" : present < rows.length ? "partly installed" : "installed";
  const body: Record<string, unknown> = { hook: `${word} (${ctx.scope} scope${failed ? "; see errors" : ""})` };
  if (seen.size === 1) body.command = [...seen][0];
  else if (seen.size > 1) body.commands = [...seen];
  body.targets = rows;
  body.codex_features = features.line;
  // After an error the install would fail the same way, so the footer is the fix, not the install.
  const help = failed
    ? fixHints(ctx, unmanaged, otherErrors)
    : rows.every((r) => r.state === "installed")
      ? [`Run \`${BIN} setup hooks uninstall${ctx.scopeFlag}\` to remove it`]
      : [`Run \`${BIN} setup hooks${ctx.scopeFlag}\` to ${present === 0 ? "install" : "repair"} it`];
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
    `Run \`${BIN} setup hooks status${ctx.scopeFlag}\` to confirm`,
    `Run \`${BIN} setup hooks${ctx.scopeFlag}\` to add it back`,
  ], failed);
}
