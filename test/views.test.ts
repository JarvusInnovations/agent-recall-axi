/**
 * The views (plan views): turns, human, tools, compactions, and `--window` on every listing.
 * Windows and turns must read the same whether a read starts cold at the file start or seeded at
 * a checkpoint, and every command must agree on where a window begins and ends.
 */
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decode } from "@toon-format/toon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { farSummarySession, imageResultSession, panSession, QUEUED_PROMPT } from "./fixtures/build.js";
import { fx, run } from "./helpers/run.js";
import {
  AUTHORITY,
  boundaries,
  compactions,
  events,
  humanMessages,
  openSession,
  show,
  toolCalls,
  turns,
  WindowCounter,
  windows,
  type Event,
  type Session,
  type Turn,
} from "../src/lib/index.js";
import { formatId } from "../src/lib/ids.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-views-"));
const panFile = join(tmp, "e1000021-0000-4000-8000-000000000000.jsonl");
const imageFile = join(tmp, "e4000024-0000-4000-8000-000000000000.jsonl");
const farFile = join(tmp, "e8000028-0000-4000-8000-000000000000.jsonl");
let caches = 0;
const freshCache = () => ({ env: { XDG_CACHE_HOME: join(tmp, `cache-${++caches}`) } });
let pan: Session;

beforeAll(async () => {
  writeFileSync(panFile, panSession());
  writeFileSync(imageFile, imageResultSession());
  writeFileSync(farFile, farSummarySession());
  pan = await openSession(panFile);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** The TOON document without its help block (help lines are prose commands, not TOON items). */
const body = (out: string) => decode(out.split(/\nhelp\[\d+\]:\n/)[0]!) as Record<string, unknown>;
const hints = (out: string) => [...out.matchAll(/Run `agent-session-axi ([^`]*)`/g)].map((m) => m[1]!.split(" "));
const header = (out: string, key: string) => new RegExp(`^${key}: (.*)$`, "m").exec(out)?.[1];
const table = (out: string, label: string) => (body(out)[label] as Array<Record<string, unknown>>) ?? [];

/** Every event of the session, cold from the file start, each with the window the shared rule gives it. */
async function coldWindows(session: Session): Promise<Array<{ ev: Event; window: number }>> {
  const counter = new WindowCounter();
  const out: Array<{ ev: Event; window: number }> = [];
  for await (const ev of events(session, { kinds: "all" })) out.push({ ev, window: counter.place(ev) });
  return out;
}

async function collect<T>(it: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const x of it) out.push(x);
  return out;
}

describe("turns", () => {
  it("one row per human prompt with events, calls and how it ended", async () => {
    const r = await run(["turns", fx("compaction")]);
    expect(r.exitCode).toBe(0);
    expect(table(r.stdout, "turns")).toEqual([
      { id: "a6000006:1", t: "13:40:02", prompt: "keep refactoring the flange module", events: 4, calls: 0, ended: "compaction" },
      { id: "a6000006:5", t: "13:40:08", prompt: "continue with the second file", events: 2, calls: 0, ended: "stop" },
    ]);
    expect(header(r.stdout, "count")).toBe("2 of 2");
  });

  it("ended is open when the file ends before the agent's closing text", async () => {
    const r = await run(["turns", fx("parallel-tools")]);
    expect(table(r.stdout, "turns")).toEqual([
      { id: "a3000003:1", t: "13:40:02", prompt: "run the tests and the linter, and check the config", events: 10, calls: 4, ended: "open" },
    ]);
  });

  it("turn 0 appears only when events precede the first prompt", async () => {
    const hooks = table((await run(["turns", fx("hooks")])).stdout, "turns");
    expect(hooks[0]).toMatchObject({ id: "aa00000a:1", prompt: "(session start)", events: 1, ended: "stop" });
    expect(hooks).toHaveLength(2);
    const plain = table((await run(["turns", fx("string-content")])).stdout, "turns");
    expect(plain.map((t) => t.prompt)).toEqual(["the widget listing loops back to itself after the callback; can you look?", "also keep the old redirect for staging"]);
  });

  it("a queued message never opens a turn; two in one turn count queued: 2", async () => {
    const ts = await collect(turns(await openSession(fx("queued-command"))));
    expect(ts).toHaveLength(1);
    expect(ts[0]).toMatchObject({ queued: 2, calls: 1, ended: "stop" });
  });

  it("a boundary-less summary with events before it is a boundary: its turn ends in compaction", async () => {
    const r = await run(["turns", farFile]);
    expect(table(r.stdout, "turns").map((t) => [t.prompt, t.ended])).toEqual([
      ["start the flange work", "compaction"],
      ["keep going", "compaction"],
      ["now the second half", "stop"],
    ]);
  });

  it("--limit keeps the newest; the footer continues with --to and every hint runs", async () => {
    const r = await run(["turns", panFile, "--limit", "5"]);
    expect(header(r.stdout, "count")).toBe("5 of 130");
    const hs = hints(r.stdout);
    const earlier = hs.find((h) => h[0] === "turns" && h.includes("--to"))!;
    expect(earlier).toBeDefined();
    const more = await run(earlier);
    expect(header(more.stdout, "count")).toBe("5 of 125");
    for (const h of hs) expect((await run(h)).exitCode, h.join(" ")).toBe(0);
  });

  it("turns agree with show's turn on every event", async () => {
    const ts = await collect(turns(pan));
    const opener = new Map<string, string>();
    for (const t of ts) opener.set(formatId(t.id), formatId(t.id));
    const cold = await coldWindows(pan);
    // Sample: every 37th event.
    for (let i = 0; i < cold.length; i += 37) {
      const { ev } = cold[i]!;
      const s = (await show(pan, ev.id, { cache: freshCache() })).events.find((x) => formatId(x.event.id) === formatId(ev.id))!;
      if (s.turn) expect(opener.has(formatId(s.turn)), formatId(ev.id)).toBe(true);
    }
    expect(ts.reduce((n, t) => n + t.events, 0)).toBe(cold.length);
  });

  it("empty selection is a definitive zero", async () => {
    const r = await run(["turns", fx("compaction"), "--from", "2026-12-01"]);
    expect(r.exitCode).toBe(0);
    expect(header(r.stdout, "turns")).toBe("0 turns in a6000006 (6 lines)");
  });
});

describe("human", () => {
  const source = (name: string) => readFileSync(fx(name), "utf8");

  it("prints every H event verbatim, byte for byte", async () => {
    const cases: Array<[string, Array<[string, string]>]> = [
      ["string-content", [["human", "the widget listing loops back to itself after the callback; can you look?"], ["human", "also\n\nkeep the old redirect for staging"]]],
      ["queued-command", [["human", "fix the sprocket build"], ["human.queued", QUEUED_PROMPT], ["human.queued", "and bump the version afterwards"]]],
      ["slash-command", [["human.slash", "/review src/widget.ts --strict"], ["human.slash", "/compact"]]],
      ["question", [["human", "set up the gadget release"], ["human.answer", "beta"]]],
    ];
    for (const [name, want] of cases) {
      const r = await run(["human", fx(name)]);
      expect(r.exitCode).toBe(0);
      expect(header(r.stdout, "authority")).toBe("H (verbatim)");
      const msgs = table(r.stdout, "messages");
      expect(msgs.map((m) => [m.kind, m.text]), name).toEqual(want);
      // The texts the adapter keeps verbatim are in the source as stored (JSON-escaped there).
      for (const [kind, text] of want) if (kind !== "human.slash" && kind !== "human.answer") expect(source(name)).toContain(JSON.stringify(text).slice(1, -1));
    }
    // The queued message is printed without the wrapper the model saw.
    expect((await run(["human", fx("queued-command")])).stdout).not.toContain("system-reminder");
  });

  it("long H text is printed whole and matches the library's stored text", async () => {
    const s = await openSession(fx("long-text"));
    const lib = (await humanMessages(s, { budget: Infinity })).messages;
    const msgs = table((await run(["human", fx("long-text"), "--full"])).stdout, "messages");
    expect(msgs.map((m) => m.text)).toEqual(lib.map((m) => m.text));
    expect(lib.some((m) => m.size > 4000)).toBe(true);
  });

  it("never prints summary, skill, hook or notice text", async () => {
    for (const name of ["compaction", "skill", "hooks", "notices", "authority-edges"]) {
      const s = await openSession(fx(name));
      const others = (await collect(events(s, { kinds: "all" }))).filter((e) => AUTHORITY[e.kind] !== "H" && e.text.length > 12);
      const r = await run(["human", fx(name)]);
      const msgs = table(r.stdout, "messages");
      if (Array.isArray(msgs)) for (const m of msgs) expect(["human", "human.queued", "human.slash", "human.answer"]).toContain(m.kind);
      for (const o of others) expect(r.stdout, `${name} ${o.kind}`).not.toContain(o.text.slice(0, 40).replace(/\n.*/s, ""));
    }
  });

  it("--window last prints the post-boundary messages, then the summary as C; --window 0 has no summary", async () => {
    const last = await run(["human", fx("compaction"), "--window", "last"]);
    const doc = body(last.stdout);
    expect((doc.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["continue with the second file"]);
    expect(doc.summary).toMatchObject({ id: "a6000006:4", authority: "C" });
    expect(last.stdout.indexOf("summary:")).toBeGreaterThan(last.stdout.indexOf("messages["));
    const zero = body((await run(["human", fx("compaction"), "--window", "0"])).stdout);
    expect((zero.messages as Array<{ text: string }>).map((m) => m.text)).toEqual(["keep refactoring the flange module"]);
    expect(zero.summary).toBeUndefined();
    expect(body((await run(["human", fx("compaction")])).stdout).summary).toBeUndefined();
  });

  it("--budget drops the oldest; the continuation yields exactly the omitted messages", async () => {
    const r = await run(["human", panFile, "--budget", "300"]);
    const shown = table(r.stdout, "messages");
    const total = Number(/of (\d+) human messages/.exec(header(r.stdout, "count")!)![1]);
    const omitted = String(body(r.stdout).omitted);
    const n = Number(/^(\d+) earlier messages/.exec(omitted)![1]);
    expect(n + shown.length).toBe(total);
    expect(shown.reduce((a, m) => a + String(m.text).length, 0)).toBeLessThanOrEqual(300);
    const cont = hints(r.stdout).find((h) => h[0] === "human" && h.includes("--to"))!;
    expect(omitted).toContain(`continue with ${cont.join(" ")}`);
    const rest = await run([...cont, "--full"]);
    const restIds = table(rest.stdout, "messages").map((m) => m.id);
    const all = (await humanMessages(pan, { budget: Infinity })).messages.map((m) => formatId(m.id));
    expect(restIds).toEqual(all.slice(0, n));
    expect([...restIds, ...shown.map((m) => m.id)]).toEqual(all);
  });

  it("the newest message is printed whole even past the budget", async () => {
    const r = await run(["human", fx("long-text"), "--budget", "10"]);
    const msgs = table(r.stdout, "messages");
    expect(msgs).toHaveLength(1);
    expect(String(msgs[0]!.text).length).toBeGreaterThan(10);
    expect(String(body(r.stdout).omitted)).toMatch(/^\d+ earlier messages?; continue with human /);
  });

  it("--rows prints the standard row table", async () => {
    const r = await run(["human", fx("queued-command"), "--rows"]);
    expect(r.stdout).toContain("messages[3]{id,t,kind,text}:");
    expect(table(r.stdout, "messages").map((m) => m.kind)).toEqual(["human", "human.queued", "human.queued"]);
  });

  it("a pure subagent run has 0 human messages", async () => {
    const r = await run(["human", fx("subagent")]);
    expect(r.exitCode).toBe(0);
    expect(header(r.stdout, "messages")).toMatch(/^0 human messages in /);
  });
});

describe("tools", () => {
  it("rows fold in the result status: ok, error, persisted, image, pending", async () => {
    const par = table((await run(["tools", fx("parallel-tools")])).stdout, "tools");
    expect(par.map((t) => t.result)).toEqual(["error 42", "ok 10", "ok 77", "pending"]);
    expect(par[0]).toMatchObject({ tool: "Bash", target: "bun test src/widget.test.ts" });
    expect(table((await run(["tools", fx("persisted-output")])).stdout, "tools")[0]!.result).toBe("persisted 42.8k");
    expect(table((await run(["tools", imageFile])).stdout, "tools")[0]!.result).toBe("image");
  });

  it("--name, --file and --errors filter", async () => {
    const ids = async (...a: string[]) => table((await run(["tools", fx("parallel-tools"), ...a])).stdout, "tools").map((t) => t.id);
    expect(await ids("--name", "read")).toEqual(["a3000003:4"]);
    expect(await ids("--name", "BASH")).toEqual(["a3000003:2", "a3000003:3"]);
    expect(await ids("--file", "*.env")).toEqual(["a3000003:4"]);
    expect(await ids("--file", "widget")).toEqual(["a3000003:2", "a3000003:10"]);
    expect(await ids("--errors")).toEqual(["a3000003:2"]);
    const none = await run(["tools", fx("parallel-tools"), "--name", "nothing"]);
    expect(header(none.stdout, "tools")).toBe("0 tool calls match in a3000003");
  });

  it("--full prints the input JSON and the result text as blocks, following persisted outputs", async () => {
    const r = await run(["tools", fx("parallel-tools"), "--full"]);
    const blocks = body(r.stdout).tools as Array<Record<string, unknown>>;
    expect(blocks[2]).toMatchObject({ id: "a3000003:4", input: { file_path: "config/staging.env" }, result: "ok 77" });
    expect(String(blocks[2]!.result_text)).toContain("APP_HOST=staging.example.test");
    expect(blocks[3]).toMatchObject({ result: "pending" });
    expect(blocks[3]!.result_text).toBeUndefined();
    const p = body((await run(["tools", fx("persisted-output"), "--full"])).stdout).tools as Array<Record<string, unknown>>;
    expect(String(p[0]!.result_text)).toHaveLength(42_800);
  });

  it("matches the library and every hint runs", async () => {
    const s = await openSession(fx("parallel-tools"));
    const lib = await collect(toolCalls(s));
    expect(lib.map((c) => formatId(c.id))).toEqual(["a3000003:2", "a3000003:3", "a3000003:4", "a3000003:10"]);
    for (const name of ["parallel-tools", "persisted-output"]) {
      for (const h of hints((await run(["tools", fx(name)])).stdout)) expect((await run(h)).exitCode, h.join(" ")).toBe(0);
    }
  });
});

describe("compactions", () => {
  it("lists each boundary with trigger, tokens, summary id and the window it opens", async () => {
    const r = await run(["compactions", fx("compaction")]);
    expect(table(r.stdout, "compactions")).toEqual([{ id: "a6000006:3", t: "13:40:06", trigger: "auto", pre: "998.6k", post: "25.1k", summary: "a6000006:4", window: 1 }]);
    for (const h of hints(r.stdout)) expect((await run(h)).exitCode, h.join(" ")).toBe(0);
  });

  it("--full adds the summary text and the window sizes", async () => {
    const blocks = body((await run(["compactions", fx("compaction"), "--full"])).stdout).compactions as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({ dropped: "973.5k", before: "3 events in window 0", after: "3 events in window 1" });
    expect(String(blocks[0]!.summary_text)).toMatch(/^This session is being continued/);
  });

  it("a boundary-less summary is listed with trigger unknown", async () => {
    const rows = table((await run(["compactions", farFile])).stdout, "compactions");
    expect(rows.map(({ t: _t, ...r }) => r)).toEqual([
      { id: "e8000028:3", trigger: "auto", pre: "500.0k", post: "20.0k", summary: "", window: 1 },
      { id: "e8000028:9", trigger: "unknown", pre: "", post: "", summary: "e8000028:9", window: 2 },
    ]);
  });

  it("a single-window session prints the definitive empty line", async () => {
    const r = await run(["compactions", fx("string-content")]);
    expect(r.exitCode).toBe(0);
    expect(body(r.stdout).compactions).toBe("0 in a1000001 (one window, 5 lines)");
  });
});

describe("--window on every listing", () => {
  it("events --window 1, find --window last, tail --window 0 restrict to that window", async () => {
    const ev = table((await run(["events", fx("compaction"), "--window", "1"])).stdout, "events").map((e) => e.id);
    expect(ev).toEqual(["a6000006:4", "a6000006:5", "a6000006:6"]);
    const tail = table((await run(["tail", fx("compaction"), "--window", "0"])).stdout, "tail").map((e) => e.id);
    expect(tail).toEqual(["a6000006:1", "a6000006:2", "a6000006:3"]);
    const find = await run(["find", fx("compaction"), "flange", "--window", "last"]);
    expect(table(find.stdout, "rows").filter((r) => r.why).map((r) => r.id)).toEqual(["a6000006:4", "a6000006:6"]);
  });

  it("--window past the last is VALIDATION_ERROR naming the valid range, on every command", async () => {
    for (const cmd of [["events"], ["tail"], ["find", "--kind", "human"], ["turns"], ["human"], ["tools"]]) {
      const [name, ...rest] = cmd;
      const r = await run([name!, fx("compaction"), ...rest, "--window", "5"]);
      expect(r.exitCode, name).toBe(2);
      expect(r.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
      expect(r.stdout).toContain("windows 0..1");
    }
    const bad = await run(["events", fx("compaction"), "--window", "first"]);
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toContain("--window takes");
  });

  it("the pan verbs travel inside the window; an anchor outside it is VALIDATION_ERROR", async () => {
    const out = await run(["next", "a6000006:1", "--window", "1", "--session", fx("compaction")]);
    expect(out.exitCode).toBe(2);
    expect(out.stdout).toContain("is in window 0");
    const prev = await run(["prev", "a6000006:6", "--window", "1", "--session", fx("compaction")]);
    expect(table(prev.stdout, "prev").map((e) => e.id)).toEqual(["a6000006:4", "a6000006:5"]);
    expect(header(prev.stdout, "count")).toBe("2 of 3");
    expect(header(prev.stdout, "at_start")).toBe("true");
  });

  it("k.. runs to the end", async () => {
    const r = await run(["events", panFile, "--window", "1..", "--kind", "compaction,summary", "--limit", "0"]);
    expect(table(r.stdout, "events").map((e) => e.kind)).toEqual(["summary", "compaction", "summary"]);
  });

  it("every command agrees on the windows of a long session, seeded or cold", async () => {
    const cold = await coldWindows(pan);
    const ws = await windows(pan, { cache: freshCache() });
    expect(ws).toHaveLength(3);
    const bs = await boundaries(pan, { cache: freshCache() });
    expect(bs.map((b) => b.opens)).toEqual([1, 2]);
    expect((await compactions(pan)).map((c) => c.kind)).toEqual(["compaction", "compaction"]);
    for (const w of ws) {
      const cache = freshCache();
      const want = cold.filter((c) => c.window === w.index).map((c) => c.ev);
      expect(w.events).toBe(want.length);
      // The boundary's compaction is the window's last event; its summary opens the next one.
      if (w.index < 2) expect(want[want.length - 1]!.kind).toBe("compaction");
      if (w.index > 0) expect(formatId(want.find((e) => e.kind === "summary")!.id)).toBe(formatId(w.summary!));
      const seeded = await collect(events(pan, { kinds: "all", window: w.index, cache }));
      expect(seeded).toEqual(want);
      const h = await humanMessages(pan, { window: w.index, budget: Infinity, cache });
      expect(h.messages).toEqual(want.filter((e) => AUTHORITY[e.kind] === "H"));
      const calls = await collect(toolCalls(pan, { window: w.index, cache }));
      expect(calls).toEqual(want.filter((e) => e.kind === "call"));
      // Turns: those whose prompt lies in the window, counted whole (as a cold read counts them).
      const allTurns = await collect(turns(pan));
      const inWindow = new Set(want.map((e) => formatId(e.id)));
      const wantTurns = allTurns.filter((t: Turn) => inWindow.has(formatId(t.id)));
      expect(await collect(turns(pan, { window: w.index, cache }))).toEqual(wantTurns);
      // show's window for the events of this window.
      for (const e of [want[0]!, want[want.length - 1]!]) {
        const shown = (await show(pan, e.id, { cache })).events.find((x) => formatId(x.event.id) === formatId(e.id))!;
        expect(shown.window, formatId(e.id)).toBe(w.index);
      }
      // The CLI's pan count over the window equals the window's visible events.
      const visible = want.filter((e) => e.kind !== "thinking" && e.kind !== "result");
      const last = visible[visible.length - 1]!;
      const p = await run(["prev", formatId(last.id), "--window", String(w.index), "--session", panFile, "--limit", "3"], { env: cache.env });
      expect(header(p.stdout, "count")).toBe(`3 of ${visible.length}`);
    }
  });

  it("a table extended across an append records the same windows as one built cold", async () => {
    const lines = readFileSync(panFile, "utf8").split("\n");
    const half = join(tmp, "e1000021-1111-4000-8000-000000000000.jsonl");
    writeFileSync(half, lines.slice(0, 700).join("\n") + "\n");
    const s = await openSession(half);
    const cache = freshCache();
    expect(await windows(s, { cache })).toHaveLength(2);
    appendFileSync(half, lines.slice(700).join("\n"));
    const extended = await windows(s, { cache });
    const cold = await windows(s, { cache: freshCache() });
    expect(extended).toEqual(cold);
    expect(extended).toHaveLength(3);
  });
});

describe("determinism", () => {
  it("human, turns, tools and compactions print identical bytes twice", async () => {
    for (const args of [["human", panFile], ["turns", panFile], ["tools", panFile], ["compactions", panFile, "--full"], ["human", fx("compaction"), "--window", "last"]]) {
      const a = await run(args);
      const b = await run(args);
      expect(a.exitCode).toBe(0);
      expect(b.stdout).toBe(a.stdout);
    }
  });
});
