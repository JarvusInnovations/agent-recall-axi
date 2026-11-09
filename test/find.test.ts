import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { backtrackRisk, find, findListing, globRegex, streamMatches } from "../src/lib/find.js";
import { openSession } from "../src/lib/session.js";
import { FIND_DEEP_WORD } from "./fixtures/build.js";
import { fx, run } from "./helpers/run.js";

const S = "e1000018";

/** The rows of a `rows[N]` / `hits[N]` table as {id, kind, why, text}. */
function table(out: string): { label: string; rows: Array<{ id: string; kind: string; why: string; text: string }> } {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => /^(rows|hits)\[\d+\]\{/.test(l));
  if (i === -1) return { label: "", rows: [] };
  const label = lines[i]!.startsWith("rows") ? "rows" : "hits";
  const n = Number(/\[(\d+)\]/.exec(lines[i]!)![1]);
  const rows = lines.slice(i + 1, i + 1 + n).map((l) => {
    const m = /^ {2}"([^"]+)","[^"]*",([^,]+),("[^"]*"|[^,]*),(.*)$/.exec(l)!;
    return { id: m[1]!, kind: m[2]!, why: m[3]!.replace(/^"|"$/g, ""), text: m[4]! };
  });
  return { label, rows };
}
const hitIds = (out: string) => table(out).rows.filter((r) => r.why).map((r) => r.id);
const seq = (...n: number[]) => n.map((x) => `${S}:${x}`);

/** The commands in help[] lines, as argv for `run` (single-quoted args unquoted). */
function helpCommands(out: string): string[][] {
  const cmds: string[][] = [];
  for (const m of out.matchAll(/Run `agent-session-axi ([^`]+)`/g)) {
    const argv: string[] = [];
    for (const t of m[1]!.matchAll(/'((?:[^']|'\\'')*)'|(\S+)/g)) argv.push(t[1] !== undefined ? t[1].replace(/'\\''/g, "'") : t[2]!);
    cmds.push(argv);
  }
  return cmds;
}

describe("find: handles", () => {
  it("a phrase hits human, assistant, call input and a call through its result's text, case-insensitively", async () => {
    for (const phrase of ["redirect", "REDIRECT"]) {
      const r = await run(["find", S, phrase, "--context", "0"]);
      expect(r.exitCode).toBe(0);
      const { label, rows } = table(r.stdout);
      expect(label).toBe("hits");
      // :1 human, :2 assistant, :4 Read whose result holds OAUTH_REDIRECT, :6 Grep whose input does.
      expect(rows.map((x) => [x.id, x.kind, x.why])).toEqual([
        [`${S}:1`, "human", "phrase"],
        [`${S}:2`, "assistant", "phrase"],
        [`${S}:4`, "call", "phrase"],
        [`${S}:6`, "call", "phrase"],
      ]);
      // the thinking at :3 says REDIRECT too, but thinking is not searched by default
      expect(r.stdout).not.toContain(",thinking,");
    }
  });

  it("--file globs over the whole path and substrings without glob characters", async () => {
    const glob = await run(["find", S, "--file", "*.env", "--context", "0"]);
    expect(table(glob.stdout).rows.map((x) => [x.id, x.why])).toEqual([
      [`${S}:4`, "file"], // Read config/staging.env
      [`${S}:8`, "file"], // Bash grep -n HOST config/staging.env
      [`${S}:10`, "file"], // Edit config/staging.env
    ]);
    const sub = await run(["find", S, "--file", "staging", "--context", "0"]);
    expect(hitIds(sub.stdout)).toEqual(seq(4, 8, 10));
    // a glob is anchored: *.en matches nothing
    const anchored = await run(["find", S, "--file", "*.en", "--context", "0"]);
    expect(anchored.stdout).toMatch(/^hits: "?0 events match file \*\.en in e1000018/m);
  });

  it("--tool lists every call of a tool; with a phrase, why is phrase+tool", async () => {
    const all = await run(["find", S, "--tool", "bash", "--context", "0"]);
    expect(table(all.stdout).rows.map((x) => [x.id, x.kind, x.why])).toEqual([
      [`${S}:8`, "call", "tool"],
      [`${S}:12`, "call", "tool"],
      [`${S}:16`, "call", "tool"],
    ]);
    const both = await run(["find", S, "--tool", "bash", "test", "--context", "0"]);
    const rows = table(both.stdout).rows;
    expect(rows.map((x) => x.id)).toContain(`${S}:12`);
    expect(new Set(rows.map((x) => x.why))).toEqual(new Set(["phrase+tool"]));
    expect(both.stdout).toMatch(/^query: "phrase \\"test\\" \+ tool bash"$/m);
  });

  it("--kind human returns only human events, and kind joins why", async () => {
    const r = await run(["find", S, "--kind", "human", "deploy"]);
    const rows = table(r.stdout).rows;
    expect(rows.length).toBeGreaterThan(0);
    expect(new Set(rows.map((x) => x.kind))).toEqual(new Set(["human"]));
    expect(hitIds(r.stdout)).toEqual(seq(1, 14));
    expect(new Set(rows.filter((x) => x.why).map((x) => x.why))).toEqual(new Set(["phrase+kind"]));
  });

  it("--kind result searches results as rows of their own; calls stop matching their results", async () => {
    const r = await run(["find", fx("parallel-tools"), "expected 2 got 3", "--kind", "call,result", "--context", "0"]);
    expect(table(r.stdout).rows.map((x) => x.kind)).toEqual(["result"]);
    // by default the FAIL output (read 4 entries after its call) is found through the call row
    const d = await run(["find", fx("parallel-tools"), "expected 2 got 3", "--context", "0"]);
    expect(table(d.stdout).rows.map((x) => [x.kind, x.text])).toEqual([["call", "Bash bun test src/widget.test.ts → error 42"]]);
  });

  it("at least one handle is required (USAGE, exit 2)", async () => {
    const r = await run(["find", S]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/^code: USAGE$/m);
    for (const argv of helpCommands(r.stdout)) expect((await run(argv.map((a) => (a === "<phrase>" ? "redirect" : a)))).exitCode).toBe(0);
  });

  it("one positional is the session when it has a session reference's form, else the phrase", async () => {
    const asSession = await run(["find", fx("find"), "--tool", "edit"]);
    expect(asSession.exitCode).toBe(0);
    // A lone phrase searches the current project (cross-session scope).
    const asPhrase = await run(["find", "redirect"]);
    expect(asPhrase.exitCode).toBe(0);
    expect(asPhrase.stdout).toMatch(/^scope: \/src\/widget \(project\)$/m);
    // a session-shaped phrase is searched by naming the session first
    const hexPhrase = await run(["find", S, "e1000018", "--context", "0"]);
    expect(hexPhrase.exitCode).toBe(0);
  });
});

describe("find: context", () => {
  it("--context 2 prints two rows each side with empty why; --context 0 prints hits", async () => {
    const r = await run(["find", S, "--tool", "edit", "--context", "2"]);
    const { label, rows } = table(r.stdout);
    expect(label).toBe("rows");
    expect(rows.map((x) => [x.id, x.why])).toEqual([
      [`${S}:6`, ""],
      [`${S}:8`, ""],
      [`${S}:10`, "tool"],
      [`${S}:12`, ""],
      [`${S}:14`, ""],
    ]);
    const z = await run(["find", S, "--tool", "edit", "--context", "0"]);
    expect(table(z.stdout)).toMatchObject({ label: "hits", rows: [{ id: `${S}:10`, why: "tool" }] });
    expect(r.stdout).toMatch(/^rows\[5\]\{id,t,kind,why,text\}:$/m);
    expect(z.stdout).toMatch(/^hits\[1\]\{id,t,kind,why,text\}:$/m);
  });

  it("overlapping contexts print each row once, in file order", async () => {
    const r = await run(["find", S, "deploy", "--context", "2"]);
    const ids = table(r.stdout).rows.map((x) => x.id);
    expect(new Set(ids).size).toBe(ids.length);
    const seqs = ids.map((i) => Number(i.split(":")[1]));
    expect([...seqs].sort((a, b) => a - b)).toEqual(seqs);
    expect(hitIds(r.stdout)).toEqual(seq(1, 14, 15, 16, 18));
  });

  it("a hidden thinking row between hits takes no context slot", async () => {
    // :2 is the hit; :3 (thinking) is hidden, so the row after is :4
    const r = await run(["find", S, "handler", "--context", "1"]);
    expect(table(r.stdout).rows.map((x) => x.id)).toEqual(seq(1, 2, 4));
  });

  it("--before/--after override one side of --context", async () => {
    const r = await run(["find", S, "--tool", "edit", "--context", "2", "--after", "0"]);
    expect(table(r.stdout).rows.map((x) => x.id)).toEqual(seq(6, 8, 10));
    const b = await run(["find", S, "--tool", "edit", "--before", "0", "--after", "1"]);
    expect(table(b.stdout).rows.map((x) => x.id)).toEqual(seq(10, 12));
  });
});

describe("find: regex, ranges, deep", () => {
  it("--regex works; an invalid or exponential pattern is VALIDATION_ERROR", async () => {
    const r = await run(["find", S, "--regex", "redir\\w+", "--context", "0"]);
    expect(hitIds(r.stdout)).toEqual(seq(1, 2, 4, 6));
    expect(r.stdout).toMatch(/^query: "phrase \/redir\\\\w\+\/"$/m);
    for (const bad of ["(", "(a+)+", "(a|ab)*", "(\\w+\\s){2,}"]) {
      const e = await run(["find", S, "--regex", bad]);
      expect(e.exitCode, bad).toBe(2);
      expect(e.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    }
  });

  it("--from/--to limit by position; --since by time", async () => {
    const pos = await run(["find", S, "redirect", "--from", `${S}:2`, "--to", `${S}:6`, "--context", "0"]);
    expect(hitIds(pos.stdout)).toEqual(seq(2, 4));
    // NOW is 14:00; the second half of the session starts at 13:30
    const since = await run(["find", S, "deploy", "--since", "1h", "--context", "0"]);
    expect(hitIds(since.stdout)).toEqual(seq(14, 15, 16, 18));
  });

  it("--deep finds a phrase that exists only in a persisted-output file", async () => {
    const plain = await run(["find", S, FIND_DEEP_WORD]);
    expect(plain.exitCode).toBe(0);
    expect(plain.stdout).toMatch(new RegExp(`^hits: "0 events match phrase \\\\"${FIND_DEEP_WORD}\\\\" in ${S} \\(18 lines scanned\\)"$`, "m"));
    expect(plain.stdout).toContain("--deep` to also search persisted outputs");
    const deep = await run(["find", S, FIND_DEEP_WORD, "--deep", "--context", "0"]);
    expect(deep.stdout).toMatch(/^deep: yes$/m);
    expect(table(deep.stdout).rows.map((x) => [x.id, x.kind, x.why])).toEqual([[`${S}:16`, "call", "phrase"]]);
  });

  it("zero hits is exit 0 with the definitive line, lines scanned, and drop-a-filter hints that run", async () => {
    const r = await run(["find", S, "nothing-like-this", "--tool", "bash"]);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^hits: "0 events match phrase \\"nothing-like-this\\" \+ tool bash in e1000018 \(18 lines scanned\)"$/m);
    const cmds = helpCommands(r.stdout);
    expect(cmds.length).toBeGreaterThan(1);
    for (const argv of cmds) expect((await run(argv)).exitCode, argv.join(" ")).toBe(0);
    const dropPhrase = cmds.find((c) => !c.includes("nothing-like-this"))!;
    expect(hitIds((await run(dropPhrase)).stdout)).toEqual(seq(8, 12, 16));
  });

  it("--window all is the whole session; a window past the last is VALIDATION_ERROR", async () => {
    const all = await run(["find", S, "redirect", "--window", "all"]);
    expect(all.exitCode).toBe(0);
    expect((await run(["find", S, "redirect"])).stdout).toBe(all.stdout.replaceAll(" --window all", ""));
    // One window: `last` is window 0, the whole session.
    expect(hitIds((await run(["find", S, "redirect", "--window", "last"])).stdout)).toEqual(hitIds(all.stdout));
    const r = await run(["find", S, "redirect", "--window", "1"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    expect(r.stdout).toContain("only window 0");
  });
});

describe("find: header and footer", () => {
  it("prints scope, query, count with lines scanned, and hints that resolve as printed", async () => {
    const r = await run(["find", S, "redirect", "--file", "*.env*"]);
    expect(r.stdout).toMatch(/^scope: "?e1000018/m);
    expect(r.stdout).toMatch(/^query: "phrase \\"redirect\\" \+ file \*\.env\*"$/m);
    expect(r.stdout).toMatch(/^count: 1 of 1 hit \(18 lines scanned\)$/m);
    expect(table(r.stdout).rows.find((x) => x.why)).toMatchObject({ id: `${S}:4`, why: "phrase+file" });
    expect(r.stdout).toContain(`Run \`agent-session-axi show ${S}:4\` for the whole call and result`);
    for (const argv of helpCommands(r.stdout)) expect((await run(argv)).exitCode, argv.join(" ")).toBe(0);
  });

  it("more hits than --limit: a continuation from after the last hit, with the same query", async () => {
    const r = await run(["find", S, "redirect", "--limit", "2", "--context", "0"]);
    expect(r.stdout).toMatch(/^count: 2 of 4 hits/m);
    const cont = helpCommands(r.stdout).find((c) => c[0] === "find" && c.includes("--from"))!;
    expect(cont).toEqual(["find", S, "redirect", "--from", `${S}:3`, "--context", "0", "--limit", "2"]);
    expect(hitIds((await run(cont)).stdout)).toEqual(seq(4, 6));
  });

  it("cut rows get a --full hint; text before the cut is verbatim", async () => {
    const r = await run(["find", S, "redirect", "--head", "12", "--context", "0"]);
    expect(table(r.stdout).rows[0]!.text).toBe("the deploy k…");
    const full = helpCommands(r.stdout).find((c) => c.includes("--full"))!;
    const w = await run(full);
    expect(table(w.stdout).rows[0]!.text).toBe("the deploy keeps hitting the old redirect after login");
  });

  it("a phrase that starts with a dash survives into hints after --", async () => {
    const r = await run(["find", S, "--limit", "1", "--context", "0", "--", "-n"]);
    expect(hitIds(r.stdout)).toEqual(seq(8));
    const none = await run(["find", S, "--tool", "edit", "--context", "0", "--", "-n"]);
    const cmds = helpCommands(none.stdout);
    expect(cmds.some((c) => c.slice(-2).join(" ") === "-- -n")).toBe(true);
    for (const argv of cmds) expect((await run(argv)).exitCode, argv.join(" ")).toBe(0);
  });
});

describe("find: library", () => {
  it("find() yields Hit { event, why, context } in file order; findListing counts past the limit", async () => {
    const session = await openSession(fx("find"));
    const hits = [];
    for await (const h of find(session, { phrase: "redirect", context: { before: 1, after: 1 } })) hits.push(h);
    expect(hits.map((h) => h.event.id.seq)).toEqual([1, 2, 4, 6]);
    expect(hits[1]!.why).toEqual(["phrase"]);
    expect(hits[1]!.context.map((e) => e.id.seq)).toEqual([1, 4]);
    const listing = await findListing(session, { tool: "bash", limit: 1, context: 0 });
    expect(listing).toMatchObject({ matching: 3, lines: 18, malformed: 0 });
    expect(listing.hits).toHaveLength(1);
    await expect(findListing(session, {})).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("backtrackRisk refuses repeated groups that hold a quantifier or alternation", () => {
    for (const bad of ["(a+)+", "(a*)*", "(a|ab)*", "((ab)+c)+", "(?:x+y)+", "(?<w>\\w+\\s)+"]) expect(backtrackRisk(bad), bad).toBe(true);
    for (const ok of ["redir\\w+", "a+b+", "(ab)+", "(foo|bar)", "[(+]+", "\\(a+\\)+", "(a+)?", "x{2,}", "(?=a+)b"]) expect(backtrackRisk(ok), ok).toBe(false);
  });

  it("globRegex: * and ? cross /, classes, everything else literal", () => {
    expect(globRegex("*.env").test("config/staging.env")).toBe(true);
    expect(globRegex("*.env").test("config/staging.env.bak")).toBe(false);
    expect(globRegex("src/?idget.ts").test("src/widget.ts")).toBe(true);
    expect(globRegex("[!x]*.ts").test("widget.ts")).toBe(true);
    expect(globRegex("a+b(c).ts").test("a+b(c).ts")).toBe(true);
    expect(globRegex("[unclosed").test("[unclosed")).toBe(true);
  });
});

describe("find --deep: pointer containment", () => {
  const tmp = mkdtempSync(join(tmpdir(), "asa-find-deep-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const S8 = "d2000019";
  const ID = `${S8}-0000-4000-8000-000000000000`;
  const root = join(tmp, "root");
  const dir = join(root, "projects", "-src-widget");
  const sidecar = join(dir, ID);
  const outside = join(tmp, "outside");
  mkdirSync(join(sidecar, "tool-results"), { recursive: true });
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.txt"), "OUTSIDE-NEEDLE\n");
  writeFileSync(join(sidecar, "tool-results", "inside.txt"), "INSIDE-NEEDLE\n");
  symlinkSync(join(outside, "secret.txt"), join(sidecar, "tool-results", "link.txt"));
  let n = 0;
  const line = (type: string, body: Record<string, unknown>) =>
    JSON.stringify({ type, ...body, uuid: `${S8}-0000-4000-8000-${String(++n).padStart(12, "0")}`, timestamp: `2026-11-07T13:40:${String(n).padStart(2, "0")}.000Z`, cwd: "/src/widget", sessionId: ID });
  const call = (i: number) => line("assistant", { message: { role: "assistant", content: [{ type: "tool_use", id: `toolu_fxdeep${i}`, name: "Bash", input: { command: `cat f${i}` } }] } });
  const result = (i: number, path: string) =>
    line("user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: `toolu_fxdeep${i}`, content: `<persisted-output>\nOutput too large (1.0KB). Full output saved to: ${path}\n\nPreview (first 2KB):\npreview text\n...\n</persisted-output>`, is_error: false }] } });
  const file = join(dir, `${ID}.jsonl`);
  writeFileSync(
    file,
    `${[call(1), result(1, join(outside, "secret.txt")), call(2), result(2, join(sidecar, "tool-results", "link.txt")), call(3), result(3, join(sidecar, "tool-results", "inside.txt"))].join("\n")}\n`,
  );
  const env = { CLAUDE_CONFIG_DIR: root };

  it("reads only regular files inside the session's tool-results/", async () => {
    const out = await run(["find", file, "OUTSIDE-NEEDLE", "--deep"], { env });
    expect(out.exitCode).toBe(0);
    expect(out.stdout).toMatch(/^hits: "0 events match/m);
    const inside = await run(["find", file, "INSIDE-NEEDLE", "--deep", "--context", "0"], { env });
    expect(hitIds(inside.stdout)).toEqual([`${S8}:5`]);
    // the preview of an unfollowable pointer is still searched
    const preview = await run(["find", file, "preview text", "--context", "0"], { env });
    expect(hitIds(preview.stdout)).toEqual([`${S8}:1`, `${S8}:3`, `${S8}:5`]);
  });
});

// ---------------------------------------------------------------------------------------------
// review fixes (PR #6)

describe("find review: --deep streams persisted files", () => {
  const tmp = mkdtempSync(join(tmpdir(), "asa-find-stream-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  it("a substring spanning a chunk boundary is found; a regex is tested line by line", async () => {
    const path = join(tmp, "out.txt");
    const chunk = 64;
    // "NEEDLE" straddles the first 64-byte boundary
    writeFileSync(path, `${"x".repeat(chunk - 3)}NEEDLE${"y".repeat(200)}\nsecond line Ünïcode\n${"z".repeat(300)}`);
    expect(await streamMatches(path, { needle: "needle" }, chunk)).toBe(true);
    expect(await streamMatches(path, { needle: "absent" }, chunk)).toBe(false);
    expect(await streamMatches(path, { re: /second line ünïcode$/iu }, chunk)).toBe(true);
    // a regex never matches across a newline in a persisted file
    expect(await streamMatches(path, { re: /y\nsecond/iu }, chunk)).toBe(false);
    // the last line has no newline and is still tested
    expect(await streamMatches(path, { re: /^z+$/iu }, chunk)).toBe(true);
  });
});

describe("find review: regex guard", () => {
  it("refuses the exponential shapes and accepts bounded or distinct-literal ones", () => {
    const refused = ["(a+)+", "(a*)*", "(a|ab)*", "(\\w+\\s?)*", "((ab)+c)+", "(?:x+y)+", "(a|a)+", `${"a?".repeat(28)}${"a".repeat(28)}`, "\\w?".repeat(12)];
    const accepted = ["(foo|bar)+", "(\\d+\\.){3}\\d+", "redir\\w+", "a+b+", "(ab)+", "(foo|bar)", "[(+]+", "\\(a+\\)+", "(a+)?", "x{2,}", "(?=a+)b", "(a?){3}", "a?".repeat(11)];
    for (const p of refused) expect(backtrackRisk(p), p).toBe(true);
    for (const p of accepted) expect(backtrackRisk(p), p).toBe(false);
  });

  it("--regex compiles with iu: \\p{L} works; a pattern invalid only under u is VALIDATION_ERROR naming the flag", async () => {
    const r = await run(["find", S, "--regex", "redir\\p{L}+", "--context", "0"]);
    expect(hitIds(r.stdout)).toEqual(seq(1, 2, 4, 6));
    const accepted = await run(["find", S, "--regex", "(foo|redirect)+", "--context", "0"]);
    expect(accepted.exitCode).toBe(0);
    const u = await run(["find", S, "--regex", "\\-"]);
    expect(u.exitCode).toBe(2);
    expect(u.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    expect(u.stdout).toContain("u flag");
  });
});

describe("find review: validation and resolution", () => {
  it("an invalid glob class is VALIDATION_ERROR, exit 2", async () => {
    const r = await run(["find", S, "--file", "[z-a]"]);
    expect(r.exitCode).toBe(2);
    expect(r.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
  });

  it("a lone session-shaped argument says it was read as the session and hints it as a phrase", async () => {
    const noHandle = await run(["find", "config/staging.env", "--all"]);
    expect(noHandle.exitCode).toBe(2);
    expect(noHandle.stdout).toContain("read as the <session>");
    expect(noHandle.stdout).toContain("Run `agent-session-axi find latest config/staging.env --all`");
    const missing = await run(["find", "abcdef12", "--tool", "bash", "--project", "/src/widget"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("read as the <session>");
    expect(missing.stdout).toContain("Run `agent-session-axi find latest abcdef12 --tool bash --project /src/widget`");
    expect(missing.stdout).toContain("sessions --subagents --project /src/widget");
  });

  it("the shared resolver's NOT_FOUND hint carries --project (every command benefits)", async () => {
    const r = await run(["events", "abcdef12", "--project", "/src/widget"]);
    expect(r.exitCode).toBe(1);
    expect(r.stdout).toContain("sessions --subagents --project /src/widget");
  });
});

describe("find review: --kind all", () => {
  it("accepts all: every kind, results as rows, calls stop folding results", async () => {
    const r = await run(["find", S, "redirect", "--kind", "all", "--context", "0"]);
    expect(r.exitCode).toBe(0);
    const rows = table(r.stdout).rows;
    expect(rows.map((x) => [x.id, x.kind])).toEqual([
      [`${S}:1`, "human"],
      [`${S}:2`, "assistant"],
      [`${S}:3`, "thinking"],
      [`${S}:5`, "result"],
      [`${S}:6`, "call"],
    ]);
    expect(r.stdout).toMatch(/^query: "phrase \\"redirect\\" \+ kind all"$/m);
    const usage = (await run(["find", "--help"])).stdout;
    for (const f of ["--kind <a,b|all>", "--head <n>", "--full", "--fields <a,b>", "--window <k|last>"]) expect(usage.split("\n")[1]).toContain(f);
  });
});

describe("find review: hits past --limit inside a shown context", () => {
  it("keep their why, count as shown, and the continuation neither skips nor repeats", async () => {
    const r = await run(["find", S, "redirect", "--limit", "1", "--context", "1"]);
    expect(table(r.stdout).rows.map((x) => [x.id, x.why])).toEqual([
      [`${S}:1`, "phrase"],
      [`${S}:2`, "phrase"],
    ]);
    expect(r.stdout).toMatch(/^count: 2 of 4 hits/m);
    const cont = helpCommands(r.stdout).find((c) => c[0] === "find" && c.includes("--from"))!;
    expect(cont).toContain(`${S}:3`);
    const next = await run(cont);
    expect(hitIds(next.stdout)).toEqual(seq(4, 6));
  });
});

describe("find review: an id --to bound with an unanswered call", () => {
  const tmp = mkdtempSync(join(tmpdir(), "asa-find-bound-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));
  const S8 = "d3000020";
  const ID = `${S8}-0000-4000-8000-000000000000`;
  let n = 0;
  const line = (type: string, body: Record<string, unknown>) =>
    JSON.stringify({ type, ...body, uuid: `${S8}-0000-4000-8000-${String(++n).padStart(12, "0")}`, timestamp: "2026-11-07T13:40:00.000Z", cwd: "/src/widget", sessionId: ID });
  const lines = [
    line("user", { message: { role: "user", content: "run the build" }, origin: { kind: "human" } }),
    line("assistant", { message: { role: "assistant", content: [{ type: "tool_use", id: "toolu_fxbound1", name: "Bash", input: { command: "bun run build" } }] } }),
  ];
  for (let i = 0; i < 3000; i++) lines.push(line("assistant", { message: { role: "assistant", content: [{ type: "text", text: `filler ${i}` }] } }));
  const file = join(tmp, `${ID}.jsonl`);
  writeFileSync(file, `${lines.join("\n")}\n`);

  it("stops reading soon after the bound; the call stays pending", async () => {
    const session = await openSession(file);
    const listing = await findListing(session, { tool: "bash", to: { session: S8, seq: 3 }, context: 0 });
    expect(listing.hits.map((h) => h.event.status?.state)).toEqual(["pending"]);
    expect(listing.lines).toBeLessThan(1100);
  });
});
