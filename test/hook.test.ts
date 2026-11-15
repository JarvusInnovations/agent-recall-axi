/**
 * The SessionStart hook (specs/cli.md#setup-hooks) and the home view's hook mode
 * (specs/cli.md#home-view-no-arguments), plans/skill-and-hook.md. Every install goes into a
 * throwaway HOME and project directory: process.env.HOME is pointed at the sandbox too, so even a
 * fallback to os.homedir() cannot reach a real settings file.
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { PassThrough } from "node:stream";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { main } from "../src/cli.js";
import { hookCommandString, hookExecPath } from "../src/commands/hook.js";
import { parseHookPayload, readHookStdin } from "../src/hook.js";
import { cliInvocation } from "../src/invocation.js";
import { COMMAND_GROUPS } from "../src/reference.js";
import { FIXTURE_ROOT, resumeSession } from "./fixtures/build.js";
import { BIN_JS, CACHE_HOME, fx, NOW, run } from "./helpers/run.js";

const node = process.execPath.includes("bun") ? "node" : process.execPath;
const sandbox = mkdtempSync(join(tmpdir(), "asa-hook-"));
const savedHome = process.env.HOME;
beforeAll(() => {
  process.env.HOME = join(sandbox, "never-home");
});
afterAll(() => {
  process.env.HOME = savedHome;
  rmSync(sandbox, { recursive: true, force: true });
});

let n = 0;
interface Box {
  home: string;
  project: string;
  env: Record<string, string | undefined>;
}
function box(): Box {
  const root = join(sandbox, `box-${n++}`);
  const home = join(root, "home");
  const project = join(root, "project");
  mkdirSync(home, { recursive: true });
  mkdirSync(project, { recursive: true });
  // Every config-dir variable pinned, so no target can resolve outside the box.
  return {
    home,
    project,
    env: { HOME: home, PATH: "/usr/bin:/bin", AGENT_RECALL_AXI_DISABLE_HOOKS: undefined, CLAUDE_CONFIG_DIR: undefined, CODEX_HOME: undefined, XDG_CONFIG_HOME: undefined },
  };
}

/** A runnable stand-in for the npm bin whose path names the marker. */
function fakeBin(b: Box, prefix = "lib"): string {
  const dir = join(b.home, prefix, "node_modules", "agent-recall-axi", "dist", "bin");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "agent-recall-axi.js");
  writeFileSync(p, "#!/bin/sh\nexit 0\n");
  chmodSync(p, 0o755);
  return p;
}

async function setup(b: Box, args: string[], entrypoint?: string, cwd = b.project) {
  return run(["setup", "hooks", ...args], { cwd, env: b.env, ...(entrypoint ? { entrypoint } : {}) });
}

function tree(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (d: string) => {
    if (!existsSync(d)) return;
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const st = statSync(p);
      if (st.isDirectory()) {
        out.set(`${p}/`, "dir");
        walk(p);
      } else out.set(p, createHash("sha256").update(readFileSync(p)).digest("hex"));
    }
  };
  walk(dir);
  return out;
}

const PRE_EXISTING = {
  model: "example-model",
  permissions: { allow: ["Bash(ls:*)"] },
  hooks: {
    SessionStart: [{ matcher: "", hooks: [{ type: "command", command: "other-tool home", timeout: 5 }] }],
    Stop: [{ matcher: "", hooks: [{ type: "command", command: "other-tool stop" }] }],
  },
};

describe("setup hooks / status / uninstall", () => {
  it("--scope project installs all three targets under the project; status sees them; a second install changes no byte", async () => {
    const b = box();
    const bin = fakeBin(b);
    const r = await setup(b, ["--scope", "project"], bin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^hook: installed \(project scope\)$/m);
    expect(r.stdout).toContain(`command: ${bin}`);
    for (const [agent, rel] of [
      ["claude", ".claude/settings.json"],
      ["codex", ".codex/hooks.json"],
      ["opencode", ".opencode/plugins/axi-agent-recall-axi.js"],
    ] as const) {
      expect(r.stdout).toContain(`${agent},${join(b.project, rel)},added`);
      expect(existsSync(join(b.project, rel))).toBe(true);
    }
    // A project install writes project files only: the user's Codex flag is reported, not set.
    expect(existsSync(join(b.home, ".codex"))).toBe(false);
    expect(r.stdout).toContain(`codex_features: "not set (needs [features] hooks = true in ~/.codex/config.toml; run setup hooks --scope user or set it yourself)"`);
    const settings = JSON.parse(readFileSync(join(b.project, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", command: bin, timeout: 10 });
    expect(r.stdout).toContain("Run `agent-recall-axi setup hooks status --scope project` to check it");
    // nothing landed in the user scope
    expect(existsSync(join(b.home, ".claude"))).toBe(false);

    const st = await setup(b, ["status", "--scope", "project"], bin);
    expect(st.exitCode).toBe(0);
    expect(st.stdout).toMatch(/^hook: installed \(project scope\)$/m);
    expect(st.stdout.match(/,installed$/gm)).toHaveLength(3);
    expect(st.stdout).toContain("codex_features: ");

    const before = tree(join(b.home, ".."));
    const again = await setup(b, ["--scope", "project"], bin);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/^hook: already installed \(project scope; no changes\)$/m);
    expect(again.stdout.match(/,unchanged$/gm)).toHaveLength(3);
    expect(tree(join(b.home, ".."))).toEqual(before);
  });

  it("user scope is the default and writes each agent's home config", async () => {
    const b = box();
    const bin = fakeBin(b);
    const r = await setup(b, [], bin);
    expect(r.stdout).toMatch(/^hook: installed \(user scope\)$/m);
    expect(r.stdout).toContain("claude,~/.claude/settings.json,added");
    expect(r.stdout).toContain("codex,~/.codex/hooks.json,added");
    expect(r.stdout).toContain("opencode,~/.config/opencode/plugins/axi-agent-recall-axi.js,added");
    expect(r.stdout).toContain("codex_features: ~/.codex/config.toml (hooks = true)");
    expect(r.stdout).toContain("Run `agent-recall-axi setup hooks status` to check it");
    expect(readdirSync(b.project)).toEqual([]);
  });

  it("uninstall removes only marker-matched entries and leaves an unrelated hook and every other setting intact", async () => {
    const b = box();
    const bin = fakeBin(b);
    const settingsPath = join(b.project, ".claude", "settings.json");
    mkdirSync(join(b.project, ".claude"));
    writeFileSync(settingsPath, `${JSON.stringify(PRE_EXISTING, null, 2)}\n`);
    await setup(b, ["--scope", "project"], bin);
    const installed = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(installed.hooks.SessionStart).toHaveLength(2);
    expect(installed.hooks.Stop).toEqual(PRE_EXISTING.hooks.Stop);

    const u = await setup(b, ["uninstall", "--scope", "project"], bin);
    expect(u.exitCode).toBe(0);
    expect(u.stdout).toMatch(/^hook: removed \(project scope\)$/m);
    expect(u.stdout.match(/,removed$/gm)).toHaveLength(3);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(PRE_EXISTING);
    expect(existsSync(join(b.project, ".opencode", "plugins", "axi-agent-recall-axi.js"))).toBe(false);

    const st = await setup(b, ["status", "--scope", "project"], bin);
    expect(st.stdout).toMatch(/^hook: not installed \(project scope\)$/m);
    expect(st.stdout).toContain("Run `agent-recall-axi setup hooks --scope project` to install it");
    const again = await setup(b, ["uninstall", "--scope", "project"], bin);
    expect(again.stdout).toMatch(/^hook: nothing to remove \(project scope\)$/m);
    expect(again.stdout).toContain("Run `agent-recall-axi setup hooks status --scope project` to confirm");
    expect(again.stdout).toContain("Run `agent-recall-axi setup hooks --scope project` to add it back");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(PRE_EXISTING);
  });

  it("--agent installs one target, and the three single-agent installs write the same bytes as one full install", async () => {
    const full = box();
    const each = box();
    // the same entrypoint path for both, so the command strings agree
    const bin = fakeBin(full);
    for (const agent of ["claude", "codex", "opencode"]) {
      const r = await setup(each, ["--scope", "project", "--agent", agent], bin);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.match(/^ {2}\w+,/gm)).toHaveLength(1);
      expect(r.stdout).toContain(`${agent},`);
    }
    await setup(full, ["--scope", "project"], bin);
    const rel = (b: Box) => new Map([...tree(join(b.home, "..")).entries()].filter(([p]) => !p.includes("/lib/")).map(([p, h]) => [p.slice(join(b.home, "..").length), h]));
    expect(rel(each)).toEqual(rel(full));
    const one = box();
    await setup(one, ["--scope", "project", "--agent", "claude"], bin);
    expect(existsSync(join(one.project, ".codex"))).toBe(false);
    expect(existsSync(join(one.project, ".opencode"))).toBe(false);
    expect(existsSync(join(one.home, ".codex"))).toBe(false);
  });

  it("a moved binary shows as stale and the next install repairs the path in place", async () => {
    const b = box();
    const first = fakeBin(b);
    await setup(b, ["--scope", "project"], first);
    const moved = fakeBin(b, "moved");
    const st = await setup(b, ["status", "--scope", "project"], moved);
    expect(st.stdout).toMatch(/^hook: stale \(project scope\)$/m);
    expect(st.stdout.match(/,stale$/gm)).toHaveLength(3);
    expect(st.stdout).toContain(`command: ${first}`);
    expect(st.stdout).toContain("to repair it");
    const r = await setup(b, ["--scope", "project"], moved);
    expect(r.stdout.match(/,updated$/gm)).toHaveLength(3);
    const settings = JSON.parse(readFileSync(join(b.project, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart).toHaveLength(1);
    expect(settings.hooks.SessionStart[0].hooks[0].command).toBe(moved);
    expect(readFileSync(join(b.project, ".opencode", "plugins", "axi-agent-recall-axi.js"), "utf8")).toContain(JSON.stringify(moved));
  });

  it("the command is the bare name when agent-recall-axi on PATH resolves to the running binary", async () => {
    const b = box();
    const bin = fakeBin(b);
    const pathDir = join(b.home, "bin");
    mkdirSync(pathDir);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(bin, join(pathDir, "agent-recall-axi"));
    expect(hookCommandString(bin, pathDir)).toBe("agent-recall-axi");
    expect(hookCommandString(bin, "/usr/bin")).toBe(bin);
    const r = await setup(b, ["--scope", "project", "--agent", "claude"], bin);
    expect(r.stdout).toContain(`command: ${bin}`); // the box's PATH does not hold the link
    const linked = await run(["setup", "hooks", "--scope", "project", "--agent", "codex"], { cwd: b.project, env: { ...b.env, PATH: pathDir }, entrypoint: bin });
    expect(linked.stdout).toMatch(/^command: agent-recall-axi$/m);
  });

  it("run from the skill bundle, the hook runs the shim beside it", () => {
    const dir = join(sandbox, "skill", "scripts");
    mkdirSync(dir, { recursive: true });
    const bundle = join(dir, "agent-recall-axi.mjs");
    writeFileSync(bundle, "");
    expect(hookExecPath(bundle)).toBe(bundle); // no executable shim yet
    writeFileSync(join(dir, "agent-recall-axi"), "#!/bin/sh\n");
    chmodSync(join(dir, "agent-recall-axi"), 0o755);
    expect(hookExecPath(bundle)).toBe(join(dir, "agent-recall-axi"));
    expect(cliInvocation(bundle, "/usr/bin")).toBe(join(dir, "agent-recall-axi"));
    expect(cliInvocation("/x/dist/bin/agent-recall-axi.js", "/usr/bin")).toBe("agent-recall-axi");
  });

  it("refuses a TypeScript entrypoint and a path that does not name the tool, writing nothing", async () => {
    const b = box();
    for (const entry of [join(b.home, "src", "bin", "agent-recall-axi.ts"), join(b.home, "other-tool.js")]) {
      const r = await setup(b, ["--scope", "project"], entry);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
      expect(r.stdout).not.toMatch(/\n\s+at /);
    }
    expect(readdirSync(b.project)).toEqual([]);
    expect(readdirSync(b.home)).toEqual([]);
  });

  it("AGENT_RECALL_AXI_DISABLE_HOOKS=1 makes install a no-op", async () => {
    const b = box();
    const bin = fakeBin(b);
    const before = tree(join(b.home, ".."));
    const r = await run(["setup", "hooks", "--scope", "project"], { cwd: b.project, env: { ...b.env, AGENT_RECALL_AXI_DISABLE_HOOKS: "1" }, entrypoint: bin });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^hook: disabled by AGENT_RECALL_AXI_DISABLE_HOOKS=1 \(no changes\)$/m);
    expect(tree(join(b.home, ".."))).toEqual(before);
  });

  it("a settings file that does not parse is left alone; the other targets proceed; exit 1", async () => {
    const b = box();
    const bin = fakeBin(b);
    mkdirSync(join(b.project, ".claude"));
    writeFileSync(join(b.project, ".claude", "settings.json"), "{ not json");
    const r = await setup(b, ["--scope", "project"], bin);
    expect(r.exitCode).toBe(1);
    // An errored target means the headline never claims success.
    expect(r.stdout).toMatch(/^hook: "?partly installed \(project scope; see errors\)"?$/m);
    const st = await setup(b, ["status", "--scope", "project"], bin);
    expect(st.exitCode).toBe(1);
    expect(st.stdout).toMatch(/^hook: "?[a-z ]+ \(project scope; see errors\)"?$/m);
    expect(r.stdout).toMatch(/^ {2}claude,.*,"?error: /m);
    expect(r.stdout).toMatch(/codex,.*,added$/m);
    expect(readFileSync(join(b.project, ".claude", "settings.json"), "utf8")).toBe("{ not json");
  });

  it("an OpenCode plugin file it did not write is left in place, and neither the install nor status calls it installed or absent", async () => {
    const b = box();
    const bin = fakeBin(b);
    const plugin = join(b.project, ".opencode", "plugins", "axi-agent-recall-axi.js");
    mkdirSync(join(b.project, ".opencode", "plugins"), { recursive: true });
    writeFileSync(plugin, "// hand-written\n");
    const state = "error: unmanaged file, left in place (move or delete it, or add the managed marker)";
    const marker = "// axi-sdk-js managed opencode plugin: agent-recall-axi";

    // The one target asked for was not installed: no success headline, no exit 0.
    const one = await setup(b, ["--scope", "project", "--agent", "opencode"], bin);
    expect(one.exitCode).toBe(1);
    expect(one.stdout).toMatch(/^hook: "?not installed \(project scope; see errors\)"?$/m);
    expect(one.stdout).toContain(state);
    // The hint names the file and the marker line, and what to run after.
    const hint = one.stdout.split("\n").find((l) => l.includes("Move or delete"));
    expect(hint).toContain(plugin);
    expect(hint).toContain(marker);
    expect(hint).toContain("agent-recall-axi setup hooks --scope project");
    expect(readFileSync(plugin, "utf8")).toBe("// hand-written\n");

    // With the other targets installed it is partly installed, still exit 1.
    const all = await setup(b, ["--scope", "project"], bin);
    expect(all.exitCode).toBe(1);
    expect(all.stdout).toMatch(/^hook: "?partly installed \(project scope; see errors\)"?$/m);
    expect(all.stdout).toMatch(/claude,.*,added$/m);
    expect(all.stdout).toContain(state);

    // status reports the same state for the target, and its hint is the fix, not the install again.
    const st = await setup(b, ["status", "--scope", "project"], bin);
    expect(st.exitCode).toBe(1);
    expect(st.stdout).toMatch(/^hook: "?partly installed \(project scope; see errors\)"?$/m);
    expect(st.stdout).toContain(state);
    expect(st.stdout).not.toMatch(/opencode,.*,absent$/m);
    expect(st.stdout).not.toMatch(/Run `agent-recall-axi setup hooks --scope project` to (install|repair) it/);
    const stHint = st.stdout.split("\n").find((l) => l.includes("Move or delete"));
    expect(stHint).toContain(plugin);
    expect(stHint).toContain(marker);

    // uninstall has nothing of ours to remove there.
    const u = await setup(b, ["uninstall", "--scope", "project"], bin);
    expect(u.exitCode).toBe(0);
    expect(u.stdout).toContain("unmanaged (left in place)");
    expect(readFileSync(plugin, "utf8")).toBe("// hand-written\n");

    // The hint is true: with the marker on its first line the file is ours and the install replaces it.
    writeFileSync(plugin, `${marker}\n// hand-written\n`);
    const fixed = await setup(b, ["--scope", "project", "--agent", "opencode"], bin);
    expect(fixed.exitCode).toBe(0);
    expect(fixed.stdout).toMatch(/^hook: installed \(project scope\)$/m);
    expect(fixed.stdout).toMatch(/opencode,.*,updated$/m);
  });

  it("validates its action and flags before touching a file", async () => {
    const b = box();
    const bin = fakeBin(b);
    const cases: Array<[string[], number, RegExp]> = [
      [["frobnicate"], 2, /^code: VALIDATION_ERROR$/m],
      [["--scope", "global"], 2, /^code: VALIDATION_ERROR$/m],
      [["--agent", "cursor"], 2, /^code: VALIDATION_ERROR$/m],
      [["--bogus"], 2, /^code: UNKNOWN_FLAG$/m],
      [["--scope"], 2, /^code: USAGE$/m],
      [["status", "--agent", "claude"], 2, /^code: UNKNOWN_FLAG$/m],
      [["uninstall", "--agent", "claude"], 2, /^code: UNKNOWN_FLAG$/m],
      [["uninstall", "extra"], 2, /^code: USAGE$/m],
      [["--scope", "project", "status"], 2, /^code: USAGE$/m],
    ];
    for (const [args, code, re] of cases) {
      const r = await setup(b, args, bin);
      expect(r.exitCode, args.join(" ")).toBe(code);
      expect(r.stdout, args.join(" ")).toMatch(re);
    }
    const help = await setup(b, ["--help"], bin);
    expect(help.stdout).toMatch(/^command: setup$/m);
    expect((await setup(b, ["status", "--help"], bin)).stdout).toMatch(/^command: setup$/m);
    expect(readdirSync(b.project)).toEqual([]);
    expect(readdirSync(b.home)).toEqual(["lib"]);
  });

  it("setup alone is USAGE; an unknown setup or setup hooks action lists the valid ones", async () => {
    const b = box();
    const bin = fakeBin(b);
    const opts = { cwd: b.project, env: b.env, entrypoint: bin };
    const usage = "usage: agent-recall-axi setup hooks [--scope user|project] [--agent claude|codex|opencode] | setup hooks status [--scope user|project] | setup hooks uninstall [--scope user|project]";
    const bare = await run(["setup"], opts);
    expect(bare.exitCode).toBe(2);
    expect(bare.stdout).toMatch(/^code: USAGE$/m);
    expect(bare.stdout).toContain("setup needs an action: hooks");
    expect(bare.stdout).toContain(usage);
    const other = await run(["setup", "hook"], opts);
    expect(other.exitCode).toBe(2);
    expect(other.stdout).toMatch(/^error: unknown setup action `hook`$/m);
    expect(other.stdout).toContain("valid setup actions: hooks");
    const action = await setup(b, ["frobnicate", "--scope", "project"], bin);
    expect(action.exitCode).toBe(2);
    expect(action.stdout).toMatch(/^error: unknown setup hooks action `frobnicate`$/m);
    expect(action.stdout).toContain("valid setup hooks actions: status, uninstall (none: install or repair)");
    expect(action.stdout).toContain(usage);
    // The old subcommand under the new name: the corrected call, not an install.
    const install = await setup(b, ["install", "--scope", "project", "--agent", "claude"], bin);
    expect(install.exitCode).toBe(2);
    expect(install.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    expect(install.stdout).toContain("Run `agent-recall-axi setup hooks --scope project --agent claude` to install or repair the hook");
    // An action after a flag is never read as one, and never installs.
    const late = await setup(b, ["--scope", "project", "uninstall"], bin);
    expect(late.stdout).toContain("the action comes before the flags: setup hooks uninstall [flags]");
    // A flag error under an action prints the command's usage line, not the words typed.
    expect((await setup(b, ["status", "--scope"], bin)).stdout).toContain(usage);
    expect(readdirSync(b.project)).toEqual([]);
    expect(readdirSync(b.home)).toEqual(["lib"]);
  });
});

describe("the retired `hook` command", () => {
  it("each form fails VALIDATION_ERROR with the corrected call, arguments carried, and writes nothing", async () => {
    const b = box();
    const bin = fakeBin(b);
    const opts = { cwd: b.project, env: b.env, entrypoint: bin };
    const cases: Array<[string[], string]> = [
      [["install"], "Run `agent-recall-axi setup hooks` to install or repair the hook"],
      [["install", "--scope", "project"], "Run `agent-recall-axi setup hooks --scope project` to install or repair the hook"],
      [["install", "--scope=project", "--agent", "claude"], "Run `agent-recall-axi setup hooks --scope=project --agent claude` to install or repair the hook"],
      [["status"], "Run `agent-recall-axi setup hooks status` to see where the hook is installed"],
      [["status", "--scope", "project"], "Run `agent-recall-axi setup hooks status --scope project` to see where the hook is installed"],
      [["uninstall"], "Run `agent-recall-axi setup hooks uninstall` to remove the hook"],
      [["uninstall", "--scope", "user"], "Run `agent-recall-axi setup hooks uninstall --scope user` to remove the hook"],
      // Carried as typed and quoted for the shell, even when the corrected call will reject it.
      [["status", "two words"], "Run `agent-recall-axi setup hooks status 'two words'` to see where the hook is installed"],
      [[], "Run `agent-recall-axi setup hooks --help` for the hook commands"],
      [["frobnicate"], "Run `agent-recall-axi setup hooks --help` for the hook commands"],
      [["--help"], "Run `agent-recall-axi setup hooks --help` for the hook commands"],
    ];
    for (const [args, hint] of cases) {
      const r = await run(["hook", ...args], opts);
      expect(r.exitCode, args.join(" ")).toBe(2);
      expect(r.stdout, args.join(" ")).toMatch(/^error: hook is now `setup hooks`$/m);
      expect(r.stdout, args.join(" ")).toMatch(/^code: VALIDATION_ERROR$/m);
      expect(r.stdout, args.join(" ")).toContain(hint);
      expect(r.stdout, args.join(" ")).toContain("usage: agent-recall-axi setup hooks [--scope user|project]");
    }
    // No alias: nothing was installed, read or removed.
    expect(readdirSync(b.project)).toEqual([]);
    expect(readdirSync(b.home)).toEqual(["lib"]);
  });

  it("is not in --help, and the redirect is the same without a built binary", async () => {
    const top = await run(["--help"]);
    expect(top.stdout).toContain("setup hooks [--scope user|project] [--agent claude|codex|opencode] | setup hooks status");
    expect(top.stdout).not.toMatch(/^\s+hook /m);
    const b = box();
    const r = await run(["hook", "install"], { cwd: b.project, env: b.env });
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toContain("Run `agent-recall-axi setup hooks` to install or repair the hook");
  });

  it("an entry written under the old command name is still ours: installed, repaired in place, removed", async () => {
    const b = box();
    const bin = fakeBin(b);
    // What `hook install --scope project --agent claude` wrote: the command string never named the subcommand.
    const p = join(b.project, ".claude", "settings.json");
    mkdirSync(join(p, ".."), { recursive: true });
    const old = `${JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: "command", command: bin, timeout: 10 }] }] } }, null, 2)}\n`;
    writeFileSync(p, old);
    const st = await setup(b, ["status", "--scope", "project"], bin);
    expect(st.stdout).toContain(`claude,${p},installed`);
    const again = await setup(b, ["--scope", "project", "--agent", "claude"], bin);
    expect(again.stdout).toMatch(/^hook: already installed \(project scope; no changes\)$/m);
    expect(readFileSync(p, "utf8")).toBe(old);
    const u = await setup(b, ["uninstall", "--scope", "project"], bin);
    expect(u.stdout).toMatch(/^hook: removed \(project scope\)$/m);
    expect(u.stdout).toContain(`claude,${p},removed`);
    expect(readFileSync(p, "utf8")).not.toContain(bin);
  });
});

describe("every hint the hook commands print runs", () => {
  /** Every `Run \`agent-recall-axi …\`` hint in an output, as argv (no hint here carries a quoted word). */
  const hintsOf = (out: string): string[][] => [...out.matchAll(/Run `agent-recall-axi ([^`]*)`/g)].map((m) => m[1]!.split(" "));

  it("install, status, uninstall and the redirects, at both scopes: each hint exits 0", async () => {
    const seen = new Set<string>();
    for (const scope of [[], ["--scope", "project"]]) {
      const b = box();
      const bin = fakeBin(b);
      const opts = { cwd: b.project, env: b.env, entrypoint: bin };
      const sources: string[][] = [
        ["setup", "hooks", "status", ...scope], // not installed: suggests the install
        ["hook", "install", ...scope],
        ["setup", "hooks", "install", ...scope],
        ["setup", "hooks", ...scope],
        ["setup", "hooks", "status", ...scope], // installed: suggests uninstall
        ["hook", "status", ...scope],
        ["hook", "uninstall", ...scope],
        ["hook"],
        ["setup", "hooks", "uninstall", ...scope],
        ["setup", "hooks", "--bogus"],
        ["setup", "hooks", "status", "--bogus"],
      ];
      for (const args of sources) {
        const out = await run(args, opts);
        const hs = hintsOf(out.stdout);
        expect(hs.length, args.join(" ")).toBeGreaterThan(0);
        for (const h of hs) {
          seen.add(h.join(" "));
          const r = await run(h, opts);
          expect(r.exitCode, `${args.join(" ")} -> ${h.join(" ")}`).toBe(0);
        }
      }
    }
    expect([...seen].sort()).toEqual([
      "setup hooks",
      "setup hooks --help",
      "setup hooks --scope project",
      "setup hooks status",
      "setup hooks status --help",
      "setup hooks status --scope project",
      "setup hooks uninstall",
      "setup hooks uninstall --scope project",
    ]);
  });
});

/** A settings file holding `json` (raw text when a string), returned with its path. */
function settingsFile(b: Box, text: string, rel = ".claude/settings.json"): string {
  const p = join(b.project, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, text);
  return p;
}

const groups = (p: string) => JSON.parse(readFileSync(p, "utf8")).hooks.SessionStart as Array<{ hooks: Array<{ command: string }> }>;
const commands = (p: string) => groups(p).flatMap((g) => g.hooks.map((h) => h.command));

describe("hook review fixes", () => {
  it("never touches a hook that merely mentions the tool: wrappers, arguments, pipelines", async () => {
    const b = box();
    const bin = fakeBin(b);
    const theirs = ["/opt/tools/agent-recall-axi-wrapper --project x", "agent-recall-axi --flag", "echo agent-recall-axi | logger", `${bin} tail latest`];
    const doc = { hooks: { SessionStart: theirs.map((command) => ({ matcher: "", hooks: [{ type: "command", command }] })) } };
    const p = settingsFile(b, `${JSON.stringify(doc, null, 2)}\n`);
    const r = await setup(b, ["--scope", "project", "--agent", "claude"], bin);
    expect(r.stdout).toContain(",added");
    expect(commands(p)).toEqual([...theirs, bin]);
    const u = await setup(b, ["uninstall", "--scope", "project"], bin);
    expect(u.stdout).toMatch(/claude,.*,removed$/m);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(doc);
    const st = await setup(b, ["status", "--scope", "project"], bin);
    expect(st.stdout).toMatch(/claude,.*,absent$/m);
  });

  it("recognises its own entry quoted, repairs it, and drops a duplicate", async () => {
    const b = box();
    const bin = fakeBin(b);
    const old = "/old/place/dist/bin/agent-recall-axi.js";
    const doc = { hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: `'${old}'`, timeout: 10 }] }, { matcher: "", hooks: [{ type: "command", command: `"${old}"` }] }] } };
    const p = settingsFile(b, JSON.stringify(doc, null, 2));
    const st = await setup(b, ["status", "--scope", "project"], bin);
    expect(st.stdout).toMatch(/claude,.*,stale$/m);
    await setup(b, ["--scope", "project", "--agent", "claude"], bin);
    expect(commands(p)).toEqual([bin]);
  });

  it("quotes a command whose path has a space for the shell targets, and the hook runs", async () => {
    const b = box();
    const dir = join(b.home, "my tools", "dist", "bin");
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "agent-recall-axi.js");
    writeFileSync(bin, `#!/bin/sh\necho ran-$1\n`);
    chmodSync(bin, 0o755);
    const r = await setup(b, ["--scope", "project"], bin);
    expect(r.exitCode).toBe(0);
    const quoted = `'${bin}'`;
    expect(r.stdout).toContain(`command: ${quoted}\n`);
    const claude = commands(join(b.project, ".claude", "settings.json"));
    expect(claude).toEqual([quoted]);
    expect(commands(join(b.project, ".codex", "hooks.json"))).toEqual([quoted]);
    expect(readFileSync(join(b.project, ".opencode", "plugins", "axi-agent-recall-axi.js"), "utf8")).toContain(`const command = ${JSON.stringify(bin)};`);
    expect(spawnSync("/bin/sh", ["-c", claude[0]!], { encoding: "utf8" }).stdout).toBe("ran-\n");
    const st = await setup(b, ["status", "--scope", "project"], bin);
    expect(st.stdout.match(/,installed$/gm)).toHaveLength(3);
    const again = await setup(b, ["--scope", "project"], bin);
    expect(again.stdout).toMatch(/^hook: already installed/m);
    const u = await setup(b, ["uninstall", "--scope", "project"], bin);
    expect(u.stdout.match(/,removed$/gm)).toHaveLength(3);
  });

  it("a settings file of the wrong shape is an error, not overwritten", async () => {
    for (const text of ["[]", '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}', '"text"', "null", '{"hooks":null}']) {
      const b = box();
      const bin = fakeBin(b);
      const p = settingsFile(b, text);
      const r = await setup(b, ["--scope", "project", "--agent", "claude"], bin);
      expect(r.exitCode, text).toBe(1);
      expect(r.stdout, text).toMatch(/claude,.*,"?error: /m);
      expect(r.stdout, text).not.toContain(",added");
      expect(readFileSync(p, "utf8"), text).toBe(text);
    }
  });

  it("keeps indentation, every key, the file's mode, and writes through a symlink onto its target", async () => {
    const b = box();
    const bin = fakeBin(b);
    const doc = { z: 1, a: { nested: [1, 2] }, hooks: { Stop: [] } };
    for (const indent of ["    ", "\t"]) {
      const real = join(b.home, `real-${indent.length}.json`);
      writeFileSync(real, `${JSON.stringify(doc, null, indent)}\n`);
      chmodSync(real, 0o600);
      rmSync(join(b.project, ".claude"), { recursive: true, force: true });
      mkdirSync(join(b.project, ".claude"));
      const { symlinkSync, lstatSync } = await import("node:fs");
      symlinkSync(real, join(b.project, ".claude", "settings.json"));
      await setup(b, ["--scope", "project", "--agent", "claude"], bin);
      expect(lstatSync(join(b.project, ".claude", "settings.json")).isSymbolicLink()).toBe(true);
      const text = readFileSync(real, "utf8");
      expect(text.split("\n")[1]!.startsWith(`${indent}"z"`)).toBe(true);
      expect(Object.keys(JSON.parse(text))).toEqual(["z", "a", "hooks"]);
      expect(JSON.parse(text).a).toEqual(doc.a);
      expect(statSync(real).mode & 0o777).toBe(0o600);
      expect(readdirSync(b.home).filter((f) => f.includes(".tmp"))).toEqual([]);
    }
  });

  it("user scope honours CLAUDE_CONFIG_DIR, CODEX_HOME and XDG_CONFIG_HOME", async () => {
    const b = box();
    const bin = fakeBin(b);
    const env = { ...b.env, CLAUDE_CONFIG_DIR: join(b.home, "cc"), CODEX_HOME: join(b.home, "cx"), XDG_CONFIG_HOME: join(b.home, "xdg") };
    const r = await run(["setup", "hooks"], { cwd: b.project, env, entrypoint: bin });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("claude,~/cc/settings.json,added");
    expect(r.stdout).toContain("codex,~/cx/hooks.json,added");
    expect(r.stdout).toContain("opencode,~/xdg/opencode/plugins/axi-agent-recall-axi.js,added");
    expect(r.stdout).toContain("codex_features: ~/cx/config.toml (hooks = true)");
    for (const d of [".claude", ".codex", ".config"]) expect(existsSync(join(b.home, d)), d).toBe(false);
    const st = await run(["setup", "hooks", "status"], { cwd: b.project, env, entrypoint: bin });
    expect(st.stdout.match(/,installed$/gm)).toHaveLength(3);
    const u = await run(["setup", "hooks", "uninstall"], { cwd: b.project, env, entrypoint: bin });
    expect(u.stdout.match(/,removed$/gm)).toHaveLength(3);
  });

  it("project scope reports the Codex flag as on when the user's config already has it", async () => {
    const b = box();
    const bin = fakeBin(b);
    mkdirSync(join(b.home, ".codex"));
    writeFileSync(join(b.home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    const r = await setup(b, ["--scope", "project", "--agent", "codex"], bin);
    expect(r.stdout).toContain("codex_features: ~/.codex/config.toml (hooks = true)");
  });

  it("Codex config: a features table declared any way but plain is an error; neither Codex file is written", async () => {
    const bad = [
      'model = "x"\nfeatures.hooks = true\n',
      "features = { hooks = true }\n",
      "[features.extra]\nx = 1\n",
      "[[features]]\nx = 1\n",
      "[features]\nx = 1\n[features]\ny = 2\n",
      '[features]\nhooks = "yes"\n',
      '"features".hooks = true\n',
    ];
    for (const text of bad) {
      const b = box();
      const bin = fakeBin(b);
      mkdirSync(join(b.home, ".codex"));
      const cfg = join(b.home, ".codex", "config.toml");
      writeFileSync(cfg, text);
      const r = await setup(b, ["--agent", "codex"], bin);
      expect(r.exitCode, text).toBe(1);
      expect(r.stdout, text).toMatch(/codex,.*,"?error: /m);
      expect(readFileSync(cfg, "utf8"), text).toBe(text);
      expect(existsSync(join(b.home, ".codex", "hooks.json")), text).toBe(false);
    }
  });

  it("Codex config: a plain table gains one line inside it; false becomes true; line endings kept", async () => {
    const cases: Array<[string, string]> = [
      ["", "[features]\nhooks = true\n"],
      ['model = "x"\n', 'model = "x"\n\n[features]\nhooks = true\n'],
      ["[features]\nother = 1\n\n[profile]\nx = 1\n", "[features]\nother = 1\nhooks = true\n\n[profile]\nx = 1\n"],
      ["[features]\nhooks = false # off\n", "[features]\nhooks = true # off\n"],
      ["[tui]\nfeatures.x = 1\n", "[tui]\nfeatures.x = 1\n\n[features]\nhooks = true\n"],
      ["[features]\r\nother = 1\r\n", "[features]\r\nother = 1\r\nhooks = true\r\n"],
    ];
    for (const [text, want] of cases) {
      const b = box();
      const bin = fakeBin(b);
      mkdirSync(join(b.home, ".codex"));
      const cfg = join(b.home, ".codex", "config.toml");
      writeFileSync(cfg, text);
      const r = await setup(b, ["--agent", "codex"], bin);
      expect(r.exitCode, JSON.stringify(text)).toBe(0);
      expect(readFileSync(cfg, "utf8"), JSON.stringify(text)).toBe(want);
    }
  });

  it("update run from the bundle is a skill install wherever the bundle lives", async () => {
    const dir = join(sandbox, "anywhere", "scripts");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent-recall-axi.mjs"), "");
    writeFileSync(join(dir, "agent-recall-axi"), "#!/bin/sh\n");
    chmodSync(join(dir, "agent-recall-axi"), 0o755);
    const u = await run(["update"], { entrypoint: join(dir, "agent-recall-axi.mjs") });
    expect(u.stdout).toMatch(/^update: agent-recall-axi \S+ \(skill install\)$/m);
    const npm = await run(["update"], { entrypoint: "/opt/skills/x/node_modules/agent-recall-axi/dist/bin/agent-recall-axi.js" });
    expect(npm.stdout).toMatch(/\(npm install\)$/m);
  });

  it("a quoted hint path under HOME keeps its ~/ outside the quotes", async () => {
    const home = process.env.HOME!;
    const dir = join(home, "my skills", "agent-recall-axi", "scripts");
    mkdirSync(dir, { recursive: true });
    const bundle = join(dir, "agent-recall-axi.mjs");
    writeFileSync(bundle, "");
    writeFileSync(join(dir, "agent-recall-axi"), "#!/bin/sh\n");
    chmodSync(join(dir, "agent-recall-axi"), 0o755);
    expect(cliInvocation(bundle, "/usr/bin")).toBe("~/'my skills/agent-recall-axi/scripts/agent-recall-axi'");
    const plain = join(home, "plain", "scripts");
    mkdirSync(plain, { recursive: true });
    writeFileSync(join(plain, "agent-recall-axi.mjs"), "");
    writeFileSync(join(plain, "agent-recall-axi"), "#!/bin/sh\n");
    chmodSync(join(plain, "agent-recall-axi"), 0o755);
    expect(cliInvocation(join(plain, "agent-recall-axi.mjs"), "/usr/bin")).toBe("~/plain/scripts/agent-recall-axi");
    const { shellPath } = await import("../src/commands/common.js");
    expect(shellPath(join(home, "my proj"))).toBe("~/'my proj'");
    expect(shellPath(join(home, "proj"))).toBe("~/proj");
    expect(shellPath("/opt/my proj")).toBe("'/opt/my proj'");
  });
});

/** chmod cannot make a file unreadable to root, so the permission tests are skipped there. */
const asRoot = process.getuid?.() === 0;

describe("setup hooks fails closed (plans/hook-fail-open.md)", () => {
  it.skipIf(asRoot)("an unreadable Codex config.toml is `cannot read`, never `not set`: status and the install exit 1 and say the hooks are in place", async () => {
    const b = box();
    const bin = fakeBin(b);
    expect((await setup(b, [], bin)).exitCode).toBe(0);
    const cfg = join(b.home, ".codex", "config.toml");
    expect(readFileSync(cfg, "utf8")).toContain("hooks = true");
    const before = tree(b.home);
    const mode = statSync(cfg).mode & 0o7777;
    chmodSync(cfg, 0o000);
    try {
      const st = await setup(b, ["status"], bin);
      expect(st.exitCode).toBe(1);
      expect(st.stdout).toMatch(/^hook: "?installed \(user scope; see errors\)"?$/m);
      expect(st.stdout).toMatch(/^codex_features: "?cannot read: /m);
      expect(st.stdout).not.toContain("not set");
      for (const agent of ["claude", "codex", "opencode"]) expect(st.stdout).toMatch(new RegExp(`^ {2}${agent},.*,installed$`, "m"));
      // Not "all good, here is how to remove it".
      expect(st.stdout).not.toMatch(/^help\[1\]:\n {2}Run `agent-recall-axi setup hooks uninstall`/m);

      // The install: every hook is in place and one check failed. It does not say "not installed".
      const r = await setup(b, [], bin);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/^hook: "?already installed \(user scope; no changes; see errors\)"?$/m);
      expect(r.stdout).toMatch(/^ {2}codex,.*,"?error: cannot read: /m);
      expect(r.stdout).toMatch(/^codex_features: "?cannot read: /m);
      expect(r.stdout).not.toContain("not set");

      // Project scope reads the same user flag.
      const p = await setup(b, ["status", "--scope", "project"], bin);
      expect(p.exitCode).toBe(1);
      expect(p.stdout).toMatch(/^codex_features: "?cannot read: /m);
      expect(p.stdout).not.toContain("not set");
    } finally {
      chmodSync(cfg, mode);
    }
    expect(tree(b.home)).toEqual(before);
  });

  it.skipIf(asRoot)("an unreadable Codex config.toml with no Codex hook yet: the Codex target errors, nothing of Codex is written, the rest is partly installed", async () => {
    const b = box();
    const bin = fakeBin(b);
    mkdirSync(join(b.home, ".codex"));
    const cfg = join(b.home, ".codex", "config.toml");
    writeFileSync(cfg, "[features]\nhooks = true\n");
    chmodSync(cfg, 0o000);
    try {
      const r = await setup(b, [], bin);
      expect(r.exitCode).toBe(1);
      expect(r.stdout).toMatch(/^hook: "?partly installed \(user scope; see errors\)"?$/m);
      expect(existsSync(join(b.home, ".codex", "hooks.json"))).toBe(false);
      const one = await setup(b, ["--agent", "codex"], bin);
      expect(one.exitCode).toBe(1);
      expect(one.stdout).toMatch(/^hook: "?not installed \(user scope; see errors\)"?$/m);
      const st = await setup(b, ["status"], bin);
      expect(st.exitCode).toBe(1);
      expect(st.stdout).toMatch(/^hook: "?partly installed \(user scope; see errors\)"?$/m);
      expect(st.stdout).toMatch(/codex,.*,absent$/m);
    } finally {
      chmodSync(cfg, 0o644);
    }
  });

  it("`not set` is said only for a config that was read (or is missing) and has no hooks key", async () => {
    const b = box();
    const bin = fakeBin(b);
    const cfg = join(b.home, ".codex", "config.toml");
    const line = async (args: string[]) => {
      const r = await setup(b, args, bin);
      return { ...r, features: r.stdout.split("\n").find((l) => l.startsWith("codex_features:")) };
    };
    // No file.
    let st = await line(["status"]);
    expect(st.exitCode).toBe(0);
    expect(st.features).toBe("codex_features: ~/.codex/config.toml (not set)");
    // Read, no key.
    mkdirSync(join(b.home, ".codex"));
    writeFileSync(cfg, 'model = "example-model"\n\n[features]\nother = true\n');
    st = await line(["status"]);
    expect(st.exitCode).toBe(0);
    expect(st.features).toBe("codex_features: ~/.codex/config.toml (not set)");
    // Set to false is not "not set".
    writeFileSync(cfg, "[features]\nhooks = false\n");
    st = await line(["status"]);
    expect(st.exitCode).toBe(0);
    expect(st.features).toBe("codex_features: ~/.codex/config.toml (hooks = false)");
    const proj = await line(["status", "--scope", "project"]);
    expect(proj.exitCode).toBe(0);
    expect(proj.features).toContain("hooks = false (needs [features] hooks = true in ~/.codex/config.toml; run setup hooks --scope user or set it yourself)");
    // Declared in a way this tool does not read: the flag is unknown, which is an error, at either scope.
    for (const text of ["features.hooks = true\n", "[features]\nhooks = true\n\n[features]\nhooks = false\n", '[features]\nhooks = "yes"\n']) {
      writeFileSync(cfg, text);
      for (const scope of [[], ["--scope", "project"]]) {
        st = await line(["status", ...scope]);
        expect(st.exitCode, text).toBe(1);
        expect(st.features, text).toMatch(/^codex_features: "?cannot read: /);
        expect(st.stdout, text).not.toContain("not set");
        expect(st.stdout, text).toMatch(/^hook: "?not installed \((user|project) scope; see errors\)"?$/m);
        expect(st.stdout, text).not.toMatch(/Run `agent-recall-axi setup hooks[^`]*` to (install|repair) it/);
      }
      expect(readFileSync(cfg, "utf8")).toBe(text);
    }
    // A project install writes its three files and still reports the unknown user flag as an error.
    const r = await line(["--scope", "project"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^hook: "?installed \(project scope; see errors\)"?$/m);
    expect(r.features).toMatch(/^codex_features: "?cannot read: /);
  });

  it("an install where one target errors and the others are already in place is partly installed, not `not installed`", async () => {
    const b = box();
    const bin = fakeBin(b);
    const p = settingsFile(b, "{ not json");
    const first = await setup(b, ["--scope", "project"], bin);
    expect(first.exitCode).toBe(1);
    expect(first.stdout).toMatch(/^hook: "?partly installed \(project scope; see errors\)"?$/m);
    // Nothing changes the second time; two of three targets still hold the hook.
    const second = await setup(b, ["--scope", "project"], bin);
    expect(second.exitCode).toBe(1);
    expect(second.stdout).toMatch(/^hook: "?partly installed \(project scope; see errors\)"?$/m);
    expect(second.stdout).toMatch(/codex,.*,unchanged$/m);
    expect(second.stdout).toContain("Fix what each error names, then run `agent-recall-axi setup hooks --scope project`");
    // Only the broken target was asked for: nothing is installed.
    const one = await setup(b, ["--scope", "project", "--agent", "claude"], bin);
    expect(one.exitCode).toBe(1);
    expect(one.stdout).toMatch(/^hook: "?not installed \(project scope; see errors\)"?$/m);
    // status does not send the reader back to an install that fails the same way.
    const st = await setup(b, ["status", "--scope", "project"], bin);
    expect(st.exitCode).toBe(1);
    expect(st.stdout).not.toMatch(/Run `agent-recall-axi setup hooks --scope project` to (install|repair) it/);
    expect(st.stdout).toContain("Fix what each error names, then run `agent-recall-axi setup hooks --scope project`");
    expect(readFileSync(p, "utf8")).toBe("{ not json");
  });

  it("a managed OpenCode plugin whose command line cannot be read is stale, not absent, and the install repairs it", async () => {
    const b = box();
    const bin = fakeBin(b);
    expect((await setup(b, ["--scope", "project"], bin)).exitCode).toBe(0);
    const plugin = join(b.project, ".opencode", "plugins", "axi-agent-recall-axi.js");
    const good = readFileSync(plugin, "utf8");
    const broken = good.replace(/^const command = .*$/m, "const command = oops;");
    expect(broken).not.toBe(good);
    writeFileSync(plugin, broken);
    const st = await setup(b, ["status", "--scope", "project"], bin);
    expect(st.exitCode).toBe(0);
    expect(st.stdout).toMatch(/^hook: stale \(project scope\)$/m);
    expect(st.stdout).toMatch(/opencode,.*,stale$/m);
    expect(st.stdout).toContain("Run `agent-recall-axi setup hooks --scope project` to repair it");
    const r = await setup(b, ["--scope", "project"], bin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/opencode,.*,updated$/m);
    expect(readFileSync(plugin, "utf8")).toBe(good);
  });
});

describe("the bin's stdin, process-level", () => {
  const spawnBin = (cwd: string, write?: string) =>
    new Promise<{ code: number | null; stdout: string }>((resolveRun, reject) => {
      const child = spawn(node, [BIN_JS], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, CLAUDE_CONFIG_DIR: FIXTURE_ROOT, TZ: "UTC", XDG_CACHE_HOME: CACHE_HOME }, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = "";
      child.stdout.on("data", (c) => (stdout += c));
      if (write !== undefined) child.stdin.write(write);
      // the writer stays open: the child must not wait for end of input
      child.on("error", reject);
      child.on("close", (code) => {
        child.stdin.destroy();
        resolveRun({ code, stdout });
      });
    });

  it("a held-open silent pipe and a partial payload with an open writer both print the listing", async () => {
    const cwd = sandbox;
    for (const write of [undefined, '{"session_id":"a6000006-0000-4000-8000-000000000000","sour']) {
      const r = await spawnBin(cwd, write);
      expect(r.code, String(write)).toBe(0);
      // The home view, not an error: this cwd has no sessions, so it is the scoped empty state.
      expect(r.stdout, String(write)).toMatch(/^sessions(\[\d+\]|: none in this directory)/m);
    }
  });
});

describe("nothing but setup hooks writes a settings file (privacy.md)", () => {
  it("every other command, the home view in hook mode, and setup hooks status/uninstall leave HOME and the project untouched", async () => {
    const b = box();
    const bin = fakeBin(b);
    const before = tree(join(b.home, ".."));
    const fixturesBefore = tree(FIXTURE_ROOT);
    const session = fx("compaction");
    const id = basename(session, ".jsonl");
    const invocations: string[][] = [
      [],
      ["sessions", "--all"],
      ["turns", session],
      ["events", session],
      ["tail", session],
      ["around", `${id.slice(0, 8)}:3`, "--all"],
      ["next", `${id.slice(0, 8)}:1`, "--all"],
      ["prev", `${id.slice(0, 8)}:5`, "--all"],
      ["show", `${id.slice(0, 8)}:1`, "--all"],
      ["zoom", `${id.slice(0, 8)}:1`, "--all"],
      ["human", session],
      ["tools", session],
      ["compactions", session],
      ["resume-pack", session],
      ["find", "widget", "--all"],
      ["search", "widget"],
      ["cache", "status"],
      ["update"],
      ["setup", "hooks", "status"],
      ["setup", "hooks", "status", "--scope", "project"],
      ["setup", "hooks", "uninstall"],
      ["setup", "hooks", "uninstall", "--scope", "project"],
    ];
    const covered = new Set(invocations.map((a) => a[0]).filter(Boolean));
    for (const g of COMMAND_GROUPS) for (const c of g.commands) expect(covered.has(c.name), c.name).toBe(true);
    for (const args of invocations) {
      await run(args, { cwd: args[0] === "setup" ? b.project : "/src/widget", env: b.env, entrypoint: bin });
    }
    for (const c of COMMAND_GROUPS.flatMap((g) => g.commands)) await run([c.name, "--help"], { env: b.env, entrypoint: bin });
    for (const payload of ['{"session_id":"x","source":"compact"}', `{"session_id":"${id}","source":"compact"}`, "garbage"]) {
      await homeWith(payload, { cwd: "/src/widget", env: b.env });
    }
    // user-scope status/uninstall with the log root as CLAUDE_CONFIG_DIR read it, never write it
    await run(["setup", "hooks", "uninstall"], { cwd: b.project, env: { ...b.env, CLAUDE_CONFIG_DIR: FIXTURE_ROOT }, entrypoint: bin });
    expect(tree(join(b.home, ".."))).toEqual(before);
    expect(tree(FIXTURE_ROOT)).toEqual(fixturesBefore);
  });
});

/** The home view with `text` on a non-TTY stdin (undefined: a stream nobody writes to or closes). */
async function homeWith(text: string | undefined, opts: { cwd?: string; env?: Record<string, string | undefined>; end?: boolean } = {}) {
  const stdin = new PassThrough();
  if (text !== undefined) {
    stdin.write(text);
    if (opts.end !== false) stdin.end();
  }
  let stdout = "";
  const saved = process.exitCode;
  process.exitCode = undefined;
  try {
    await main([], {
      stdout: { write: (c: string) => (stdout += c) },
      cwd: opts.cwd ?? "/src/widget",
      env: { CLAUDE_CONFIG_DIR: FIXTURE_ROOT, TZ: "UTC", XDG_CACHE_HOME: CACHE_HOME, ...opts.env },
      now: NOW,
      stdin: () => stdin,
    });
    return { stdout, exitCode: typeof process.exitCode === "number" ? process.exitCode : 0 };
  } finally {
    process.exitCode = saved;
  }
}

describe("home view hook mode", () => {
  const session = fx("compaction");
  const id = basename(session, ".jsonl");

  it("source compact or resume prints the session's resume pack with a 6k budget", async () => {
    const pack = await run(["resume-pack", id, "--budget", "6000"]);
    expect(pack.exitCode).toBe(0);
    for (const source of ["compact", "resume"]) {
      const r = await homeWith(JSON.stringify({ session_id: id, transcript_path: session, source, hook_event_name: "SessionStart", cwd: "/src/widget" }));
      expect(r.exitCode).toBe(0);
      // under the SDK's home header (bin, description), the pack's exact bytes
      expect(r.stdout).toMatch(/^bin: .*\ndescription: /);
      expect(r.stdout.split("\n").slice(2).join("\n")).toBe(pack.stdout);
      expect(r.stdout).toMatch(/^budget: .* of 6\.0k used$/m);
      expect(r.stdout).toMatch(new RegExp(`^session: ${id.slice(0, 8)} `, "m"));
    }
  });

  it("startup, clear, garbage, an empty stdin, a payload without source and an unusable session print the listing", async () => {
    // Warm the session-stats cache first: every case below shares it, and a cold baseline
    // (mtime rows, turns `?`) would differ from a later stats-backed listing.
    await run(["sessions", "--limit", "0"]);
    const listing = await run([]);
    expect(listing.stdout).not.toMatch(/,\?,/);
    expect(listing.stdout).toMatch(/^sessions\[/m);
    const cases: Array<string | undefined> = [
      JSON.stringify({ session_id: id, source: "startup" }),
      JSON.stringify({ session_id: id, source: "clear" }),
      "garbage",
      "",
      "[1,2]",
      JSON.stringify({ session_id: id }),
      JSON.stringify({ source: "compact" }),
      JSON.stringify({ session_id: "--all", source: "compact" }),
      JSON.stringify({ session_id: "latest", source: "compact" }),
      JSON.stringify({ session_id: id.slice(0, 8), source: "compact" }),
      JSON.stringify({ session_id: session, source: "compact" }),
      JSON.stringify({ session_id: 42, source: "compact" }),
      // a well-formed id that is not a session here (another agent's, say)
      JSON.stringify({ session_id: "0f0f0f0f-0000-4000-8000-000000000000", source: "resume" }),
      `{"session_id":"${id}","source":"compact"`,
    ];
    for (const text of cases) {
      const r = await homeWith(text);
      expect(r.exitCode, String(text)).toBe(0);
      expect(r.stdout, String(text)).toBe(listing.stdout);
    }
  });

  it("never hangs: a pipe nobody writes to, or a payload whose writer never closes, returns", async () => {
    const silent = await homeWith(undefined);
    expect(silent.stdout).toMatch(/^sessions\[/m);
    const open = await homeWith(JSON.stringify({ session_id: id, source: "compact" }), { end: false });
    expect(open.stdout).toMatch(/^budget: .* of 6\.0k used$/m);
  });

  it("the stdin reader's bounds", async () => {
    const tty = Object.assign(new PassThrough(), { isTTY: true });
    tty.write('{"session_id":"x","source":"compact"}');
    expect(await readHookStdin(tty)).toBeUndefined();
    const big = new PassThrough();
    big.write("x".repeat(70 * 1024));
    expect((await readHookStdin(big, { firstByteMs: 200, totalMs: 1000, maxBytes: 64 * 1024 }))!.length).toBeGreaterThanOrEqual(64 * 1024);
    const slow = new PassThrough();
    slow.write('{"session_id":');
    expect(await readHookStdin(slow, { firstByteMs: 50, totalMs: 100, maxBytes: 1024 })).toBe('{"session_id":');
    // a multi-byte character split across two chunks
    const split = new PassThrough();
    const bytes = Buffer.from('{"session_id":"x","cwd":"/src/wïdget","source":"startup"}');
    const at = bytes.indexOf(0xc3) + 1;
    split.write(bytes.subarray(0, at));
    setTimeout(() => split.end(bytes.subarray(at)), 20);
    expect(JSON.parse((await readHookStdin(split))!).cwd).toBe("/src/wïdget");
    expect(parseHookPayload('{"session_id":"ABCDEF01-0000-4000-8000-000000000000","source":"compact"}')!.session_id).toBe("abcdef01-0000-4000-8000-000000000000");
  });
});

describe("step 0: the installed command receives the SessionStart payload", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  it("the exact command string setup hooks wrote, run the way Claude Code runs it, prints the resume pack after compact", async () => {
    const b = box();
    // A real project directory with a session in a private log root.
    const logRoot = join(b.home, "claude-config");
    const s8 = "ea00002a";
    const encoded = b.project.replace(/[^A-Za-z0-9]/g, "-");
    mkdirSync(join(logRoot, "projects", encoded), { recursive: true });
    const sessionId = `${s8}-0000-4000-8000-000000000000`;
    writeFileSync(join(logRoot, "projects", encoded, `${sessionId}.jsonl`), resumeSession(s8).replaceAll('"cwd":"/src/widget"', `"cwd":${JSON.stringify(b.project)}`));
    const r = await setup(b, ["--scope", "project", "--agent", "claude"], BIN_JS);
    expect(r.exitCode).toBe(0);
    const command = JSON.parse(readFileSync(join(b.project, ".claude", "settings.json"), "utf8")).hooks.SessionStart[0].hooks[0].command as string;
    expect(command).toBe(BIN_JS);
    const cache = mkdtempSync(join(tmpdir(), "asa-hook-cache-"));
    dirs.push(cache);
    const env = { PATH: `${join(node, "..")}:/usr/bin:/bin`, HOME: b.home, CLAUDE_CONFIG_DIR: logRoot, XDG_CACHE_HOME: cache, TZ: "UTC" };
    const payload = (source: string) => JSON.stringify({ session_id: sessionId, transcript_path: join(logRoot, "projects", encoded, `${sessionId}.jsonl`), cwd: b.project, hook_event_name: "SessionStart", source });
    const viaHook = spawnSync("/bin/sh", ["-c", command], { cwd: b.project, env, input: payload("compact"), encoding: "utf8" });
    expect(viaHook.status).toBe(0);
    expect(viaHook.stdout).toMatch(/^budget: .* of 6\.0k used$/m);
    const direct = spawnSync(node, [BIN_JS, "resume-pack", sessionId, "--budget", "6000"], { cwd: b.project, env, encoding: "utf8" });
    expect(viaHook.stdout.split("\n").slice(2).join("\n")).toBe(direct.stdout);
    const startup = spawnSync("/bin/sh", ["-c", command], { cwd: b.project, env, input: payload("startup"), encoding: "utf8" });
    expect(startup.stdout).toMatch(/^sessions\[1\]/m);
    // a hook run with stdin closed (OpenCode spawns with stdin ignored) prints the listing
    const ignored = spawnSync("/bin/sh", ["-c", command], { cwd: b.project, env, stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" });
    expect(ignored.stdout).toBe(startup.stdout);
  });
});
