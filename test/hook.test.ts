/**
 * The SessionStart hook (specs/cli.md#hook) and the home view's hook mode
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

async function hook(b: Box, args: string[], entrypoint?: string, cwd = b.project) {
  return run(["hook", ...args], { cwd, env: b.env, ...(entrypoint ? { entrypoint } : {}) });
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

describe("hook install / status / uninstall", () => {
  it("--scope project installs all three targets under the project; status sees them; a second install changes no byte", async () => {
    const b = box();
    const bin = fakeBin(b);
    const r = await hook(b, ["install", "--scope", "project"], bin);
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
    expect(r.stdout).toContain(`codex_features: "not set (needs [features] hooks = true in ~/.codex/config.toml; run hook install --scope user or set it yourself)"`);
    const settings = JSON.parse(readFileSync(join(b.project, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", command: bin, timeout: 10 });
    expect(r.stdout).toContain("Run `agent-recall-axi hook status --scope project` to check it");
    // nothing landed in the user scope
    expect(existsSync(join(b.home, ".claude"))).toBe(false);

    const st = await hook(b, ["status", "--scope", "project"], bin);
    expect(st.exitCode).toBe(0);
    expect(st.stdout).toMatch(/^hook: installed \(project scope\)$/m);
    expect(st.stdout.match(/,installed$/gm)).toHaveLength(3);
    expect(st.stdout).toContain("codex_features: ");

    const before = tree(join(b.home, ".."));
    const again = await hook(b, ["install", "--scope", "project"], bin);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/^hook: already installed \(project scope; no changes\)$/m);
    expect(again.stdout.match(/,unchanged$/gm)).toHaveLength(3);
    expect(tree(join(b.home, ".."))).toEqual(before);
  });

  it("user scope is the default and writes each agent's home config", async () => {
    const b = box();
    const bin = fakeBin(b);
    const r = await hook(b, ["install"], bin);
    expect(r.stdout).toMatch(/^hook: installed \(user scope\)$/m);
    expect(r.stdout).toContain("claude,~/.claude/settings.json,added");
    expect(r.stdout).toContain("codex,~/.codex/hooks.json,added");
    expect(r.stdout).toContain("opencode,~/.config/opencode/plugins/axi-agent-recall-axi.js,added");
    expect(r.stdout).toContain("codex_features: ~/.codex/config.toml (hooks = true)");
    expect(r.stdout).toContain("Run `agent-recall-axi hook status` to check it");
    expect(readdirSync(b.project)).toEqual([]);
  });

  it("uninstall removes only marker-matched entries and leaves an unrelated hook and every other setting intact", async () => {
    const b = box();
    const bin = fakeBin(b);
    const settingsPath = join(b.project, ".claude", "settings.json");
    mkdirSync(join(b.project, ".claude"));
    writeFileSync(settingsPath, `${JSON.stringify(PRE_EXISTING, null, 2)}\n`);
    await hook(b, ["install", "--scope", "project"], bin);
    const installed = JSON.parse(readFileSync(settingsPath, "utf8"));
    expect(installed.hooks.SessionStart).toHaveLength(2);
    expect(installed.hooks.Stop).toEqual(PRE_EXISTING.hooks.Stop);

    const u = await hook(b, ["uninstall", "--scope", "project"], bin);
    expect(u.exitCode).toBe(0);
    expect(u.stdout).toMatch(/^hook: removed \(project scope\)$/m);
    expect(u.stdout.match(/,removed$/gm)).toHaveLength(3);
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(PRE_EXISTING);
    expect(existsSync(join(b.project, ".opencode", "plugins", "axi-agent-recall-axi.js"))).toBe(false);

    const st = await hook(b, ["status", "--scope", "project"], bin);
    expect(st.stdout).toMatch(/^hook: not installed \(project scope\)$/m);
    expect(st.stdout).toContain("Run `agent-recall-axi hook install --scope project` to install it");
    const again = await hook(b, ["uninstall", "--scope", "project"], bin);
    expect(again.stdout).toMatch(/^hook: nothing to remove \(project scope\)$/m);
    expect(again.stdout).toContain("Run `agent-recall-axi hook status --scope project` to confirm");
    expect(again.stdout).toContain("Run `agent-recall-axi hook install --scope project` to add it back");
    expect(JSON.parse(readFileSync(settingsPath, "utf8"))).toEqual(PRE_EXISTING);
  });

  it("--agent installs one target, and the three single-agent installs write the same bytes as one full install", async () => {
    const full = box();
    const each = box();
    // the same entrypoint path for both, so the command strings agree
    const bin = fakeBin(full);
    for (const agent of ["claude", "codex", "opencode"]) {
      const r = await hook(each, ["install", "--scope", "project", "--agent", agent], bin);
      expect(r.exitCode).toBe(0);
      expect(r.stdout.match(/^ {2}\w+,/gm)).toHaveLength(1);
      expect(r.stdout).toContain(`${agent},`);
    }
    await hook(full, ["install", "--scope", "project"], bin);
    const rel = (b: Box) => new Map([...tree(join(b.home, "..")).entries()].filter(([p]) => !p.includes("/lib/")).map(([p, h]) => [p.slice(join(b.home, "..").length), h]));
    expect(rel(each)).toEqual(rel(full));
    const one = box();
    await hook(one, ["install", "--scope", "project", "--agent", "claude"], bin);
    expect(existsSync(join(one.project, ".codex"))).toBe(false);
    expect(existsSync(join(one.project, ".opencode"))).toBe(false);
    expect(existsSync(join(one.home, ".codex"))).toBe(false);
  });

  it("a moved binary shows as stale and the next install repairs the path in place", async () => {
    const b = box();
    const first = fakeBin(b);
    await hook(b, ["install", "--scope", "project"], first);
    const moved = fakeBin(b, "moved");
    const st = await hook(b, ["status", "--scope", "project"], moved);
    expect(st.stdout).toMatch(/^hook: stale \(project scope\)$/m);
    expect(st.stdout.match(/,stale$/gm)).toHaveLength(3);
    expect(st.stdout).toContain(`command: ${first}`);
    expect(st.stdout).toContain("to repair it");
    const r = await hook(b, ["install", "--scope", "project"], moved);
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
    const r = await hook(b, ["install", "--scope", "project", "--agent", "claude"], bin);
    expect(r.stdout).toContain(`command: ${bin}`); // the box's PATH does not hold the link
    const linked = await run(["hook", "install", "--scope", "project", "--agent", "codex"], { cwd: b.project, env: { ...b.env, PATH: pathDir }, entrypoint: bin });
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
      const r = await hook(b, ["install", "--scope", "project"], entry);
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
    const r = await run(["hook", "install", "--scope", "project"], { cwd: b.project, env: { ...b.env, AGENT_RECALL_AXI_DISABLE_HOOKS: "1" }, entrypoint: bin });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^hook: disabled by AGENT_RECALL_AXI_DISABLE_HOOKS=1 \(no changes\)$/m);
    expect(tree(join(b.home, ".."))).toEqual(before);
  });

  it("a settings file that does not parse is left alone; the other targets proceed; exit 1", async () => {
    const b = box();
    const bin = fakeBin(b);
    mkdirSync(join(b.project, ".claude"));
    writeFileSync(join(b.project, ".claude", "settings.json"), "{ not json");
    const r = await hook(b, ["install", "--scope", "project"], bin);
    expect(r.exitCode).toBe(1);
    // An errored target means the headline never claims success.
    expect(r.stdout).toMatch(/^hook: "?partly installed \(project scope; see errors\)"?$/m);
    expect(r.stdout).toMatch(/^ {2}claude,.*,"?error: /m);
    expect(r.stdout).toMatch(/codex,.*,added$/m);
    expect(readFileSync(join(b.project, ".claude", "settings.json"), "utf8")).toBe("{ not json");
  });

  it("an OpenCode plugin file it did not write is left in place, on install and uninstall", async () => {
    const b = box();
    const bin = fakeBin(b);
    const plugin = join(b.project, ".opencode", "plugins", "axi-agent-recall-axi.js");
    mkdirSync(join(b.project, ".opencode", "plugins"), { recursive: true });
    writeFileSync(plugin, "// hand-written\n");
    const r = await hook(b, ["install", "--scope", "project"], bin);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("opencode,");
    expect(r.stdout).toContain("unmanaged (left in place)");
    const u = await hook(b, ["uninstall", "--scope", "project"], bin);
    expect(u.exitCode).toBe(0);
    expect(u.stdout).toContain("unmanaged (left in place)");
    expect(readFileSync(plugin, "utf8")).toBe("// hand-written\n");
  });

  it("validates its subcommand and flags before touching a file", async () => {
    const b = box();
    const bin = fakeBin(b);
    const cases: Array<[string[], number, RegExp]> = [
      [[], 2, /^code: USAGE$/m],
      [["frobnicate"], 2, /^code: USAGE$/m],
      [["install", "--scope", "global"], 2, /^code: VALIDATION_ERROR$/m],
      [["install", "--agent", "cursor"], 2, /^code: VALIDATION_ERROR$/m],
      [["status", "--agent", "claude"], 2, /^code: UNKNOWN_FLAG$/m],
      [["uninstall", "extra"], 2, /^code: USAGE$/m],
    ];
    for (const [args, code, re] of cases) {
      const r = await hook(b, args, bin);
      expect(r.exitCode, args.join(" ")).toBe(code);
      expect(r.stdout, args.join(" ")).toMatch(re);
    }
    const help = await hook(b, ["install", "--help"], bin);
    expect(help.stdout).toMatch(/^command: hook$/m);
    expect(readdirSync(b.project)).toEqual([]);
    expect(readdirSync(b.home)).toEqual(["lib"]);
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
    const r = await hook(b, ["install", "--scope", "project", "--agent", "claude"], bin);
    expect(r.stdout).toContain(",added");
    expect(commands(p)).toEqual([...theirs, bin]);
    const u = await hook(b, ["uninstall", "--scope", "project"], bin);
    expect(u.stdout).toMatch(/claude,.*,removed$/m);
    expect(JSON.parse(readFileSync(p, "utf8"))).toEqual(doc);
    const st = await hook(b, ["status", "--scope", "project"], bin);
    expect(st.stdout).toMatch(/claude,.*,absent$/m);
  });

  it("recognises its own entry quoted, repairs it, and drops a duplicate", async () => {
    const b = box();
    const bin = fakeBin(b);
    const old = "/old/place/dist/bin/agent-recall-axi.js";
    const doc = { hooks: { SessionStart: [{ matcher: "", hooks: [{ type: "command", command: `'${old}'`, timeout: 10 }] }, { matcher: "", hooks: [{ type: "command", command: `"${old}"` }] }] } };
    const p = settingsFile(b, JSON.stringify(doc, null, 2));
    const st = await hook(b, ["status", "--scope", "project"], bin);
    expect(st.stdout).toMatch(/claude,.*,stale$/m);
    await hook(b, ["install", "--scope", "project", "--agent", "claude"], bin);
    expect(commands(p)).toEqual([bin]);
  });

  it("quotes a command whose path has a space for the shell targets, and the hook runs", async () => {
    const b = box();
    const dir = join(b.home, "my tools", "dist", "bin");
    mkdirSync(dir, { recursive: true });
    const bin = join(dir, "agent-recall-axi.js");
    writeFileSync(bin, `#!/bin/sh\necho ran-$1\n`);
    chmodSync(bin, 0o755);
    const r = await hook(b, ["install", "--scope", "project"], bin);
    expect(r.exitCode).toBe(0);
    const quoted = `'${bin}'`;
    expect(r.stdout).toContain(`command: ${quoted}\n`);
    const claude = commands(join(b.project, ".claude", "settings.json"));
    expect(claude).toEqual([quoted]);
    expect(commands(join(b.project, ".codex", "hooks.json"))).toEqual([quoted]);
    expect(readFileSync(join(b.project, ".opencode", "plugins", "axi-agent-recall-axi.js"), "utf8")).toContain(`const command = ${JSON.stringify(bin)};`);
    expect(spawnSync("/bin/sh", ["-c", claude[0]!], { encoding: "utf8" }).stdout).toBe("ran-\n");
    const st = await hook(b, ["status", "--scope", "project"], bin);
    expect(st.stdout.match(/,installed$/gm)).toHaveLength(3);
    const again = await hook(b, ["install", "--scope", "project"], bin);
    expect(again.stdout).toMatch(/^hook: already installed/m);
    const u = await hook(b, ["uninstall", "--scope", "project"], bin);
    expect(u.stdout.match(/,removed$/gm)).toHaveLength(3);
  });

  it("a settings file of the wrong shape is an error, not overwritten", async () => {
    for (const text of ["[]", '{"hooks":[]}', '{"hooks":{"SessionStart":{}}}', '"text"', "null", '{"hooks":null}']) {
      const b = box();
      const bin = fakeBin(b);
      const p = settingsFile(b, text);
      const r = await hook(b, ["install", "--scope", "project", "--agent", "claude"], bin);
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
      await hook(b, ["install", "--scope", "project", "--agent", "claude"], bin);
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
    const r = await run(["hook", "install"], { cwd: b.project, env, entrypoint: bin });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("claude,~/cc/settings.json,added");
    expect(r.stdout).toContain("codex,~/cx/hooks.json,added");
    expect(r.stdout).toContain("opencode,~/xdg/opencode/plugins/axi-agent-recall-axi.js,added");
    expect(r.stdout).toContain("codex_features: ~/cx/config.toml (hooks = true)");
    for (const d of [".claude", ".codex", ".config"]) expect(existsSync(join(b.home, d)), d).toBe(false);
    const st = await run(["hook", "status"], { cwd: b.project, env, entrypoint: bin });
    expect(st.stdout.match(/,installed$/gm)).toHaveLength(3);
    const u = await run(["hook", "uninstall"], { cwd: b.project, env, entrypoint: bin });
    expect(u.stdout.match(/,removed$/gm)).toHaveLength(3);
  });

  it("project scope reports the Codex flag as on when the user's config already has it", async () => {
    const b = box();
    const bin = fakeBin(b);
    mkdirSync(join(b.home, ".codex"));
    writeFileSync(join(b.home, ".codex", "config.toml"), "[features]\nhooks = true\n");
    const r = await hook(b, ["install", "--scope", "project", "--agent", "codex"], bin);
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
      const r = await hook(b, ["install", "--agent", "codex"], bin);
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
      const r = await hook(b, ["install", "--agent", "codex"], bin);
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

describe("nothing but hook install writes a settings file (privacy.md)", () => {
  it("every other command, the home view in hook mode, and hook status/uninstall leave HOME and the project untouched", async () => {
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
      ["hook", "status"],
      ["hook", "status", "--scope", "project"],
      ["hook", "uninstall"],
      ["hook", "uninstall", "--scope", "project"],
    ];
    const covered = new Set(invocations.map((a) => a[0]).filter(Boolean));
    for (const g of COMMAND_GROUPS) for (const c of g.commands) expect(covered.has(c.name), c.name).toBe(true);
    for (const args of invocations) {
      await run(args, { cwd: args[0] === "hook" ? b.project : "/src/widget", env: b.env, entrypoint: bin });
    }
    for (const c of COMMAND_GROUPS.flatMap((g) => g.commands)) await run([c.name, "--help"], { env: b.env, entrypoint: bin });
    for (const payload of ['{"session_id":"x","source":"compact"}', `{"session_id":"${id}","source":"compact"}`, "garbage"]) {
      await homeWith(payload, { cwd: "/src/widget", env: b.env });
    }
    // user-scope status/uninstall with the log root as CLAUDE_CONFIG_DIR read it, never write it
    await run(["hook", "uninstall"], { cwd: b.project, env: { ...b.env, CLAUDE_CONFIG_DIR: FIXTURE_ROOT }, entrypoint: bin });
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
    const listing = await run([]);
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

  it("the exact command string hook install wrote, run the way Claude Code runs it, prints the resume pack after compact", async () => {
    const b = box();
    // A real project directory with a session in a private log root.
    const logRoot = join(b.home, "claude-config");
    const s8 = "ea00002a";
    const encoded = b.project.replace(/[^A-Za-z0-9]/g, "-");
    mkdirSync(join(logRoot, "projects", encoded), { recursive: true });
    const sessionId = `${s8}-0000-4000-8000-000000000000`;
    writeFileSync(join(logRoot, "projects", encoded, `${sessionId}.jsonl`), resumeSession(s8).replaceAll('"cwd":"/src/widget"', `"cwd":${JSON.stringify(b.project)}`));
    const r = await hook(b, ["install", "--scope", "project", "--agent", "claude"], BIN_JS);
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
