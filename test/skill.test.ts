/**
 * The skill channel (specs/architecture.md#the-skill-bundle, plans/skill-and-hook.md): the
 * committed bundle and shim, their drift gates, SKILL.md and its generated reference, and the
 * bundle running offline from a copy of the skill directory with no node_modules anywhere.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { buildBundle, bundleMatches, normalizeVersion, OUTFILE, stampArg } from "../scripts/build-cli.js";
import { commandReference, SKILL_MD, spliceSkill } from "../scripts/build-skill.js";
import { COMMAND_GROUPS, type CommandGroup } from "../src/reference.js";
import { FIXTURE_ROOT } from "./fixtures/build.js";
import { BIN_JS, fx, REPO } from "./helpers/run.js";

const node = process.execPath.includes("bun") ? "node" : process.execPath;
const SKILL_DIR = join(REPO, "skills", "agent-session-axi");
const SHIM = join(SKILL_DIR, "scripts", "agent-session-axi");
const tmp = mkdtempSync(join(tmpdir(), "asa-skill-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const committedBundle = () => readFileSync(OUTFILE, "utf8");

describe("the committed bundle", () => {
  it("imports nothing but node builtins: no bare package name, no require, no file read beside it", () => {
    const text = committedBundle();
    const specifiers = [...text.matchAll(/(?:^|[\s;])(?:import|export)\s[^;]*?\sfrom\s*"([^"]+)"|\bimport\(\s*"([^"]+)"\s*\)/gm)].map((m) => m[1] ?? m[2]!);
    expect(specifiers.length).toBeGreaterThan(0);
    expect(specifiers.filter((s) => !s.startsWith("node:"))).toEqual([]);
    expect(text).not.toMatch(/\brequire\(\s*["'][^"']+["']\s*\)/);
    expect(text).not.toMatch(/createRequire/);
    expect(text).not.toContain("package.json\"))"); // the version is stamped, not read
  });

  it("carries no module-path comments, so its bytes do not depend on the node_modules layout", () => {
    expect(committedBundle()).not.toMatch(/^\s*\/\/ (?:node_modules|src|bin)\//m);
  });

  it("bakes in no machine path", () => {
    const text = committedBundle();
    expect(text).not.toMatch(/\/(?:home|Users)\/(?!linuxbrew\b)[A-Za-z0-9._-]+\//);
    expect(text).not.toContain(REPO);
  });

  it("is executable, as is the shim, and both are committed that way", () => {
    for (const p of [OUTFILE, SHIM]) expect(statSync(p).mode & 0o111, p).toBe(0o111);
    const staged = execFileSync("git", ["ls-files", "-s", "skills/agent-session-axi/scripts"], { cwd: REPO, encoding: "utf8" });
    // Before the files are committed (a fresh branch), the working-tree bits above are the check.
    for (const line of staged.trim().split("\n").filter(Boolean)) expect(line.startsWith("100755"), line).toBe(true);
    expect(readFileSync(join(REPO, ".gitattributes"), "utf8")).toMatch(/^skills\/agent-session-axi\/scripts\/agent-session-axi\.mjs linguist-generated=true$/m);
  });

  it("check:bundle: matches a fresh build; fails on any other byte; passes when only the version moved", async () => {
    const committed = committedBundle();
    const fresh = await buildBundle("9.9.9-g0000000", false);
    expect(bundleMatches(fresh, committed)).toBe(true);
    expect(fresh).toContain('VERSION = true ? "9.9.9-g0000000" : readVersion()');
    // one emitted string changed, version untouched
    const edited = committed.replace("cannot tell which binary is running", "cannot tell which binary is runnin");
    expect(edited).not.toBe(committed);
    expect(bundleMatches(fresh, edited)).toBe(false);
    // a version change plus a real change is still a change
    const both = normalizeVersion(edited).replace('"__VERSION__"', '"1.2.3"');
    expect(bundleMatches(fresh, both)).toBe(false);
    // the normalization touches exactly one literal and refuses anything else
    expect(() => normalizeVersion("no version here")).toThrow(/found 0/);
    const doubled = `${committed}\nVERSION = true ? "x" : readVersion();`;
    expect(() => normalizeVersion(doubled)).toThrow(/found 2/);
    expect(normalizeVersion(committed).length).toBeLessThan(committed.length + 20);
  });

  it("--stamp sets the release version exactly and refuses anything else (RELEASING.md)", async () => {
    expect(stampArg([])).toBeUndefined();
    expect(stampArg(["--check"])).toBeUndefined();
    expect(stampArg(["--stamp", "0.1.0"])).toBe("0.1.0");
    expect(stampArg(["--stamp=0.2.0-rc.1"])).toBe("0.2.0-rc.1");
    for (const bad of [["--stamp"], ["--stamp", "v0.1.0"], ["--stamp=0.1"], ["--stamp", "0.1.0-g1234567"]]) expect(() => stampArg(bad), bad.join(" ")).toThrow(/--stamp takes a release version/);
    // a release-stamped build is still the committed bundle as far as check:bundle is concerned
    const released = await buildBundle("0.1.0", false);
    expect(released).toContain('VERSION = true ? "0.1.0" : readVersion()');
    expect(bundleMatches(released, committedBundle())).toBe(true);
  });

  it("check:bundle fails after a one-line source change and passes again on the unchanged tree", () => {
    const copy = join(tmp, "repo");
    for (const dir of ["bin", "src", "scripts"]) cpSync(join(REPO, dir), join(copy, dir), { recursive: true });
    for (const f of ["package.json", "tsconfig.json"]) cpSync(join(REPO, f), join(copy, f));
    mkdirSync(join(copy, "skills", "agent-session-axi", "scripts"), { recursive: true });
    cpSync(OUTFILE, join(copy, "skills", "agent-session-axi", "scripts", "agent-session-axi.mjs"));
    // The bundled packages as real copies (esbuild names modules by their real path); the
    // build tool itself only needs to resolve.
    for (const pkg of ["axi-sdk-js", "@toon-format"]) cpSync(join(REPO, "node_modules", pkg), join(copy, "node_modules", pkg), { recursive: true });
    for (const pkg of readdirSync(join(REPO, "node_modules")).filter((p) => p.includes("esbuild"))) symlinkSync(join(REPO, "node_modules", pkg), join(copy, "node_modules", pkg));
    const check = () => spawnSync("bun", [join(copy, "scripts", "build-cli.ts"), "--check"], { cwd: REPO, encoding: "utf8" });
    // not a git checkout: the stamp falls back to the package version, unlike the committed one
    const clean = check();
    expect(clean.stderr + clean.stdout).toMatch(/is up to date/);
    expect(clean.status).toBe(0);
    const file = join(copy, "src", "commands", "update.ts");
    writeFileSync(file, readFileSync(file, "utf8").replace("to update the skill bundle", "to update the skill bundle now"));
    const dirty = check();
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toMatch(/is out of date; run `bun run build:bundle`/);
  });
});

describe("SKILL.md", () => {
  const doc = readFileSync(SKILL_MD, "utf8");

  it("has trigger-shaped frontmatter with name and description", () => {
    const fm = /^---\n([\s\S]*?)\n---\n/.exec(doc)?.[1] ?? "";
    expect(fm).toMatch(/^name: agent-session-axi$/m);
    const description = /^description: (.+)$/m.exec(fm)?.[1] ?? "";
    for (const trigger of ["what was I doing", "have I dealt with this before", "what did the human ask"]) expect(description).toContain(trigger);
  });

  it("states the local-only rule near the top", () => {
    const body = doc.replace(/^---\n[\s\S]*?\n---\n/, "");
    const head = body.split("\n").slice(0, 15).join("\n");
    expect(head).toContain("It reads local files only and sends nothing");
  });

  it("check:skill: the generated region matches COMMAND_GROUPS, and a changed summary without regeneration fails", () => {
    expect(spliceSkill(doc)).toBe(doc);
    expect(doc).toContain(commandReference());
    for (const g of COMMAND_GROUPS) for (const c of g.commands) expect(doc).toContain(`\`scripts/agent-session-axi ${c.usage}\`: ${c.summary}`);
    const changed: CommandGroup[] = structuredClone(COMMAND_GROUPS);
    changed[0]!.commands[0]!.summary += " (edited)";
    expect(spliceSkill(doc, commandReference(changed))).not.toBe(doc);
    expect(() => spliceSkill(doc.replace("<!-- END GENERATED: command-reference -->", ""))).toThrow(/exactly one/);
    // the prose outside the markers is never touched
    const prose = doc.replace("## The zoom ladder", "## The zoom ladder (edited)");
    expect(spliceSkill(prose)).toBe(prose);
  });

  it("every example invokes the shim by its resolved path, never a bare binary name or a bare command word", () => {
    const spans = [...doc.matchAll(/`([^`\n]+)`/g)].map((m) => m[1]!);
    const words = new Set(["agent-session-axi", ...COMMAND_GROUPS.flatMap((g) => g.commands.map((c) => c.name))]);
    const bare = spans.filter((s) => words.has(s.split(/\s+/)[0]!) && s !== "agent-session-axi");
    expect(bare).toEqual([]);
    const invocations = spans.filter((s) => /^scripts\/agent-session-axi(\s|$)/.test(s));
    expect(invocations.length).toBeGreaterThan(20);
    const blocks = [...doc.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map((m) => m[1]!);
    for (const b of blocks) expect(b).not.toMatch(/^\s*agent-session-axi\s/m);
  });

  it("the skill directory holds only SKILL.md and scripts/ (the shim and the bundle)", () => {
    expect(readdirSync(SKILL_DIR).sort()).toEqual(["SKILL.md", "scripts"]);
    expect(readdirSync(join(SKILL_DIR, "scripts")).sort()).toEqual(["agent-session-axi", "agent-session-axi.mjs"]);
  });
});

describe("the skill, copied out of the repository, runs offline with node only", () => {
  // as `npx skills add` lays it out: …/skills/agent-session-axi/
  const copy = join(tmp, "installed", "skills", "agent-session-axi");
  cpSync(SKILL_DIR, copy, { recursive: true });
  const shim = join(copy, "scripts", "agent-session-axi");
  const linkDir = join(tmp, "path-bin");
  mkdirSync(linkDir, { recursive: true });
  symlinkSync(shim, join(linkDir, "agent-session-axi"));
  const cacheOf = (name: string) => join(tmp, `cache-${name}`);
  const baseEnv = (cache: string, extraPath = "") => ({
    PATH: `${extraPath}${join(node, "..")}:/usr/bin:/bin`,
    HOME: join(tmp, "home"),
    CLAUDE_CONFIG_DIR: FIXTURE_ROOT,
    XDG_CACHE_HOME: cache,
    TZ: "UTC",
  });
  let k = 0;
  const viaShim = (args: string[], opts: { onPath?: boolean; nodeOptions?: string } = {}) =>
    spawnSync(opts.onPath ? join(linkDir, "agent-session-axi") : shim, args, {
      cwd: tmp,
      encoding: "utf8",
      env: { ...baseEnv(cacheOf(`shim-${k++}`), opts.onPath ? `${linkDir}:` : ""), ...(opts.nodeOptions ? { NODE_OPTIONS: opts.nodeOptions } : {}) },
    });
  const viaDist = (args: string[]) => spawnSync(node, [BIN_JS, ...args], { cwd: tmp, encoding: "utf8", env: baseEnv(cacheOf(`dist-${k++}`)) });

  it("--version prints the stamped version, through the shim and through a symlink to it", () => {
    for (const onPath of [false, true]) {
      const r = viaShim(["--version"], { onPath });
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\n$/);
    }
  });

  it("tail, find and resume-pack match the dist/ outputs byte for byte", () => {
    const session = fx("compaction");
    for (const args of [["tail", session], ["find", session, "flange"], ["resume-pack", session], ["sessions", "--all", "--limit", "3"]]) {
      const a = viaShim(args, { onPath: true });
      const b = viaDist(args);
      expect(a.status, args.join(" ")).toBe(b.status);
      expect(a.stdout, args.join(" ")).toBe(b.stdout);
      expect(a.stdout.length).toBeGreaterThan(50);
    }
  });

  it("off PATH, hints name the shim by its path; update knows it is a skill install", () => {
    const r = viaShim(["sessions", "--all", "--limit", "1"]);
    expect(r.stdout).toContain(`Run \`${shim} `);
    expect(r.stdout).not.toMatch(/Run `agent-session-axi /);
    const u = viaShim(["update"]);
    expect(u.stdout).toMatch(/^update: .* \(skill install\)$/m);
  });

  it("the shim ignores an exported CDPATH, and says so clearly when node is missing or too old", () => {
    const quiet = join(tmp, "cdpath-target");
    mkdirSync(join(quiet, "scripts"), { recursive: true });
    const env = { ...baseEnv(cacheOf(`cd-${k++}`)), CDPATH: quiet };
    const r = spawnSync(join(linkDir, "agent-session-axi"), ["--version"], { cwd: tmp, encoding: "utf8", env });
    expect(r.status).toBe(0);
    expect(r.stdout).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\n$/);
    const bash = spawnSync("sh", ["-c", "command -v bash"], { encoding: "utf8" }).stdout.trim();
    const onlyBash = join(tmp, "only-bash");
    mkdirSync(onlyBash, { recursive: true });
    for (const tool of ["bash", "dirname", "readlink"]) {
      const at = spawnSync("sh", ["-c", `command -v ${tool}`], { encoding: "utf8" }).stdout.trim();
      if (at) symlinkSync(at, join(onlyBash, tool));
    }
    expect(bash).not.toBe("");
    const missing = spawnSync(shim, ["--version"], { cwd: tmp, encoding: "utf8", env: { PATH: onlyBash } });
    expect(missing.status).toBe(127);
    expect(missing.stderr).toMatch(/node 22 or newer is required/);
    const oldNode = join(tmp, "old-node");
    mkdirSync(oldNode, { recursive: true });
    writeFileSync(join(oldNode, "node"), "#!/bin/sh\necho v20.11.0\n");
    chmodSync(join(oldNode, "node"), 0o755);
    const old = spawnSync(shim, ["--version"], { cwd: tmp, encoding: "utf8", env: { PATH: `${oldNode}:${onlyBash}` } });
    expect(old.status).toBe(1);
    expect(old.stderr).toMatch(/node 22 or newer is required \(found v20\.11\.0\)/);
  });

  it("opens no socket", () => {
    const r = viaShim(["resume-pack", fx("compaction")], { nodeOptions: `--import ${join(REPO, "test", "helpers", "block-network.mjs")}` });
    expect(r.status).toBe(0);
    expect(/NETWORK_ATTEMPTS (.*)/.exec(r.stderr)?.[1]).toBe("[]");
  });
});
