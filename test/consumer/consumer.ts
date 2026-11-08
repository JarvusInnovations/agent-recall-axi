/**
 * A consumer of the published package (specs/api.md), compiled by `bun run check:types` after
 * `bun run build`: it imports only from `agent-session-axi` and `agent-session-axi/render`, so
 * the `types` conditions of package.json `exports` resolve to `dist/`, and it uses every name
 * with the signature api.md gives it. Never run; a type error here is a spec/surface mismatch.
 *
 * Not yet here, owned by plans/sessions-and-recall.md: recall, RecallResult, sessionStats,
 * findAcross.
 */
import {
  openRoot, listProjects, listSessions, resolveSession, openSession,
  events, around, next, prev, tail, turns, windows, compactions,
  humanMessages, toolCalls, find, show, buildResumePack,
  parseId, formatId, parseWhen, parseSpan, resolveId, readPointer, linkedResult,
  cacheStatus, clearCache, checkRewrite,
  type Session, type Event, type Turn, type Window, type Pointer, type ResumePack,
  type FindQuery, type Hit, type Scope, type EventId,
  AgentSessionError,
} from "agent-session-axi";
import { renderResumePack } from "agent-session-axi/render";

export async function consumer(): Promise<string> {
  const root: { root: string } = await openRoot({ root: "/home/user/.claude/projects" });
  const scope: Scope = { root: root.root, project: "all", cwd: "/home/user/src/widget", subagents: false };
  for await (const p of listProjects(scope)) void p.cwd;
  for await (const s of listSessions(scope, { since: new Date(0), limit: 5 })) void s;
  const session: Session = await resolveSession("latest", scope);
  const same: Session = await openSession(session.path);
  const id: EventId | null = parseId("7a2f1c3e:418.2");
  const text: string = formatId(id ?? { session: same.short, seq: 1 });
  const at = await resolveId(text, scope, { session: session.id });
  const anchor: EventId = at.id;

  const rows: Event[] = [];
  for await (const ev of events(session, { kinds: "all", window: "last", from: new Date(0), to: anchor })) rows.push(ev); // limit, newestLast: issue (events() omits them)
  const last: Event[] = await tail(session, 20, { kinds: ["human", "assistant"] });
  const a = await around(session, anchor, 5, 5);
  const n = await next(session, anchor, 20);
  const p = await prev(session, anchor, 20);
  const edges: boolean[] = [a.atStart, a.atEnd, n.atEnd, p.atStart];
  const shown = await show(session, anchor);
  for await (const t of turns(session, { window: "1.." })) void (t satisfies Turn);
  const ws: Window[] = await windows(session);
  const cs: Event[] = await compactions(session);
  const h = await humanMessages(session, { window: "last", budget: 0 });
  const humans: Event[] = h.messages;
  const counts: number[] = [h.matching, h.omitted];
  const cont: EventId | undefined = h.continueTo;
  for await (const c of toolCalls(session, { name: "bash", file: "*.env", errors: true })) void c.status;
  const q: FindQuery = { phrase: "redirect", regex: false, file: "src/*.ts", tool: "bash", kinds: ["human"], window: 0, context: { before: 1, after: 1 }, limit: 10, deep: true };
  for await (const hit of find(session, q)) void (hit satisfies Hit).why;
  const pointer: Pointer | undefined = rows.find((e) => e.pointer)?.pointer;
  if (pointer) void (await readPointer(pointer, session)).followed;
  const partner: Event | undefined = rows[0] ? await linkedResult(session, rows[0]) : undefined;
  const when: Date = parseWhen("-1d", { tz: "UTC", now: new Date(), endOfDay: true });
  const span: number = parseSpan("90d");
  void (await cacheStatus()).size;
  void (await clearCache({ paths: [session.path] })).removed;
  void (await checkRewrite(session.path)).rewritten;

  const pack: ResumePack = await buildResumePack(session, { window: "last", budget: 6000, tools: 10, claims: 3 });
  const layers: Event[] = [...pack.human, ...pack.tools, ...pack.claims, ...(pack.summary ? [pack.summary] : [])];
  const used: number = pack.budget.used + pack.budget.limit + pack.window.index + pack.window.count + pack.omitted.human;
  const out: string = renderResumePack(pack, { tz: "UTC", ref: session.short, showCarry: "", carry: "", notice: "" });

  try {
    await resolveSession("0000");
  } catch (err) {
    if (err instanceof AgentSessionError) {
      const code: "USAGE" | "VALIDATION_ERROR" | "NOT_FOUND" | "AMBIGUOUS_SESSION" | "NO_SESSIONS" | "UNREADABLE" | "INTERNAL_ERROR" = err.code;
      const help: string[] = err.suggestions;
      void [code, help, err.details];
    }
  }
  void [last, edges, shown, ws, cs, humans, counts, cont, partner, when, span, layers, used, cont];
  return out;
}
