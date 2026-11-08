import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildLarge } from "./fixtures/build.js";
import { fx, run } from "./helpers/run.js";
import { shellPath } from "../src/commands/common.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-cli-"));
const long = join(tmp, "f0000099-0000-4000-8000-000000000000.jsonl");
beforeAll(async () => {
  await buildLarge(long, 200_000);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A cache directory no other test has written: for outputs that depend on the cache being absent. */
let caches = 0;
const freshCache = () => join(tmp, `cache-${++caches}`);

const rowLines = (out: string, label: string) => {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`${label}[`));
  if (i === -1) return [];
  const n = Number(/\[(\d+)\]/.exec(lines[i]!)![1]);
  return lines.slice(i + 1, i + 1 + n);
};

describe("events", () => {
  it("prints events[N]{id,t,kind,text} with full ids and a day: header for a one-day session", async () => {
    const { stdout, exitCode } = await run(["events", fx("parallel-tools")]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("events[7]{id,t,kind,text}:");
    expect(stdout).toMatch(/^session: "?a3000003/m);
    expect(stdout).toMatch(/^day: 2026-11-07$/m);
    expect(stdout).toMatch(/^tz: UTC$/m);
    expect(stdout).toMatch(/^count: 7 of 7$/m);
    const rows = rowLines(stdout, "events");
    expect(rows[0]).toMatch(/^ {2}"a3000003:1","13:40:02",human,/);
    expect(stdout).toContain("Bash bun test src/widget.test.ts → error 42");
    expect(stdout).toContain("Read config/staging.env → ok 77");
    expect(stdout).toContain("Edit src/widget.ts → pending");
    // thinking and result rows are hidden by default
    expect(rows.some((r) => r.includes(",result,"))).toBe(false);
  });

  it("uses MM-DD HH:MM:SS and days: for a two-day session", async () => {
    const { stdout } = await run(["events", fx("two-day")]);
    expect(stdout).toMatch(/^days: 2026-11-07\.\.2026-11-08$/m);
    expect(stdout).toContain('"b1000011:3","11-08 00:05:02",human,');
    expect(stdout).not.toMatch(/^day:/m);
  });

  it("--kind all shows thinking and result rows", async () => {
    const def = await run(["events", fx("thinking")]);
    expect(def.stdout).not.toContain(",thinking,");
    const all = await run(["events", fx("thinking"), "--kind", "all"]);
    expect(all.stdout).toContain(",thinking,The flange loop allocates on every pass.");
    const res = await run(["events", fx("parallel-tools"), "--kind=all"]);
    expect(res.stdout).toContain(',result,"error: FAIL src/widget.test.ts   expected 2 got 3"');
    const only = await run(["events", fx("parallel-tools"), "--kind", "result"]);
    expect(rowLines(only.stdout, "events")).toHaveLength(3);
  });

  it("selects by position with ids (inclusive start, exclusive end) and by time", async () => {
    const byId = await run(["events", fx("parallel-tools"), "--from", "a3000003:3", "--to", "a3000003:9"]);
    const ids = rowLines(byId.stdout, "events").map((r) => r.split(",")[0]);
    expect(ids).toEqual(['  "a3000003:3"', '  "a3000003:4"', '  "a3000003:6"']);
    const byTime = await run(["events", fx("two-day"), "--from", "2026-11-08"]);
    expect(rowLines(byTime.stdout, "events")).toHaveLength(2);
    const since = await run(["events", fx("two-day"), "--since", "30m"], { now: new Date("2026-11-08T00:30:00Z") });
    expect(rowLines(since.stdout, "events")).toHaveLength(2);
  });

  it("--since with --from is a usage error whose hint is valid grammar", async () => {
    const both = await run(["events", fx("two-day"), "--since", "7d", "--from", "today"]);
    expect(both.exitCode).toBe(2);
    expect(both.stdout).toMatch(/^code: USAGE$/m);
    expect(both.stdout).toContain("usage: agent-session-axi events <session>");
    expect(both.stdout).toContain("--from -7d starts at the beginning of the local day");
    expect(both.stdout).not.toContain("now-7d");
    const hinted = await run(["events", fx("two-day"), "--from", "-7d"]);
    expect(hinted.exitCode).toBe(0);
  });

  it("a session file not named by a uuid still prints ids that round-trip", async () => {
    const renamed = join(tmp, "my-log.jsonl");
    copyFileSync(fx("parallel-tools"), renamed);
    const first = await run(["events", renamed]);
    expect(first.exitCode).toBe(0);
    const s8 = /^session: "?([0-9a-f]{8}) /m.exec(first.stdout)![1]!;
    const rows = rowLines(first.stdout, "events");
    const third = /^ {2}"([^"]+)"/.exec(rows[2]!)![1]!;
    expect(third).toMatch(new RegExp(`^${s8}:\\d+`));
    const again = await run(["events", renamed, "--from", third]);
    expect(again.exitCode).toBe(0);
    expect(rowLines(again.stdout, "events")[0]).toBe(rows[2]);
  });

  it("paging hints carry the caller's view and the far bound", async () => {
    const path = shellPath(fx("parallel-tools"));
    const back = await run(["events", fx("parallel-tools"), "--kind", "call,human", "--limit", "2", "--head", "50", "--tz", "Asia/Tokyo"]);
    expect(back.stdout).toContain(`Run \`agent-session-axi events ${path} --to a3000003:4 --kind call,human --limit 2 --head 50 --tz Asia/Tokyo\` for earlier rows`);
    const fwd = await run(["events", fx("parallel-tools"), "--from", "a3000003:2", "--to", "a3000003:9", "--limit", "1"]);
    expect(fwd.stdout).toContain(`Run \`agent-session-axi events ${path} --from a3000003:3 --to a3000003:9 --limit 1\` for later rows`);
    const tail = await run(["tail", fx("parallel-tools"), "2", "--kind", "call"]);
    expect(tail.stdout).toContain(`Run \`agent-session-axi prev a3000003:4 --session ${path} --kind call --limit 2\` for earlier rows`);
  });

  it("the cut note is a complete command that shows those rows whole", async () => {
    const path = fx("string-content");
    const cut = await run(["events", path, "--head", "10"]);
    const note = cut.stdout.split("\n").find((l) => l.includes("cut to 10 chars"))!;
    expect(note).toMatch(/^ {2}Run `agent-session-axi events \S+ --from a1000001:2 --to a1000001:6 --full` for the whole text of the 4 rows cut to 10 chars$/);
    const cmd = /`agent-session-axi (.*)`/.exec(note)![1]!.split(" ");
    const whole = await run(cmd);
    expect(whole.exitCode).toBe(0);
    expect(rowLines(whole.stdout, "events")).toHaveLength(4);
    expect(whole.stdout).toContain("keep the old redirect for staging");
  });

  it("an empty session says so, with the malformed count in the header, exit 0", async () => {
    const { stdout, exitCode } = await run(["events", fx("silent")]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^malformed: 1 line$/m);
    expect(stdout).toMatch(/^events: 0 events in af00000f/m);
  });

  it("unknown flags fail with the valid set inline (exit 2)", async () => {
    const { stdout, exitCode } = await run(["events", fx("thinking"), "--bogus"]);
    expect(exitCode).toBe(2);
    expect(stdout).toMatch(/^error: unknown flag --bogus for `events`$/m);
    expect(stdout).toMatch(/^code: UNKNOWN_FLAG$/m);
    expect(stdout).toContain("valid flags for `events`: --from, --to, --since, --kind, --limit, --head, --full");
    const renamed = await run(["events", fx("thinking"), "--until", "now"]);
    expect(renamed.stdout).toContain("use --to");
  });

  it("a leading flag gets the SDK's error", async () => {
    const { stdout, exitCode } = await run(["--kind", "all", "events"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("Flags must come after the command");
  });

  it("validates values before opening files", async () => {
    const bad = await run(["events", "/does/not/exist.jsonl", "--from", "whenever"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    const missing = await run(["events", "/does/not/exist.jsonl"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toMatch(/^code: NOT_FOUND$/m);
    const kind = await run(["events", fx("thinking"), "--kind", "humans"]);
    expect(kind.exitCode).toBe(2);
  });

  it("--tz changes rendered times and the tz header; TZ is honored without the flag", async () => {
    const tokyo = await run(["events", fx("two-day"), "--tz", "Asia/Tokyo"]);
    expect(tokyo.stdout).toMatch(/^tz: Asia\/Tokyo$/m);
    expect(tokyo.stdout).toMatch(/^day: 2026-11-08$/m); // both days fall on 11-08 in Tokyo
    expect(tokyo.stdout).toContain('"b1000011:1","08:50:02"');
    const env = await run(["events", fx("two-day")], { env: { TZ: "Asia/Tokyo" } });
    expect(env.stdout).toBe(tokyo.stdout.replace(/ --tz Asia\/Tokyo/g, ""));
    const ny = await run(["events", fx("parallel-tools"), "--tz", "America/New_York"]);
    expect(ny.stdout).toContain('"a3000003:1","08:40:02"');
  });

  it("output is deterministic for the same file and arguments", async () => {
    const a = await run(["events", fx("compaction"), "--kind", "all"]);
    const b = await run(["events", fx("compaction"), "--kind", "all"], { now: new Date("2030-01-01T00:00:00Z") });
    expect(a.stdout).toBe(b.stdout);
    expect(a.stdout).toContain('compaction,"compacted auto 998.6k→25.1k, summary a6000006:4"');
  });
});

describe("tail", () => {
  it("prints the last 20 visible rows by default", async () => {
    // A fresh cache: no offset table, so the count is the honest fallback.
    const { stdout, exitCode } = await run(["tail", long], { env: { XDG_CACHE_HOME: freshCache() } });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("tail[20]{id,t,kind,text}:");
    expect(stdout).toMatch(/^count: 20 \(newest; earlier rows exist\)$/m);
    expect(stdout).toMatch(/Run `agent-session-axi prev f0000099:\d+ --session .*` for earlier rows/);
  });

  it("`tail <s> 5` and `--limit 5` agree", async () => {
    const a = await run(["tail", long, "5"]);
    const b = await run(["tail", long, "--limit", "5"]);
    expect(a.stdout).toBe(b.stdout);
    expect(rowLines(a.stdout, "tail")).toHaveLength(5);
    const clash = await run(["tail", long, "5", "--limit", "6"]);
    expect(clash.exitCode).toBe(2);
  });

  it("tail rows equal the last rows of a full forward listing", async () => {
    const t = rowLines((await run(["tail", long, "30", "--kind", "all"])).stdout, "tail");
    const e = rowLines((await run(["events", long, "--kind", "all", "--limit", "0"])).stdout, "events");
    expect(t).toEqual(e.slice(-30));
  });

  it("an exact count when only silent lines precede the n-th row", async () => {
    // string-content opens with a silent permission-mode line, then exactly 4 visible rows.
    const env = { XDG_CACHE_HOME: freshCache() };
    const { stdout } = await run(["tail", fx("string-content"), "4"], { env });
    expect(stdout).toMatch(/^count: 4 of 4$/m);
    expect(stdout).not.toContain("for earlier rows");
    const three = await run(["tail", fx("string-content"), "3"], { env });
    expect(three.stdout).toMatch(/^count: 3 \(newest; earlier rows exist\)$/m);
  });

  it("a session shorter than n shows everything with an exact count", async () => {
    const { stdout } = await run(["tail", fx("hooks")]);
    expect(stdout).toMatch(/^count: 7 of 7$/m);
  });
});

describe("sessions and home", () => {
  it("lists the current project's sessions with the minimal schema", async () => {
    const { stdout, exitCode } = await run(["sessions", "--limit", "3"]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^project: \/src\/widget \(22 sessions\)$/m);
    expect(stdout).toMatch(/^count: 3 of 22$/m);
    expect(stdout).toContain("sessions[3]{id,started,last,turns,title}:");
    expect(stdout).toContain('b1000011,"11-07 23:50","11-08 00:05 (0s ago)",2,start the overnight widget migration');
  });

  it("--subagents adds kind and parent; --fields adds columns", async () => {
    const { stdout } = await run(["sessions", "--subagents", "--limit", "0", "--fields", "uuid"]);
    expect(stdout).toContain("{id,started,last,turns,title,kind,parent,uuid}");
    expect(stdout).toMatch(/ae0f1e2d,.*,subagent,ae00000e,ae0f1e2d3c4b5a697/);
    const bad = await run(["sessions", "--fields", "turns"]);
    expect(bad.exitCode).toBe(2);
  });

  it("--project /nonexistent → NO_SESSIONS naming --project and --all, no stack trace", async () => {
    const { stdout, exitCode } = await run(["sessions", "--project", "/nonexistent"]);
    expect(exitCode).toBe(1);
    expect(stdout).toMatch(/^code: NO_SESSIONS$/m);
    expect(stdout).toContain("--project <path>");
    expect(stdout).toContain("--all");
    expect(stdout).not.toMatch(/\n\s+at /);
  });

  it("the home view lists the project's sessions, or every project's when the cwd has none", async () => {
    const here = await run([]);
    expect(here.stdout).toMatch(/^description: /m);
    expect(here.stdout).toMatch(/^project: \/src\/widget \(22 sessions\)$/m);
    expect(here.stdout).toContain("sessions[5]{id,last,turns,title}:");
    // Committed fixtures share their checkout mtime, so which is latest is not fixed here (home.test.ts sets mtimes).
    expect(here.stdout).toMatch(/^latest: [0-9a-f]{8}$/m);
    const none = await run([], { cwd: "/elsewhere" });
    expect(none.stdout).toMatch(/^project: none for \/elsewhere$/m);
    expect(none.stdout).toContain("sessions[5]{id,last,turns,title}:");
  });
});

describe("help, planned commands, update", () => {
  it("--help lists commands, marks none planned once every plan has landed, and shows no SDK built-in block", async () => {
    const { stdout } = await run(["--help"]);
    expect(stdout).toContain("events <session>");
    expect(stdout).toContain("hook install [--scope user|project]");
    expect(stdout).not.toContain("(planned:");
    expect(stdout).not.toContain("built-in");
    const cmd = await run(["events", "--help"]);
    expect(cmd.stdout).toMatch(/^command: events$/m);
    expect(cmd.stdout).toContain("--window <k|last|all>");
    const short = await run(["tail", "-h"]);
    expect(short.stdout).toMatch(/^command: tail$/m);
  });

  it("a usage error carries the command's usage line", async () => {
    // `hook` with no subcommand fails before it reads or writes any file.
    const { stdout, exitCode } = await run(["hook"]);
    expect(exitCode).toBe(2);
    // errors.md#codes: a USAGE error's help is the command's usage line.
    expect(stdout).toContain("usage: agent-session-axi hook install [--scope user|project] [--agent claude|codex|opencode] | hook status");
    const missing = await run(["events", fx("thinking"), "--limit"]);
    expect(missing.exitCode).toBe(2);
    expect(missing.stdout).toContain("usage: agent-session-axi events <session> [--from <when|id>]");
  });

  it("update and update --check print the version and both update commands", async () => {
    const npm = await run(["update"], { entrypoint: "/usr/lib/node_modules/agent-session-axi/dist/bin/agent-session-axi.js" });
    expect(npm.exitCode).toBe(0);
    expect(npm.stdout).toMatch(/^update: agent-session-axi \S+ \(npm install\)$/m);
    expect(npm.stdout.indexOf("npm i -g")).toBeLessThan(npm.stdout.indexOf("npx skills update"));
    const skill = await run(["update", "--check"], { entrypoint: "/opt/agents/skills/agent-session-axi/scripts/agent-session-axi.mjs" });
    expect(skill.exitCode).toBe(0);
    expect(skill.stdout).toMatch(/\(skill install\)/);
    expect(skill.stdout.indexOf("npx skills update")).toBeLessThan(skill.stdout.indexOf("npm i -g"));
  });
});

// Permission bits do not stop root, so these run only as an ordinary user (as on CI).
const asRoot = typeof process.getuid === "function" && process.getuid() === 0;

describe.skipIf(asRoot)("unreadable session files", () => {
  const root = join(tmp, "unreadable-root");
  const dir = join(root, "projects", "-src-widget");
  const locked = join(dir, "a1000001-0000-4000-8000-000000000000.jsonl");
  beforeAll(() => {
    mkdirSync(dir, { recursive: true });
    copyFileSync(fx("string-content"), locked);
    copyFileSync(fx("hooks"), join(dir, "aa00000a-0000-4000-8000-000000000000.jsonl"));
    chmodSync(locked, 0o000);
  });
  afterAll(() => chmodSync(locked, 0o644));
  const env = { CLAUDE_CONFIG_DIR: root };

  it("sessions and the home view skip it, count it, and name it", async () => {
    for (const args of [["sessions"], ["sessions", "--all"], []]) {
      const { stdout, exitCode } = await run(args, { env });
      expect(exitCode, args.join(" ")).toBe(0);
      expect(stdout).toMatch(/^unreadable: 1$/m);
      expect(stdout).toContain("aa00000a");
      expect(stdout).toContain(`Run \`ls -l ${locked}\``);
    }
  });

  it("resolved by prefix or latest, it is UNREADABLE (exit 1) with the path in details, not INTERNAL_ERROR", async () => {
    for (const args of [["tail", "a1000001"], ["events", "a1000001-0000-4000-8000-000000000000"], ["show", "a1000001:1"]]) {
      const { stdout, exitCode } = await run(args, { env });
      expect(exitCode, args.join(" ")).toBe(1);
      expect(stdout).toMatch(/^code: UNREADABLE$/m);
      expect(stdout).toMatch(/^details:\n {2}path: /m);
      expect(stdout).toContain(locked);
    }
  });

  it("tail and events on it → UNREADABLE (exit 1) with the path", async () => {
    for (const cmd of ["tail", "events"]) {
      const { stdout, exitCode } = await run([cmd, locked], { env });
      expect(exitCode).toBe(1);
      expect(stdout).toMatch(/^code: UNREADABLE$/m);
      expect(stdout).toContain(locked);
    }
  });
});

describe("formatError", () => {
  it("a permission error from a read maps to UNREADABLE with the path, never INTERNAL_ERROR", async () => {
    const { formatError } = await import("../src/cli.js");
    const err = Object.assign(new Error("EACCES: permission denied, open '/x/s.jsonl'"), { code: "EACCES", path: "/x/s.jsonl" });
    const r = formatError(err);
    expect(r.exitCode).toBe(1);
    expect(r.output).toMatch(/^code: UNREADABLE$/m);
    expect(r.output).toContain("path: /x/s.jsonl");
  });
});
