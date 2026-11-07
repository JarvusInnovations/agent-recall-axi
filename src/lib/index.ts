/** The library surface (specs/api.md). No stdout, no process.exit, no flags, no TOON in here. */
export { AgentSessionError, type ErrorCode } from "./errors.js";
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
export { comparePosition, formatId, parseId } from "./ids.js";
export { parseSpan, parseWhen, resolveZone } from "./time.js";
export { allProjects, resolveScope, rootOf, type ResolvedScope, type Scope } from "./scope.js";
export { describeSession, listSessions, openSession, sessionListing, type SessionInfo, type SessionListing } from "./session.js";
export { events, listEvents, tail, type ListOpts, type Listing } from "./events.js";
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
