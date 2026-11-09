/** The library surface (specs/api.md). No stdout, no process.exit, no flags, no TOON in here. */
export { AgentSessionError, ERROR_CODES, type ErrorCode } from "./errors.js";
export {
  AUTHORITY,
  DEFAULT_KINDS,
  HIDDEN_BY_DEFAULT,
  KINDS,
  isKind,
  type Authority,
  type CallStatus,
  type Entry,
  type Event,
  type EventId,
  type Kind,
  type Pointer,
  type Project,
  type SeqRange,
  type Session,
  type SessionKind,
} from "./model.js";
export { comparePosition, formatId, parseBareSeq, parseId, resolveId, resolveSession } from "./ids.js";
export { cacheDir, checkRewrite, type CacheOpts, type FileIdentity, type RewriteCheck } from "./cache/store.js";
export { parseSpan, parseWhen, resolveZone } from "./time.js";
export { allProjects, resolveScope, rootOf, type ResolvedScope, type Scope } from "./scope.js";
export { describeSession, listSessions, openSession, sessionListing, type SessionInfo, type SessionListing } from "./session.js";
export { events, linkedResult, listEvents, pointerAccess, readPointer, show, tail, type PointerAccess, type ListOpts, type Listing, type Shown, type ShownEvent } from "./events.js";
export { around, next, prev, type AnchorNote, type PanOpts, type PanResult } from "./events.js";
export { cacheStatus, clearCache, type CacheStatus, type IndexedFile, type TableState } from "./cache/index.js";
export { claudeCode } from "./adapters/claude-code/index.js";
export type { Adapter, ClassifyContext } from "./adapters/adapter.js";

import { rootOf, allProjects, type Scope } from "./scope.js";
import { claudeCode } from "./adapters/claude-code/index.js";
import type { Project } from "./model.js";

/** The log root (specs/api.md#scope-and-sessions). */
export async function openRoot(opts: { root?: string } = {}): Promise<{ root: string; adapter: string }> {
  return { root: rootOf(opts), adapter: claudeCode.id };
}

export async function* listProjects(scope: Scope = {}): AsyncGenerator<Project> {
  for (const p of await allProjects(rootOf(scope))) yield p;
}

// find (specs/api.md#searching)
export { backtrackRisk, compileQuery, find, findListing, globRegex, WHY_ORDER, type FindListing, type FindQuery, type FindStats, type Hit, type Why } from "./find.js";

// views (specs/api.md#reading): turns, windows, compactions, human messages, tool calls
export { boundaries, compactions, formatWindow, parseWindow, resolveWindow, windowOf, windows, WINDOW_GRAMMAR, type Boundary, type Window, type WindowRange, type WindowSel } from "./windows.js";
export { unlinkedSummary, WindowCounter } from "./window-state.js";
export { turns, type Turn, type TurnEnd, type TurnOpts } from "./turns.js";
export { budgetCut, DEFAULT_HUMAN_BUDGET, humanMessages, type HumanMessages, type HumanOpts } from "./human.js";
export { toolCalls, toolCallsWithResults, toolFilter, type ToolCall, type ToolOpts } from "./tools.js";
export type { Span } from "./hold.js";

// resume pack (specs/api.md#resume-pack); the renderer is the agent-recall-axi/render subpath
export { buildResumePack, DEFAULT_RESUME_BUDGET, DEFAULT_RESUME_CLAIMS, DEFAULT_RESUME_TOOLS, packCost, type ResumePack, type ResumePackOpts } from "./resume.js";

// sessions and recall (specs/api.md#scope-and-sessions, #searching): stats, titles, the home
// view's cheap listing, cross-session find and recall
export { cachedStats, sessionStats, type SessionStats, type TitleSource } from "./stats.js";
export { homeListing, lastHumanOf, type HomeListing, type HomeSession, type LastHuman } from "./home.js";
export { findAcross, findAcrossListing, scopeSessions, type AcrossListing, type AcrossQuery, type ScopedHit, type ScopedSession, type ScopeSessions } from "./find.js";
export { recall, RECALL_KINDS, tokens, type IndexState, type Recall, type RecallOpts, type RecallResult } from "./recall.js";
