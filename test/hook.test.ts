/**
 * The SessionStart hook (specs/cli.md#hook) and the home view's hook mode
 * (specs/cli.md#home-view-no-arguments), plans/skill-and-hook.md. Every install goes into a
 * throwaway HOME and project directory: process.env.HOME is pointed at the sandbox too, so even a
 * fallback to os.homedir() cannot reach a real settings file.
 */
import { spawnSync } from "node:child_process";
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
  return { home, project, env: { HOME: home, PATH: "/usr/bin:/bin", [`AGENT_SESSION_AXI_DISABLE_HOOKS`]: undefined } };
}

/** A runnable stand-in for the npm bin whose path names the marker. */
function fakeBin(b: Box, name = "agent-session-axi.js"): string {
  const dir = join(b.home, "lib", "node_modules", "agent-session-axi", "dist", "bin");
  mkdirSync(dir, { recursive: true });
  const p = join(dir, name);
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
      ["opencode", ".opencode/plugins/axi-agent-session-axi.js"],
    ] as const) {
      expect(r.stdout).toContain(`${agent},${join(b.project, rel)},added`);
      expect(existsSync(join(b.project, rel))).toBe(true);
    }
    // Codex reads its feature flag only from the user's config.
    expect(readFileSync(join(b.home, ".codex", "config.toml"), "utf8")).toContain("hooks = true");
    const settings = JSON.parse(readFileSync(join(b.project, ".claude", "settings.json"), "utf8"));
    expect(settings.hooks.SessionStart[0].hooks[0]).toEqual({ type: "command", command: bin, timeout: 10 });
    expect(r.stdout).toContain("Run `agent-session-axi hook status --scope project` to check it");
    // nothing landed in the user scope
    expect(existsSync(join(b.home, ".claude"))).toBe(false);

    const st = await hook(b, ["status", "--scope", "project"], bin);
    expect(st.exitCode).toBe(0);
    expect(st.stdout).toMatch(/^hook: installed \(project scope\)$/m);
    expect(st.stdout.match(/,installed$/gm)).toHaveLength(3);
    expect(st.stdout).toContain("(hooks = true)");

    const before = tree(join(b.home, ".."));
    const again = await hook(b, ["install", "--scope", "project"], bin);
    expect(again.exitCode).toBe(0);
    expect(again.stdout).toMatch(/^hook: "already installed \(project scope, no changes\)"$/m);
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
    expect(r.stdout).toContain("opencode,~/.config/opencode/plugins/axi-agent-session-axi.js,added");
    expect(r.stdout).toContain("codex_features: ~/.codex/config.toml (hooks = true)");
    expect(r.stdout).toContain("Run `agent-session-axi hook status` to check it");
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
    expect(existsSync(join(b.project, ".opencode", "plugins", "axi-agent-session-axi.js"))).toBe(false);

    const st = await hook(b, ["status", "--scope", "project"], bin);
    expect(st.stdout).toMatch(/^hook: not installed \(project scope\)$/m);
    expect(st.stdout).toContain("Run `agent-session-axi hook install --scope project` to install it");
    const again = await hook(b, ["uninstall", "--scope", "project"], bin);
    expect(again.stdout).toMatch(/^hook: nothing to remove \(project scope\)$/m);
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
    const moved = fakeBin(b, "agent-session-axi-moved.js");
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
    expect(readFileSync(join(b.project, ".opencode", "plugins", "axi-agent-session-axi.js"), "utf8")).toContain(JSON.stringify(moved));
  });

  it("the command is the bare name when agent-session-axi on PATH resolves to the running binary", async () => {
    const b = box();
    const bin = fakeBin(b);
    const pathDir = join(b.home, "bin");
    mkdirSync(pathDir);
    const { symlinkSync } = await import("node:fs");
    symlinkSync(bin, join(pathDir, "agent-session-axi"));
    expect(hookCommandString(bin, pathDir)).toBe("agent-session-axi");
    expect(hookCommandString(bin, "/usr/bin")).toBe(bin);
    const r = await hook(b, ["install", "--scope", "project", "--agent", "claude"], bin);
    expect(r.stdout).toContain(`command: ${bin}`); // the box's PATH does not hold the link
    const linked = await run(["hook", "install", "--scope", "project", "--agent", "codex"], { cwd: b.project, env: { ...b.env, PATH: pathDir }, entrypoint: bin });
    expect(linked.stdout).toMatch(/^command: agent-session-axi$/m);
  });

  it("run from the skill bundle, the hook runs the shim beside it", () => {
    const dir = join(sandbox, "skill", "scripts");
    mkdirSync(dir, { recursive: true });
    const bundle = join(dir, "agent-session-axi.mjs");
    writeFileSync(bundle, "");
    expect(hookExecPath(bundle)).toBe(bundle); // no executable shim yet
    writeFileSync(join(dir, "agent-session-axi"), "#!/bin/sh\n");
    chmodSync(join(dir, "agent-session-axi"), 0o755);
    expect(hookExecPath(bundle)).toBe(join(dir, "agent-session-axi"));
    expect(cliInvocation(bundle, "/usr/bin")).toBe(join(dir, "agent-session-axi"));
    expect(cliInvocation("/x/dist/bin/agent-session-axi.js", "/usr/bin")).toBe("agent-session-axi");
  });

  it("refuses a TypeScript entrypoint and a path that does not name the tool, writing nothing", async () => {
    const b = box();
    for (const entry of [join(b.home, "src", "bin", "agent-session-axi.ts"), join(b.home, "other-tool.js")]) {
      const r = await hook(b, ["install", "--scope", "project"], entry);
      expect(r.exitCode).toBe(2);
      expect(r.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
      expect(r.stdout).not.toMatch(/\n\s+at /);
    }
    expect(readdirSync(b.project)).toEqual([]);
    expect(readdirSync(b.home)).toEqual([]);
  });

  it("AGENT_SESSION_AXI_DISABLE_HOOKS=1 makes install a no-op", async () => {
    const b = box();
    const bin = fakeBin(b);
    const before = tree(join(b.home, ".."));
    const r = await run(["hook", "install", "--scope", "project"], { cwd: b.project, env: { ...b.env, AGENT_SESSION_AXI_DISABLE_HOOKS: "1" }, entrypoint: bin });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^hook: disabled by AGENT_SESSION_AXI_DISABLE_HOOKS=1 \(no changes\)$/m);
    expect(tree(join(b.home, ".."))).toEqual(before);
  });

  it("a settings file that does not parse is left alone; the other targets proceed; exit 1", async () => {
    const b = box();
    const bin = fakeBin(b);
    mkdirSync(join(b.project, ".claude"));
    writeFileSync(join(b.project, ".claude", "settings.json"), "{ not json");
    const r = await hook(b, ["install", "--scope", "project"], bin);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toMatch(/^ {2}claude,.*,"?error: /m);
    expect(r.stdout).toMatch(/codex,.*,added$/m);
    expect(readFileSync(join(b.project, ".claude", "settings.json"), "utf8")).toBe("{ not json");
  });

  it("an OpenCode plugin file it did not write is left in place, on install and uninstall", async () => {
    const b = box();
    const bin = fakeBin(b);
    const plugin = join(b.project, ".opencode", "plugins", "axi-agent-session-axi.js");
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

describe("nothing but hook install writes a settings file (privacy.md)", () => {
  it("every other command, the home view in hook mode, and hook status/uninstall leave HOME and the project untouched", async () => {
    const b = box();
    const bin = fakeBin(b);
    const before = tree(join(b.home, ".."));
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
      ["recall", "widget"],
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
    expect(tree(join(b.home, ".."))).toEqual(before);
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

  it("never hangs: a pipe nobody writes to, or a payload whose writer never closes, returns promptly", async () => {
    const t0 = Date.now();
    const silent = await homeWith(undefined);
    expect(silent.stdout).toMatch(/^sessions\[/m);
    const open = await homeWith(JSON.stringify({ session_id: id, source: "compact" }), { end: false });
    expect(open.stdout).toMatch(/^budget: .* of 6\.0k used$/m);
    // generous: two bounded reads (200 ms each at most) plus the work itself
    expect(Date.now() - t0).toBeLessThan(15_000);
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
    const t0 = Date.now();
    expect(await readHookStdin(slow, { firstByteMs: 50, totalMs: 100, maxBytes: 1024 })).toBe('{"session_id":');
    expect(Date.now() - t0).toBeLessThan(5_000);
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
