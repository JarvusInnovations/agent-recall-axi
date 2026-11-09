/**
 * The library surface as a consumer sees it (specs/api.md, plans/resume-pack-library.md): every
 * name api.md lists resolves from the package entry `agent-session-axi` (the built `dist/`,
 * through package.json `exports`, never `src/`), the `agent-session-axi/render` subpath prints
 * the CLI's bytes, no exported function writes to stdout, and AgentSessionError codes map one to
 * one onto the CLI's.
 */
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AxiError } from "axi-sdk-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as lib from "agent-session-axi";
import * as render from "agent-session-axi/render";
import { resumeSession } from "./fixtures/build.js";
import { CACHE_HOME, fx, REPO, run } from "./helpers/run.js";
import { formatError } from "../src/cli.js";
import { AgentSessionError as CliSideError, ERROR_CODES as SRC_CODES } from "../src/lib/errors.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-api-"));
const resumeFile = join(tmp, "ea00002a-0000-4000-8000-000000000000.jsonl");
beforeAll(() => writeFileSync(resumeFile, resumeSession()));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const spec = (name: string) => readFileSync(join(REPO, "specs", name), "utf8");

/** Names api.md lists but a still-open plan owns; exempt only while that plan is not done. */
const PENDING: Record<string, string> = {};

function planStatus(slug: string): string {
  const text = readFileSync(join(REPO, "plans", `${slug}.md`), "utf8");
  return /^status:\s*(\S+)/m.exec(text)?.[1] ?? "?";
}

/** The module block's names (`type` marked) and every function a signature line in a ts block names. */
function apiNames(): { values: Set<string>; types: Set<string>; render: Set<string> } {
  const text = spec("api.md");
  const block = /import \{([^}]*)\} from "agent-session-axi";/.exec(text)![1]!;
  const values = new Set<string>();
  const types = new Set<string>();
  const renderNames = new Set<string>();
  for (const raw of block.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith("type ")) types.add(raw.slice(5).trim());
    else values.add(raw);
  }
  for (const m of text.matchAll(/^import \{([^}]*)\} from "agent-session-axi\/render";/gm)) for (const n of m[1]!.split(",")) renderNames.add(n.trim());
  for (const code of text.matchAll(/```ts\n([\s\S]*?)```/g)) {
    for (const line of code[1]!.split("\n")) {
      const fn = /^([a-z][A-Za-z]*)\(/.exec(line);
      if (fn && !renderNames.has(fn[1]!)) values.add(fn[1]!);
      const iface = /^interface ([A-Z][A-Za-z]*)/.exec(line);
      if (iface) types.add(iface[1]!);
    }
  }
  return { values, types, render: renderNames };
}

describe("api.md names resolve from the package entry", () => {
  const names = apiNames();
  const dts = readFileSync(join(REPO, "dist", "src", "lib", "index.d.ts"), "utf8");
  // The qualifier is required: a type re-exported as `type X`, or declared `export interface|type|class X`.
  const exported = (n: string) => new RegExp(`(\\btype |export (interface|type|class) )${n}\\b`).test(dts);
  const pending = (n: string) => {
    const plan = PENDING[n];
    expect(plan, `${n} is in api.md but not exported`).toBeDefined();
    expect(planStatus(plan!), `${n} is still missing, but ${plan} is done`).not.toBe("done");
  };

  it("the spec lists what the plan names", () => {
    for (const n of ["buildResumePack", "parseWhen", "parseSpan", "AgentSessionError", "humanMessages", "toolCalls"]) expect(names.values).toContain(n);
    for (const n of ["ResumePack", "Session", "Event", "Window", "Scope"]) expect(names.types).toContain(n);
    expect(names.render).toEqual(new Set(["renderResumePack"]));
  });

  it("every value name is a runtime export of agent-session-axi", () => {
    const missing: string[] = [];
    for (const n of names.values) if (!(n in lib)) missing.push(n);
    for (const n of missing) pending(n);
    expect(typeof lib.buildResumePack).toBe("function");
    expect(new lib.AgentSessionError("x", "NOT_FOUND")).toBeInstanceOf(Error);
  });

  it("every type name is exported by the entry's declarations", () => {
    for (const n of names.types) if (!exported(n)) pending(n);
    expect(dts).toMatch(/\btype ResumePack\b/);
  });

  it("the render subpath exports renderResumePack", () => {
    for (const n of names.render) expect(typeof (render as Record<string, unknown>)[n]).toBe("function");
  });
});

describe("agent-session-axi/render prints the CLI's bytes", () => {
  const cases: Array<{ name: string; args: string[]; ref: () => string; opts: lib.ResumePackOpts; renderOpts: () => Parameters<typeof render.renderResumePack>[1] }> = [
    { name: "an <s8> in the current project, defaults", args: ["a6000006"], ref: () => fx("compaction"), opts: {}, renderOpts: () => ({ tz: "UTC" }) },
    {
      name: "a path, a small budget, fewer tools and claims, a zone",
      args: [resumeFile, "--budget", "2000", "--tools", "3", "--claims", "1", "--tz", "America/New_York"],
      ref: () => resumeFile,
      opts: { budget: 2000, tools: 3, claims: 1 },
      renderOpts: () => ({ tz: "America/New_York", ref: resumeFile, showCarry: ` --session ${resumeFile}`, carry: " --tz America/New_York" }),
    },
    { name: "window 0 by path", args: [resumeFile, "--window", "0"], ref: () => resumeFile, opts: { window: 0 }, renderOpts: () => ({ tz: "UTC", ref: resumeFile, showCarry: ` --session ${resumeFile}` }) },
  ];
  for (const c of cases) {
    it(c.name, async () => {
      const cli = await run(["resume-pack", ...c.args]);
      expect(cli.exitCode).toBe(0);
      const session = await lib.openSession(c.ref());
      const pack = await lib.buildResumePack(session, { ...c.opts, cache: { env: { XDG_CACHE_HOME: CACHE_HOME } } });
      expect(cli.stdout).toBe(`${render.renderResumePack(pack, c.renderOpts())}\n`);
    });
  }
});

describe("the library never writes to stdout", () => {
  it("runs every exported function with stdout captured", async () => {
    const session = await lib.openSession(fx("find"));
    const comp = await lib.openSession(fx("compaction"));
    const persisted = await lib.openSession(fx("persisted-output"));
    const id = lib.parseId("e1000018:4")!;
    const ev = (await lib.listEvents(session, { kinds: "all", limit: 0 })).rows.find((e) => e.kind === "call")!;
    const pointerEv = (await lib.listEvents(persisted, { kinds: "all", limit: 0 })).rows.find((e) => e.pointer)!;
    const cacheOpts = { env: { XDG_CACHE_HOME: mkdtempSync(join(tmp, "stdout-cache-")) } };
    const root = join(REPO, "test", "fixtures", "claude");
    const scope = { root: join(root, "projects"), cwd: "/src/widget" };
    const table = { bounds: [], checkpoints: [] } as never;
    /** Arguments per export: every function export must be listed (a new one fails until it is). */
    const calls: Record<string, () => unknown> = {
      allProjects: () => lib.allProjects(join(root, "projects")),
      around: () => lib.around(session, id, 2, 2),
      backtrackRisk: () => lib.backtrackRisk("(a+)+"),
      boundaries: () => lib.boundaries(comp, { cache: cacheOpts }),
      budgetCut: () => lib.budgetCut([ev], 10),
      buildResumePack: () => lib.buildResumePack(comp, { cache: cacheOpts }),
      cachedStats: () => lib.cachedStats(session, { cache: cacheOpts }),
      cacheDir: () => lib.cacheDir(cacheOpts),
      cacheStatus: () => lib.cacheStatus(cacheOpts),
      checkRewrite: () => lib.checkRewrite(session.path, cacheOpts),
      clearCache: () => lib.clearCache(cacheOpts),
      compactions: () => lib.compactions(comp, { cache: cacheOpts }),
      comparePosition: () => lib.comparePosition(id, id),
      compileQuery: () => lib.compileQuery({ phrase: "redirect" }),
      describeSession: () => lib.describeSession(session),
      events: () => lib.events(session),
      find: () => lib.find(session, { phrase: "redirect" }),
      findAcross: () => lib.findAcross(scope, { phrase: "redirect" }),
      findAcrossListing: () => lib.findAcrossListing(scope, { phrase: "redirect" }),
      findListing: () => lib.findListing(session, { phrase: "redirect" }),
      formatId: () => lib.formatId(id),
      formatWindow: () => lib.formatWindow("last"),
      globRegex: () => lib.globRegex("*.env"),
      homeListing: () => lib.homeListing(scope, { cache: cacheOpts }),
      humanMessages: () => lib.humanMessages(session),
      isKind: () => lib.isKind("human"),
      lastHumanOf: () => lib.lastHumanOf(session, { cache: cacheOpts }),
      linkedResult: () => lib.linkedResult(session, ev),
      listEvents: () => lib.listEvents(session),
      listProjects: () => lib.listProjects(scope),
      listSessions: () => lib.listSessions(scope),
      next: () => lib.next(session, id, 3),
      openRoot: () => lib.openRoot({ root: scope.root }),
      openSession: () => lib.openSession(session.path),
      packCost: () => lib.packCost(ev),
      parseBareSeq: () => lib.parseBareSeq("12"),
      parseId: () => lib.parseId("e1000018:4"),
      parseSpan: () => lib.parseSpan("1h"),
      parseWhen: () => lib.parseWhen("-1d", { tz: "UTC" }),
      parseWindow: () => lib.parseWindow("last"),
      pointerAccess: () => lib.pointerAccess(pointerEv.pointer!, persisted),
      prev: () => lib.prev(session, id, 3),
      readPointer: () => lib.readPointer(pointerEv.pointer!, persisted),
      recall: () => lib.recall("redirect", { scope, cache: cacheOpts }),
      resolveId: () => lib.resolveId("e1000018:4", scope),
      resolveScope: () => lib.resolveScope(scope),
      resolveSession: () => lib.resolveSession("latest", scope),
      resolveWindow: () => lib.resolveWindow(comp, "last", { cache: cacheOpts }),
      resolveZone: () => lib.resolveZone(undefined, { TZ: "UTC" }),
      rootOf: () => lib.rootOf(scope),
      scopeSessions: () => lib.scopeSessions(scope),
      sessionListing: () => lib.sessionListing(scope),
      sessionStats: () => lib.sessionStats(session, { cache: cacheOpts }),
      show: () => lib.show(session, id),
      tail: () => lib.tail(session, 5),
      tokens: () => lib.tokens("Redirect loop"),
      toolCalls: () => lib.toolCalls(session),
      toolCallsWithResults: () => lib.toolCallsWithResults(session, { withResults: true }),
      toolFilter: () => lib.toolFilter({ name: "bash" })(ev),
      turns: () => lib.turns(session),
      unlinkedSummary: () => lib.unlinkedSummary(ev),
      windowOf: () => lib.windowOf(table, id),
      windows: () => lib.windows(comp, { cache: cacheOpts }),
    };
    const settle = async (v: unknown) => {
      if (v && typeof (v as AsyncIterable<unknown>)[Symbol.asyncIterator] === "function") for await (const _ of v as AsyncIterable<unknown>) void _;
      else await v;
    };
    const fns = Object.entries(lib).filter(([, v]) => typeof v === "function" && !/^class /.test(Function.prototype.toString.call(v)));
    expect(fns.length).toBeGreaterThan(40);
    expect(fns.map(([n]) => n).filter((n) => !calls[n])).toEqual([]);
    let written = "";
    const capture = (chunk: string | Uint8Array) => {
      written += String(chunk);
      return true;
    };
    const saved = {
      out: process.stdout.write,
      err: process.stderr.write,
      log: console.log,
      error: console.error,
      warn: console.warn,
      info: console.info,
      debug: console.debug,
    };
    process.stdout.write = capture as typeof process.stdout.write;
    process.stderr.write = capture as typeof process.stderr.write;
    for (const k of ["log", "error", "warn", "info", "debug"] as const) console[k] = (...a: unknown[]) => void (written += a.join(" "));
    const failed: string[] = [];
    try {
      for (const [name] of fns) {
        try {
          await settle(calls[name]!());
        } catch (err) {
          failed.push(`${name}: ${(err as Error).message}`);
        }
      }
      await settle(render.renderResumePack(await lib.buildResumePack(comp, { cache: cacheOpts }), { tz: "UTC" }));
    } finally {
      process.stdout.write = saved.out;
      process.stderr.write = saved.err;
      Object.assign(console, { log: saved.log, error: saved.error, warn: saved.warn, info: saved.info, debug: saved.debug });
    }
    expect(failed).toEqual([]);
    expect(written).toBe("");
  });
});

describe("AgentSessionError codes map one to one onto the CLI's", () => {
  it("each code renders and exits as errors.md says, the same as the AxiError it converts to", () => {
    const table = new Map<string, number>();
    for (const m of spec("behaviors/errors.md").matchAll(/^\| `([A-Z_]+)` \| (\d) \|/gm)) table.set(m[1]!, Number(m[2]));
    // UNKNOWN_FLAG is raised by the CLI's flag parser only; every other code is the library's.
    expect([...table.keys()].filter((c) => c !== "UNKNOWN_FLAG").sort()).toEqual([...lib.ERROR_CODES].sort());
    // The CLI is built from src/, so its formatError knows src's class; the codes are the same list.
    expect([...SRC_CODES]).toEqual([...lib.ERROR_CODES]);
    for (const code of lib.ERROR_CODES) {
      const fromLib = formatError(new CliSideError("boom", code, ["Run `agent-session-axi sessions`"]));
      const fromAxi = formatError(new AxiError("boom", code, ["Run `agent-session-axi sessions`"]));
      expect(fromLib, code).toEqual(fromAxi);
      expect(fromLib.exitCode, code).toBe(table.get(code));
      expect(fromLib.output).toContain(`code: ${code}`);
    }
  });
});
