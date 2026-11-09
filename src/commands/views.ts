/**
 * The kind-scoped views of the rows rung (specs/cli.md#turns-session, #human-session,
 * #tools-session, #compactions-session): thin renderings of src/lib/turns.ts, human.ts, tools.ts
 * and windows.ts.
 */
import { encode } from "@toon-format/toon";
import { AxiError } from "axi-sdk-js";
import { AgentSessionError } from "../lib/errors.js";
import { formatId } from "../lib/ids.js";
import { AUTHORITY, KINDS, type Event, type EventId, type Session } from "../lib/model.js";
import { events, readPointer, pointerAccess } from "../lib/events.js";
import { turns, type Turn } from "../lib/turns.js";
import { DEFAULT_HUMAN_BUDGET, humanMessages } from "../lib/human.js";
import { toolCallsWithResults, toolFilter, type ToolCall, type ToolOpts } from "../lib/tools.js";
import { boundaries } from "../lib/windows.js";
import { tableFor } from "../lib/cache/index.js";
import { findCommand, TOOLS_FIELDS, type ToolsField } from "../reference.js";
import { getBool, getNumber, getString, parseFlags, usageLine, type Parsed } from "../flags.js";
import { renderCommandHelp } from "../output/help.js";
import { DEFAULT_HEAD, headCut, oneLine, renderBlockList, renderHelp, renderRows, renderStatus, targetCut, TARGET_HEAD, timeColumn } from "../output/render.js";
import { formatSize } from "../output/sizes.js";
import { detail, DETAIL_CAP } from "../output/truncate.js";
import { countNewlines } from "../lib/reader.js";
import { headerName } from "./sessions.js";
import { jsonOutTarget, openJsonOut, withJsonOutLine, writeJsonOut, type JsonOutTarget, type JsonSink, type JsonStream } from "./json-out.js";
import { open as openFile, stat } from "node:fs/promises";

/** Lines in a file: complete lines, plus a trailing line still being written. */
async function lineCount(path: string): Promise<number> {
  const [newlines, st] = await Promise.all([countNewlines(path), stat(path)]);
  if (st.size === 0) return 0;
  const fh = await openFile(path, "r");
  try {
    const b = Buffer.alloc(1);
    await fh.read(b, 0, 1, st.size - 1);
    return newlines + (b[0] === 0x0a ? 0 : 1);
  } finally {
    await fh.close();
  }
}
import {
  BIN,
  carry,
  collapseHome,
  parseRange,
  rewriteNotice,
  scopeOf,
  sessionFromArg,
  sessionHint,
  shellArg,
  windowCarry,
  windowFlag,
  withNotice,
  zoneOf,
  type Io,
  type Range,
  type SessionHint,
} from "./common.js";

type Doc = Record<string, unknown>;

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

/** Flags, the one `<session>`, and the help short-circuit every view shares. */
function parseView(name: string, args: string[]): Parsed | string {
  const p = parseFlags(name, args, findCommand(name)?.flags ?? []);
  if (p.help) return renderCommandHelp(name) ?? "";
  if (p.positionals.length !== 1) {
    throw new AxiError(p.positionals.length ? `${name} takes one <session>` : `${name} needs a <session>`, "USAGE", [usageLine(name)]);
  }
  return p;
}

interface Opened {
  session: Session;
  hint: SessionHint;
  notice: string | undefined;
  /** `<s8> <title>` (cli.md#conventions). */
  title: string;
}

async function open(name: string, p: Parsed, io: Io, tz: string): Promise<Opened> {
  scopeOf(name, p, io);
  const ref = p.positionals[0]!;
  const session = await sessionFromArg(name, ref, p, io);
  const notice = await rewriteNotice(session, io, tz);
  return { session, hint: await sessionHint(name, ref, session, p, io), notice, title: await headerName(session) };
}

function sessionHeader(o: Opened): Doc {
  const header: Doc = {};
  if (o.notice) header.notice = o.notice;
  header.session = o.title;
  if (o.session.kind === "subagent") {
    header.kind = "subagent";
    if (o.session.parent) header.parent = o.session.parent.slice(0, 8);
  }
  return header;
}

/** `--from`/`--since`/`--to` as given, for hints that keep the caller's range. */
function rangeCarry(p: Parsed, opts: { from?: boolean; to?: boolean } = { from: true, to: true }): string {
  let out = "";
  if (opts.from !== false) {
    if (getString(p, "from") !== undefined) out += ` --from ${shellArg(getString(p, "from")!)}`;
    if (getString(p, "since") !== undefined) out += ` --since ${shellArg(getString(p, "since")!)}`;
  }
  if (opts.to !== false && getString(p, "to") !== undefined) out += ` --to ${shellArg(getString(p, "to")!)}`;
  return out;
}

function applyRange<T extends object>(into: T, range: Range): T & Range {
  const out = into as T & Range;
  if (range.from) out.from = range.from;
  if (range.to) out.to = range.to;
  return out;
}

/** Rows' `t` column for anything with a time (row-format.md#columns). */
function times(items: Array<{ t?: string }>, tz: string) {
  return timeColumn(items as Event[], tz);
}

/** The `H`-class kinds `human` prints (cli.md#human-session). */
const H_KINDS = KINDS.filter((k) => AUTHORITY[k] === "H");

/** An export opened before the view's read, its document begun; undefined when not asked for. */
async function streamOpen(target: JsonOutTarget | undefined, meta: Record<string, unknown>, key: string): Promise<JsonSink | undefined> {
  if (!target) return undefined;
  const sink = await openJsonOut(target);
  await sink.out.begin(meta, key);
  return sink;
}

/** Run the view's read; a failure removes the partial export. */
async function sinkGuard(sink: JsonSink | undefined, read: () => Promise<unknown>): Promise<void> {
  try {
    await read();
    await sink?.out.end();
  } catch (err) {
    await sink?.abort();
    throw err;
  }
}

/** Close the export (when there is one) and name it in the output. */
async function streamClose(sink: JsonSink | undefined, out: string): Promise<string> {
  return sink ? withJsonOutLine(out, await sink.close()) : out;
}

/** The output, with the `--json-out` export written when asked (cli.md#conventions). */
async function withJson(target: JsonOutTarget | undefined, out: string, fill: (j: JsonStream) => Promise<void>): Promise<string> {
  if (!target) return out;
  return withJsonOutLine(out, await writeJsonOut(target, fill));
}

function assemble(parts: string[], help: string[]): string {
  const h = renderHelp(help);
  return [...parts, ...(h ? [h] : [])].join("\n");
}

// ---------------------------------------------------------------------------------------------
// turns

export async function turnsCommand(args: string[], io: Io): Promise<string> {
  const parsed = parseView("turns", args);
  if (typeof parsed === "string") return parsed;
  const p = parsed;
  const tz = zoneOf(p, io);
  const range = parseRange("turns", p, tz, io.now, true);
  const window = windowFlag(p);
  const full = getBool(p, "full");
  const limit = getNumber(p, "limit") ?? (full ? 0 : 30);
  const head = full ? 0 : DEFAULT_HEAD;
  const jsonOut = await jsonOutTarget("turns", p, io);
  const o = await open("turns", p, io, tz);
  const stats = { lines: 0 };
  let kept: Turn[] = [];
  let matching = 0;
  // The export streams every turn during the read that builds the view (cli.md#conventions).
  const sink = await streamOpen(jsonOut, { session: o.session.id }, "turns");
  await sinkGuard(sink, () =>
    withNotice(o.notice, async () => {
      const opts = applyRange({ cache: { env: io.env }, ...(window !== undefined ? { window } : {}) }, range);
      for await (const t of turns(o.session, opts, stats)) {
        matching++;
        kept.push(t);
        await sink?.out.item(t);
        if (limit > 0 && kept.length > limit * 2) kept = kept.slice(kept.length - limit);
      }
    }),
  );
  const assembleTurns = async (parts: string[], help: string[]) => streamClose(sink, assemble(parts, help));
  if (limit > 0 && kept.length > limit) kept = kept.slice(kept.length - limit);

  const header = sessionHeader(o);
  const s = o.hint.ref;
  const tzc = carry(p);
  const win = windowCarry(p);
  const help: string[] = [];
  if (kept.length === 0) {
    header.tz = tz;
    header.turns = `0 turns in ${o.session.short} (${plural(await lineCount(o.session.path), "line")})`;
    if (range.from || range.to || window !== undefined) help.push(`Run \`${BIN} turns ${s}${tzc}\` for every turn of the session`);
    return assembleTurns([encode(header)], help);
  }
  const time = times(kept, tz);
  Object.assign(header, time.header);
  header.tz = tz;
  header.count = `${kept.length} of ${matching}`;
  let cut = 0;
  header.turns = kept.map((t) => {
    const prompt = t.prompt ? headCut(oneLine(t.prompt.text), head) : { text: "(session start)", cut: false };
    if (prompt.cut) cut++;
    return { id: formatId(t.id), t: time.format(t as unknown as Event), prompt: prompt.text, events: t.events, calls: t.calls, ended: t.ended };
  });
  const first = kept[0]!;
  const last = kept[kept.length - 1]!;
  if (matching > kept.length) {
    const earlier = matching - kept.length;
    help.push(`Showing the last ${kept.length} of ${matching} turns; raise --limit or narrow with --from`);
    help.push(
      `Run \`${BIN} turns ${s} --to ${formatId(first.id)}${rangeCarry(p, { to: false })}${win}${getString(p, "limit") !== undefined ? ` --limit ${getString(p, "limit")}` : ""}${tzc}\` for the ${plural(earlier, "earlier turn")} (showing the last ${kept.length} of ${matching} turns)`,
    );
  }
  help.push(`Run \`${BIN} next ${formatId(last.id)}${o.hint.showCarry}${tzc}\` to read the last turn's rows`);
  help.push(`Run \`${BIN} human ${s}${rangeCarry(p)}${win}${tzc}\` for the prompts whole`);
  if (cut > 0) help.push(`Run \`${BIN} turns ${s}${rangeCarry(p)}${win} --full${tzc}\` for the whole prompt of the ${plural(cut, "turn")} cut to ${head} chars`);
  return assembleTurns([encode(header)], help);
}

// ---------------------------------------------------------------------------------------------
// human

export async function humanCommand(args: string[], io: Io): Promise<string> {
  const parsed = parseView("human", args);
  if (typeof parsed === "string") return parsed;
  const p = parsed;
  const tz = zoneOf(p, io);
  const range = parseRange("human", p, tz, io.now, true);
  const window = windowFlag(p);
  const full = getBool(p, "full");
  const rows = getBool(p, "rows");
  const budget = full ? Infinity : (getNumber(p, "budget") ?? DEFAULT_HUMAN_BUDGET);
  const jsonOut = await jsonOutTarget("human", p, io);
  const o = await open("human", p, io, tz);
  const humanOpts = applyRange({ cache: { env: io.env }, ...(window !== undefined ? { window } : {}) }, range);
  const r = await withNotice(o.notice, () => humanMessages(o.session, { ...humanOpts, budget }));

  const header = sessionHeader(o);
  const s = o.hint.ref;
  const tzc = carry(p);
  const win = windowCarry(p);
  header.authority = "H (verbatim)";
  const help: string[] = [];
  const msgs = r.messages;
  const time = times([...msgs, ...(r.summary ? [r.summary] : [])], tz);
  Object.assign(header, time.header);
  header.tz = tz;
  const parts: string[] = [];
  if (msgs.length === 0) {
    header.messages = `0 human messages in ${o.session.short}`;
    parts.push(encode(header));
  } else {
    header.count = `${msgs.length} of ${plural(r.matching, "human message")}`;
    if (r.omitted > 0 && r.continueTo) {
      // The continuation keeps the caller's range start, window, budget and view.
      const view = `${rangeCarry(p, { to: false })}${win}${getString(p, "budget") !== undefined ? ` --budget ${getString(p, "budget")}` : ""}${rows ? " --rows" : ""}`;
      const cont = `human ${s} --to ${formatId(r.continueTo)}${view}${tzc}`;
      header.omitted = `${plural(r.omitted, "earlier message")}; continue with ${cont}`;
      help.push(`Run \`${BIN} ${cont}\` for the ${plural(r.omitted, "earlier message")}`);
    }
    if (rows) {
      const rendered = renderRows(msgs, tz, { head: full ? 0 : DEFAULT_HEAD });
      header.messages = rendered.rows;
      parts.push(encode(header));
      if (rendered.cut > 0) help.push(`Run \`${BIN} show ${formatId(rendered.firstCut!)}${o.hint.showCarry}${tzc}\` to see one cut message whole`);
    } else {
      parts.push(encode(header));
      // Block form: each message whole (authority.md#verbatim-guarantee).
      parts.push(renderBlockList("messages", msgs.map((m) => ({ id: formatId(m.id), t: time.format(m), kind: m.kind, text: m.text }))));
    }
  }
  if (r.summary) {
    const sm = r.summary;
    const doc: Doc = { id: formatId(sm.id) };
    if (sm.t) doc.t = time.format(sm);
    doc.authority = "C";
    // C text: the detail cap and house marker under a budget (truncation.md#caps).
    const cut = full ? { text: sm.text, cut: false } : detail(sm.text, DETAIL_CAP);
    doc.text = cut.text;
    parts.push(encode({ summary: doc }));
    if (cut.cut) help.push(`Run \`${BIN} show ${formatId(sm.id)} --full${o.hint.showCarry}${tzc}\` for the whole summary (${formatSize(sm.size)} chars)`);
  }
  if (msgs.length === 0 && (range.from || range.to || window !== undefined)) help.push(`Run \`${BIN} human ${s}${tzc}\` for every human message of the session`);
  if (msgs.length > 0) help.push(`Run \`${BIN} turns ${s}${rangeCarry(p)}${win}${tzc}\` for one row per prompt with what followed`);
  return withJson(jsonOut, assemble(parts, help), async (j) => {
    // Every message whole, no budget, streamed from a second read (cli.md#conventions).
    await j.begin({ session: o.session.id, matching: r.matching }, "messages");
    for await (const m of events(o.session, { ...humanOpts, kinds: H_KINDS })) await j.item(m);
    await j.end(r.summary ? { summary: r.summary } : {});
  });
}

// ---------------------------------------------------------------------------------------------
// tools

function parseToolsFields(text: string | undefined): ToolsField[] {
  if (text === undefined) return [];
  const names = text.split(",").map((f) => f.trim()).filter(Boolean);
  const bad = names.filter((n) => !(TOOLS_FIELDS as readonly string[]).includes(n));
  if (bad.length || names.length === 0) {
    throw new AxiError(`unknown field: ${bad.join(", ") || "(empty)"}`, "VALIDATION_ERROR", [`fields: ${TOOLS_FIELDS.join(", ")}`]);
  }
  return [...new Set(names)] as ToolsField[];
}

function toolsField(c: ToolCall, f: ToolsField): string | boolean {
  switch (f) {
    case "result_id":
      return c.call.result ? formatId(c.call.result) : "";
    case "error":
      return c.call.status?.state === "error";
    case "files":
      return (c.call.files ?? []).join(", ");
  }
}

export async function toolsCommand(args: string[], io: Io): Promise<string> {
  const parsed = parseView("tools", args);
  if (typeof parsed === "string") return parsed;
  const p = parsed;
  const tz = zoneOf(p, io);
  const range = parseRange("tools", p, tz, io.now, true);
  const window = windowFlag(p);
  const full = getBool(p, "full");
  const limit = getNumber(p, "limit") ?? (full ? 0 : 30);
  const fields = parseToolsFields(getString(p, "fields"));
  const filters: Pick<ToolOpts, "name" | "file" | "errors"> = {};
  if (getString(p, "name") !== undefined) filters.name = getString(p, "name")!;
  if (getString(p, "file") !== undefined) filters.file = getString(p, "file")!;
  if (getBool(p, "errors")) filters.errors = true;
  try {
    toolFilter(filters); // a bad pattern fails before any file is opened
  } catch (err) {
    if (err instanceof AgentSessionError) throw new AxiError(err.message, err.code, err.suggestions);
    throw err;
  }
  const jsonOut = await jsonOutTarget("tools", p, io);
  const o = await open("tools", p, io, tz);
  let kept: ToolCall[] = [];
  let matching = 0;
  // The export streams every call, with its result, during the read that builds the view; only
  // the export needs results without --full, and each is written and released as it is read.
  const sink = await streamOpen(jsonOut, { session: o.session.id }, "tools");
  await sinkGuard(sink, () =>
    withNotice(o.notice, async () => {
      const opts = applyRange({ ...filters, cache: { env: io.env }, withResults: full || sink !== undefined, ...(window !== undefined ? { window } : {}) }, range);
      for await (const c of toolCallsWithResults(o.session, opts)) {
        matching++;
        await sink?.out.item(c);
        kept.push(full ? c : { call: c.call });
        if (limit > 0 && kept.length > limit * 2) kept = kept.slice(kept.length - limit);
      }
    }),
  );
  const assembleTools = async (parts: string[], help: string[]) => streamClose(sink, assemble(parts, help));
  if (limit > 0 && kept.length > limit) kept = kept.slice(kept.length - limit);

  const header = sessionHeader(o);
  const s = o.hint.ref;
  const tzc = carry(p);
  const win = windowCarry(p);
  let filterFlags = "";
  if (filters.name !== undefined) filterFlags += ` --name ${shellArg(filters.name)}`;
  if (filters.file !== undefined) filterFlags += ` --file ${shellArg(filters.file)}`;
  if (filters.errors) filterFlags += " --errors";
  const help: string[] = [];
  if (kept.length === 0) {
    header.tz = tz;
    header.tools = `0 tool calls match in ${o.session.short}`;
    if (filterFlags || range.from || range.to || window !== undefined) help.push(`Run \`${BIN} tools ${s}${tzc}\` for every tool call of the session`);
    return assembleTools([encode(header)], help);
  }
  const calls = kept.map((c) => c.call);
  const time = times(calls, tz);
  Object.assign(header, time.header);
  header.tz = tz;
  header.count = `${kept.length} of ${matching}`;
  const parts: string[] = [];
  let cut = 0;
  let firstCut: EventId | undefined;
  if (!full) {
    header.tools = kept.map((c) => {
      const ev = c.call;
      const target = ev.target !== undefined ? targetCut(ev, TARGET_HEAD) : { text: "", cut: false };
      if (target.cut) {
        cut++;
        firstCut ??= ev.id;
      }
      const row: Record<string, string | boolean> = { id: formatId(ev.id), t: time.format(ev), tool: ev.tool ?? "?", target: target.text, result: renderStatus(ev.status) };
      for (const f of fields) row[f] = toolsField(c, f);
      return row;
    });
    parts.push(encode(header));
  } else {
    parts.push(encode(header));
    const blocks: Doc[] = [];
    for (const c of kept) blocks.push(await toolBlock(c, o.session, time.format, fields));
    parts.push(renderBlockList("tools", blocks));
  }
  const first = calls[0]!;
  const last = calls[calls.length - 1]!;
  const view = `${filterFlags}${win}${getString(p, "limit") !== undefined ? ` --limit ${getString(p, "limit")}` : ""}${full ? " --full" : ""}${fields.length ? ` --fields ${fields.join(",")}` : ""}`;
  if (matching > kept.length) help.push(`Run \`${BIN} tools ${s} --to ${formatId(first.id)}${rangeCarry(p, { to: false })}${view}${tzc}\` for the ${plural(matching - kept.length, "earlier call")}`);
  help.push(`Run \`${BIN} show ${formatId(last.id)}${o.hint.showCarry}${tzc}\` for a call with its input and result`);
  const persisted = calls.filter((c) => c.status?.state === "persisted" && c.result).pop();
  if (persisted && !full) help.push(`Run \`${BIN} show ${formatId(persisted.result!)} --full${o.hint.showCarry}${tzc}\` to read a persisted output`);
  if (cut > 0) help.push(`Run \`${BIN} show ${formatId(firstCut!)}${o.hint.showCarry}${tzc}\` to see a target cut to ${TARGET_HEAD} chars whole, or add --full`);
  return assembleTools(parts, help);
}

async function toolBlock(c: ToolCall, session: Session, fmt: (ev: Event) => string, fields: readonly ToolsField[]): Promise<Doc> {
  const ev = c.call;
  const doc: Doc = { id: formatId(ev.id), t: fmt(ev), tool: ev.tool ?? "?" };
  if (ev.target !== undefined) doc.target = ev.target;
  doc.result = renderStatus(ev.status);
  for (const f of fields) doc[f] = toolsField(c, f);
  if (ev.input !== undefined) doc.input = ev.input;
  const r = c.result;
  if (r) {
    doc.result_id = formatId(r.id);
    if (r.pointer) {
      const pt = r.pointer;
      const access = await pointerAccess(pt, session);
      const missing = !access.followable && access.reason === "the file is missing";
      const read = access.followable ? await readPointer(pt, session) : undefined;
      const line = (exists: boolean) => `${collapseHome(pt.path)} (${formatSize(pt.bytes)}, ${exists ? "exists" : "missing"})`;
      if (read?.followed) {
        doc.pointer = line(true);
        doc.result_text = read.text;
      } else {
        doc.pointer = line(!missing && !read && pt.exists);
        if (!access.followable && !missing) {
          // Named in the log but outside this session's tool-results: shown, never read.
          doc.followed = false;
          doc.reason = access.reason;
        }
        doc.preview = pt.preview;
      }
    } else doc.result_text = r.text;
  }
  return doc;
}

// ---------------------------------------------------------------------------------------------
// compactions

const tokens = (v: unknown) => (typeof v === "number" ? formatSize(v) : "");

export async function compactionsCommand(args: string[], io: Io): Promise<string> {
  const parsed = parseView("compactions", args);
  if (typeof parsed === "string") return parsed;
  const p = parsed;
  const tz = zoneOf(p, io);
  const full = getBool(p, "full");
  const o = await open("compactions", p, io, tz);
  const { table, list } = await withNotice(o.notice, async () => {
    const table = await tableFor(o.session, { env: io.env });
    return { table, list: await boundaries(o.session, { table }) };
  });
  const header = sessionHeader(o);
  const s = o.hint.ref;
  const tzc = carry(p);
  const help: string[] = [];
  if (list.length === 0) {
    header.tz = tz;
    header.compactions = `0 in ${o.session.short} (one window, ${plural(table.seq, "line")})`;
    help.push(`Run \`${BIN} human ${s}${tzc}\` for every human message of the session`);
    return assemble([encode(header)], help);
  }
  const time = times(list.map((b) => b.compaction), tz);
  Object.assign(header, time.header);
  header.tz = tz;
  const summaryId = (b: (typeof list)[number]) => {
    const m = b.compaction.meta?.summary as EventId | undefined;
    return m ? formatId(m) : b.summary ? formatId(b.summary.id) : "";
  };
  const parts: string[] = [];
  if (!full) {
    header.compactions = list.map((b) => {
      const m = b.compaction.meta ?? {};
      return { id: formatId(b.compaction.id), t: time.format(b.compaction), trigger: typeof m.trigger === "string" ? m.trigger : "unknown", pre: tokens(m.pre_tokens), post: tokens(m.post_tokens), summary: summaryId(b), window: b.opens };
    });
    parts.push(encode(header));
  } else {
    parts.push(encode(header));
    parts.push(
      renderBlockList(
        "compactions",
        list.map((b) => {
          const m = b.compaction.meta ?? {};
          const doc: Doc = { id: formatId(b.compaction.id), t: time.format(b.compaction), trigger: typeof m.trigger === "string" ? m.trigger : "unknown" };
          if (typeof m.pre_tokens === "number") doc.pre = tokens(m.pre_tokens);
          if (typeof m.post_tokens === "number") doc.post = tokens(m.post_tokens);
          if (typeof m.dropped_tokens === "number") doc.dropped = tokens(m.dropped_tokens);
          doc.summary = summaryId(b);
          doc.window = b.opens;
          doc.before = `${plural(b.before, "event")} in window ${b.opens - 1}`;
          doc.after = `${plural(b.after, "event")} in window ${b.opens}`;
          if (b.summary) doc.summary_text = b.summary.text;
          return doc;
        }),
      ),
    );
  }
  const lastB = list[list.length - 1]!;
  if (!lastB.compaction.meta?.synthesized) help.push(`Run \`${BIN} show ${formatId(lastB.compaction.id)}${o.hint.showCarry}${tzc}\` for the boundary and the events it preserved`);
  help.push(`Run \`${BIN} human ${s} --window ${lastB.opens}${tzc}\` for what the human said after the last boundary`);
  if (!full) help.push(`Run \`${BIN} compactions ${s} --full${tzc}\` for each summary's text and the window sizes`);
  return assemble(parts, help);
}
