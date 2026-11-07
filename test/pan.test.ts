/**
 * The pan verbs and the offset table (plan pan): seeks must read exactly what a scan from the
 * file start reads, counts are over visible events, edges are header fields, and the cache is
 * never required.
 */
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { panSession } from "./fixtures/build.js";
import { fx, run } from "./helpers/run.js";
import { around, events, next, openSession, prev, show } from "../src/lib/index.js";
import { showFromStart } from "../src/lib/events.js";
import { loadTable } from "../src/lib/cache/index.js";
import { KINDS, type Event, type EventId, type Session } from "../src/lib/model.js";
import { comparePosition, formatId } from "../src/lib/ids.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-pan-"));
const file = join(tmp, "e1000021-0000-4000-8000-000000000000.jsonl");
let caches = 0;
const freshCache = () => join(tmp, `cache-${++caches}`);
let session: Session;

beforeAll(async () => {
  writeFileSync(file, panSession());
  session = await openSession(file);
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const rowsOf = (out: string, label: string) => {
  const lines = out.split("\n");
  const i = lines.findIndex((l) => l.startsWith(`${label}[`));
  if (i === -1) return [];
  const n = Number(/\[(\d+)\]/.exec(lines[i]!)![1]);
  return lines.slice(i + 1, i + 1 + n);
};
const idsOf = (out: string, label: string) => rowsOf(out, label).map((r) => /^ {2}"([^"]+)"/.exec(r)![1]!);
const hints = (out: string) => [...out.matchAll(/Run `agent-session-axi ([^`]*)`/g)].map((m) => m[1]!.split(" "));
const header = (out: string, key: string) => new RegExp(`^${key}: (.*)$`, "m").exec(out)?.[1];

/** Every visible event of the file by a forward scan from the start: the reference. */
async function reference(kinds: "all" | undefined): Promise<Event[]> {
  const out: Event[] = [];
  for await (const ev of events(session, kinds ? { kinds } : {})) out.push(ev);
  return out;
}

/**
 * Ids worth anchoring on: every seq within 12 lines of a checkpoint (where a seek starts) or of
 * the file's ends, every 11th seq elsewhere, and the block ids of those entries.
 */
function anchors(all: Event[], lines: number): EventId[] {
  const near = (seq: number) => seq <= 12 || seq > lines - 12 || [(seq - 1) % 256, 256 - ((seq - 1) % 256)].some((d) => d <= 12);
  const seqs = new Set<number>();
  for (let seq = 1; seq <= lines; seq++) if (near(seq) || seq % 11 === 0) seqs.add(seq);
  const out: EventId[] = [...seqs].map((seq) => ({ session: session.short, seq }));
  for (const ev of all) if (ev.id.block !== undefined && seqs.has(ev.id.seq)) out.push(ev.id);
  return out;
}

const rel = (ev: EventId, a: EventId) => {
  if (ev.seq !== a.seq) return ev.seq - a.seq;
  if (a.block === undefined) return 0;
  return (ev.block ?? 0) - a.block;
};

describe("a seek reads exactly what a scan from the start reads", () => {
  const lines = () => readFileSync(file, "utf8").split("\n").length - 1;

  for (const kinds of [undefined, "all"] as const) {
    it(`around/next/prev rows equal the reference slice for every anchor (kinds ${kinds ?? "default"})`, async () => {
      const cache = { dir: freshCache() };
      const opts = { cache, ...(kinds ? { kinds } : {}) };
      const ref = await reference(kinds);
      const all = await reference("all");
      for (const a of anchors(all, lines())) {
        const before = ref.filter((e) => rel(e.id, a) < 0);
        const at = ref.filter((e) => rel(e.id, a) === 0);
        const after = ref.filter((e) => rel(e.id, a) > 0);
        const r = await around(session, a, 5, 5, opts);
        const want = [...before.slice(-5), ...at, ...after.slice(0, 5)];
        expect(JSON.stringify(r.rows), formatId(a)).toBe(JSON.stringify(want));
        expect(r.matching).toBe(ref.length);
        expect(r.atStart, formatId(a)).toBe(want.length ? comparePosition(want[0]!.id, ref[0]!.id) === 0 : before.length === 0);
        expect(r.atEnd, formatId(a)).toBe(want.length ? comparePosition(want[want.length - 1]!.id, ref[ref.length - 1]!.id) === 0 : after.length === 0);
        const n = await next(session, a, 7, opts);
        expect(n.rows.map((e) => formatId(e.id)), formatId(a)).toEqual(after.slice(0, 7).map((e) => formatId(e.id)));
        expect(n.atEnd, formatId(a)).toBe(after.length <= 7);
        const p = await prev(session, a, 7, opts);
        expect(p.rows.map((e) => formatId(e.id)), formatId(a)).toEqual(before.slice(-7).map((e) => formatId(e.id)));
        expect(p.atStart, formatId(a)).toBe(before.length <= 7);
      }
    }, 240_000);
  }

  it("show through the offset table equals the forward scan for every id, links included", async () => {
    const cache = { dir: freshCache() };
    const all = await reference("all");
    let compared = 0;
    for (const a of anchors(all, lines())) {
      const seeked = await show(session, a, { cache });
      const cold = await showFromStart(session, a);
      expect(JSON.stringify({ ...seeked, session: undefined }), formatId(a)).toBe(JSON.stringify({ ...cold, session: undefined }));
      compared++;
    }
    expect(compared).toBeGreaterThan(200);
    // The table really was used: checkpoints carry pending calls and a waiting compaction.
    const table = (await loadTable(file, cache))!;
    expect(table.checkpoints.length).toBe(Math.ceil(lines() / 256));
    expect(table.checkpoints.some((c) => c.pending.length > 0)).toBe(true);
    expect(table.checkpoints.some((c) => c.compaction !== undefined)).toBe(true);
    expect(KINDS.reduce((n, _k, i) => n + table.tail.cum[i]!, 0)).toBe(all.length);
  }, 240_000);
});

describe("around, next, prev at the CLI", () => {
  const env = () => ({ XDG_CACHE_HOME: freshCache() });

  it("around prints 5 before, the anchor, 5 after; --before/--after and --context count rows", async () => {
    const e = { env: env() };
    const d = await run(["around", "e1000021:604", "--session", file], e);
    expect(d.exitCode).toBe(0);
    const ids = idsOf(d.stdout, "rows");
    expect(ids).toHaveLength(11);
    expect(ids[5]).toBe("e1000021:604");
    expect(header(d.stdout, "anchor")).toBe('"e1000021:604"');
    expect(header(d.stdout, "count")).toMatch(/^11 of \d+$/);
    const two = await run(["around", "e1000021:604", "--session", file, "--before", "2", "--after", "0"], e);
    expect(idsOf(two.stdout, "rows")).toEqual(ids.slice(3, 6));
    const ctx = await run(["around", "e1000021:604", "--session", file, "--context", "3"], e);
    const explicit = await run(["around", "e1000021:604", "--session", file, "--before", "3", "--after", "3"], e);
    expect(ctx.stdout).toBe(explicit.stdout);
    const side = await run(["around", "e1000021:604", "--session", file, "--context", "3", "--after", "1"], e);
    expect(idsOf(side.stdout, "rows")).toEqual(ids.slice(2, 7));
  });

  it("next <id> 7 and --limit 7 agree; prev is symmetric and in file order", async () => {
    const e = { env: env() };
    const a = await run(["next", "e1000021:604", "7", "--session", file], e);
    const b = await run(["next", "e1000021:604", "--limit", "7", "--session", file], e);
    expect(a.stdout).toBe(b.stdout);
    const ids = idsOf(a.stdout, "next");
    expect(ids).toHaveLength(7);
    for (const id of ids) expect(Number(id.split(":")[1]!.split(".")[0])).toBeGreaterThan(604);
    const p = await run(["prev", "e1000021:604", "7", "--session", file], e);
    const pids = idsOf(p.stdout, "prev");
    expect(pids).toHaveLength(7);
    const seqs = pids.map((id) => Number(id.split(":")[1]!.split(".")[0]));
    expect([...seqs].sort((x, y) => x - y)).toEqual(seqs);
    expect(seqs.every((s) => s < 604)).toBe(true);
    const clash = await run(["next", "e1000021:604", "7", "--limit", "6", "--session", file], e);
    expect(clash.exitCode).toBe(2);
    expect(clash.stdout).toMatch(/^code: USAGE$/m);
    const flag = await run(["next", "e1000021:604", "--before", "2", "--session", file], e);
    expect(flag.exitCode).toBe(2);
    expect(flag.stdout).toMatch(/^code: UNKNOWN_FLAG$/m);
  });

  it("hidden kinds between rows do not count toward n; with --kind all they do", async () => {
    // parallel-tools: rows 4 and 6 are visible; 5 is a hidden result between them.
    const def = await run(["next", "a3000003:4", "2"]);
    expect(idsOf(def.stdout, "next")).toEqual(["a3000003:6", "a3000003:9"]);
    const all = await run(["next", "a3000003:4", "2", "--kind", "all"]);
    expect(idsOf(all.stdout, "next")).toEqual(["a3000003:5", "a3000003:6"]);
    const thinking = await run(["around", "ad00000d:3", "--before", "1", "--after", "0"]);
    expect(idsOf(thinking.stdout, "rows")).toEqual(["ad00000d:1", "ad00000d:3"]);
  });

  it("the edges are header fields and drop their continuation", async () => {
    const last = await run(["next", "a3000003:9", "1"]);
    expect(idsOf(last.stdout, "next")).toEqual(["a3000003:10"]);
    expect(last.stdout).toMatch(/^at_end: true$/m);
    expect(last.stdout).not.toContain("agent-session-axi next");
    const empty = await run(["next", "a3000003:10"]);
    expect(empty.exitCode).toBe(0);
    expect(empty.stdout).toMatch(/^next: "0 events after a3000003:10 \(at end of session\)"$/m);
    expect(empty.stdout).toMatch(/^at_end: true$/m);
    expect(empty.stdout).toContain("agent-session-axi prev a3000003:10");
    const first = await run(["prev", "a3000003:2", "5"]);
    expect(idsOf(first.stdout, "prev")).toEqual(["a3000003:1"]);
    expect(first.stdout).toMatch(/^at_start: true$/m);
    expect(first.stdout).not.toContain("agent-session-axi prev");
    const none = await run(["prev", "a3000003:1"]);
    expect(none.stdout).toMatch(/^prev: "0 events before a3000003:1 \(at start of session\)"$/m);
    const mid = await run(["around", "a3000003:4", "--context", "1"]);
    expect(mid.stdout).not.toMatch(/^at_(start|end):/m);
  });

  it("a silent anchor says where travel starts, and show still works for it", async () => {
    // a1000001:1 is a silent permission-mode line; ac00000c has silent entries between events.
    const n = await run(["next", "a1000001:1", "1"]);
    expect(header(n.stdout, "anchor_note")).toBe('"silent entry, not shown; travel starts at the nearest visible event (a1000001:2)"');
    expect(idsOf(n.stdout, "next")).toEqual(["a1000001:2"]);
    const shown = await run(["show", "a1000001:1"]);
    expect(shown.exitCode).toBe(0);
    expect(shown.stdout).toMatch(/^kind: silent$/m);
    const hidden = await run(["around", "ad00000d:2", "--context", "1"]);
    expect(header(hidden.stdout, "anchor_note")).toMatch(/^"thinking \(not a shown kind\), not shown; travel starts at the nearest visible events \(before at ad00000d:1, after at ad00000d:3\)"$/);
    expect(idsOf(hidden.stdout, "rows")).toEqual(["ad00000d:1", "ad00000d:3"]);
  });

  it("a bare id of a multi-event entry anchors on the whole entry", async () => {
    const e = { env: env() };
    const r = await run(["around", "e1000021:255", "--session", file, "--context", "0"], e);
    expect(idsOf(r.stdout, "rows")).toEqual(["e1000021:255.1", "e1000021:255.2", "e1000021:255.3"]);
    const n = await run(["next", "e1000021:255.1", "1", "--session", file], e);
    expect(idsOf(n.stdout, "next")).toEqual(["e1000021:255.2"]);
    const after = await run(["next", "e1000021:255", "1", "--session", file], e);
    expect(Number(idsOf(after.stdout, "next")[0]!.split(":")[1])).toBeGreaterThan(255);
  });

  it("errors: past the end, a missing block, a bare seq without --session", async () => {
    const past = await run(["around", "a3000003:999"]);
    expect(past.exitCode).toBe(1);
    expect(past.stdout).toMatch(/^code: NOT_FOUND$/m);
    expect(past.stdout).toContain("beyond the end of the session (10 lines)");
    expect(past.stdout).toContain("Run `agent-session-axi tail a3000003` for the last rows");
    const block = await run(["next", "a3000003:4.3"]);
    expect(block.exitCode).toBe(1);
    expect(block.stdout).toMatch(/^code: NOT_FOUND$/m);
    const bare = await run(["prev", "4"]);
    expect(bare.exitCode).toBe(2);
    expect(bare.stdout).toMatch(/^code: VALIDATION_ERROR$/m);
    const withSession = await run(["prev", "4", "--session", "a3000003"]);
    expect(idsOf(withSession.stdout, "prev")).toEqual(["a3000003:1", "a3000003:2", "a3000003:3"]);
  });

  it("every hint runs as printed, carrying the view and the session", async () => {
    const e = { env: env() };
    const out = await run(["around", "e1000021:700", "--session", file, "--kind", "human,call", "--head", "20", "--tz", "Asia/Tokyo"], e);
    const hs = hints(out.stdout);
    // prev, next, then show for a row cut to 20 chars and show for the anchor.
    expect(hs.map((h) => h[0])).toEqual(["prev", "next", "show", "show"]);
    expect(out.stdout).toContain("--kind human,call --head 20 --session");
    for (const h of hs) {
      const r = await run(h, e);
      expect(r.exitCode, h.join(" ")).toBe(0);
      if (h[0] !== "show") expect(r.stdout).toMatch(/^tz: Asia\/Tokyo$/m);
    }
    const n = await run(["next", "e1000021:700", "3", "--session", file], e);
    expect(n.stdout).toContain(`next ${idsOf(n.stdout, "next")[2]} --limit 3 --session`);
  });
});

describe("the offset table as a cache", () => {
  const copy = () => {
    const dir = mkdtempSync(join(tmp, "copy-"));
    const p = join(dir, "e1000021-0000-4000-8000-000000000000.jsonl");
    writeFileSync(p, readFileSync(file));
    return p;
  };

  it("an append extends the table without a rebuild; a truncation discards it and says so", async () => {
    const p = copy();
    const cacheHome = freshCache();
    const e = { env: { XDG_CACHE_HOME: cacheHome } };
    const cache = { dir: join(cacheHome, "agent-session-axi") };
    expect((await run(["around", "e1000021:1000", "--session", p], e)).exitCode).toBe(0);
    const t1 = (await loadTable(p, cache))!;
    const lines = t1.seq;
    const extra: string[] = [];
    for (let i = 0; i < 1000; i++) extra.push(JSON.stringify({ type: "progress", n: i }));
    appendFileSync(p, `${extra.join("\n")}\n`);
    const r = await run(["prev", `e1000021:${lines + 1000}`, "1", "--session", p], e);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).not.toMatch(/^notice:/m);
    const t2 = (await loadTable(p, cache))!;
    expect(t2.seq).toBe(lines + 1000);
    expect(t2.checkpoints.length).toBe(Math.ceil((lines + 1000) / 256));
    // Extended, not rebuilt: the earlier checkpoints are carried over unchanged.
    expect(t2.checkpoints.slice(0, t1.checkpoints.length)).toEqual(t1.checkpoints);
    const status = await run(["cache", "status"], e);
    expect(status.stdout).toContain(`e1000021,${lines + 1000},${t2.checkpoints.length},`);
    expect(status.stdout).toContain(",fresh,");

    truncateSync(p, readFileSync(p).length - Buffer.byteLength(`${extra.slice(-400).join("\n")}\n`));
    const stale = await run(["cache", "status"], e);
    expect(stale.stdout).toContain(",rewritten,");
    const after = await run(["around", "e1000021:1000", "--session", p], e);
    expect(after.exitCode).toBe(0);
    expect(after.stdout).toMatch(/^notice: "session file was rewritten since .*; ids printed earlier may have moved"$/m);
    const t3 = (await loadTable(p, cache))!;
    expect(t3.seq).toBe(lines + 600);
    expect(t3.checkpoints.length).toBe(Math.ceil((lines + 600) / 256));
  });

  it("a trailing line still being written is not indexed until it completes", async () => {
    const p = copy();
    const cache = { dir: freshCache() };
    const s = await openSession(p);
    appendFileSync(p, '{"type":"user","message":{"role":"user","content":"half');
    const r = await next(s, { session: s.short, seq: 1 }, 1, { cache });
    expect(r.rows).toHaveLength(1);
    const t = (await loadTable(p, cache))!;
    const total = readFileSync(p, "utf8").split("\n").length;
    expect(t.seq).toBe(total - 1);
    appendFileSync(p, ' written"},"origin":{"kind":"human"},"uuid":"e1000021-0000-4000-8000-00000000ffff"}\n');
    const last = await prev(s, { session: s.short, seq: total + 1 }, 1, { cache }).catch((err) => err);
    expect(String(last)).toContain("beyond the end");
    const end = await next(s, { session: s.short, seq: total - 1 }, 5, { cache });
    expect(end.rows.map((e) => e.text)).toContain("half written");
    expect((await loadTable(p, cache))!.seq).toBe(total);
  });

  it("cache status lists the session; cache clear removes the directory; every pan command still works", async () => {
    const cacheHome = freshCache();
    const e = { env: { XDG_CACHE_HOME: cacheHome } };
    const absent = await run(["cache", "status"], e);
    expect(absent.stdout).toMatch(/^cache: .* \(absent\)$/m);
    await run(["around", "e1000021:300", "--session", file], e);
    const st = await run(["cache", "status"], e);
    expect(st.stdout).toMatch(/^count: 1 indexed$/m);
    expect(st.stdout).toMatch(/^indexed\[1\]\{session,lines,checkpoints,size,state,path\}:$/m);
    expect(st.stdout).toMatch(/^ {2}e1000021,\d+,6,[\d.k]+,fresh,/m);
    const cleared = await run(["cache", "clear"], e);
    expect(cleared.exitCode).toBe(0);
    expect(cleared.stdout).toMatch(/^cleared: .*\(deleted\)$/m);
    expect(readdirSync(cacheHome)).toEqual([]);
    expect((await run(["cache", "clear"], e)).stdout).toMatch(/^cleared: nothing to clear$/m);
    for (const args of [["around", "e1000021:300"], ["next", "e1000021:300"], ["prev", "e1000021:300"], ["tail", file], ["show", "e1000021:300"]]) {
      const r = await run(args[0] === "tail" ? args : [...args, "--session", file], e);
      expect(r.exitCode, args.join(" ")).toBe(0);
    }
    const bad = await run(["cache", "status", "--all"], e);
    expect(bad.exitCode).toBe(2);
    expect(bad.stdout).toMatch(/^code: UNKNOWN_FLAG$/m);
  });

  it("cache clear --project removes only that project's records", async () => {
    const cacheHome = freshCache();
    const e = { env: { XDG_CACHE_HOME: cacheHome } };
    await run(["around", "a3000003:4"], e);
    await run(["around", "c1000013:1", "--all"], e);
    expect((await run(["cache", "status"], e)).stdout).toMatch(/^count: 2 indexed$/m);
    const r = await run(["cache", "clear", "--project", "/src/gadget"], e);
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toMatch(/^cleared: 2 records for \/src\/gadget/m);
    const st = await run(["cache", "status"], e);
    expect(st.stdout).toMatch(/^count: 1 indexed$/m);
    expect(st.stdout).toContain("a3000003,");
  });

  it("a deleted, corrupt or unwritable cache is never an error", async () => {
    const cacheHome = freshCache();
    const e = { env: { XDG_CACHE_HOME: cacheHome } };
    expect((await run(["around", "e1000021:900", "--session", file], e)).exitCode).toBe(0);
    rmSync(cacheHome, { recursive: true, force: true });
    const again = await run(["around", "e1000021:900", "--session", file], e);
    expect(again.exitCode).toBe(0);
    const index = join(cacheHome, "agent-session-axi", "index");
    for (const f of readdirSync(index)) writeFileSync(join(index, f), '{"v":1,"path":');
    const corrupt = await run(["around", "e1000021:900", "--session", file], e);
    expect(corrupt.stdout).toBe(again.stdout);
    const blocked = join(tmp, "blocked");
    writeFileSync(blocked, "");
    const unwritable = await run(["show", "e1000021:900", "--session", file], { env: { XDG_CACHE_HOME: join(blocked, "x") } });
    expect(unwritable.exitCode).toBe(0);
    const warm = await run(["show", "e1000021:900", "--session", file], e);
    expect(unwritable.stdout).toBe(warm.stdout);
  });

  it("tail is exact once a table exists and honest without one", async () => {
    const e = { env: { XDG_CACHE_HOME: freshCache() } };
    const cold = await run(["tail", file], e);
    expect(header(cold.stdout, "count")).toBe("20 (newest; earlier rows exist)");
    await run(["next", "e1000021:1", "1", "--session", file], e);
    const warm = await run(["tail", file], e);
    const total = (await reference(undefined)).length;
    expect(header(warm.stdout, "count")).toBe(`20 of ${total}`);
    const kinds = await run(["tail", file, "--kind", "human"], e);
    expect(header(kinds.stdout, "count")).toBe(`20 of ${(await reference("all")).filter((x) => x.kind === "human").length}`);
    expect(idsOf(warm.stdout, "tail")).toEqual(idsOf(cold.stdout, "tail"));
  });
});
