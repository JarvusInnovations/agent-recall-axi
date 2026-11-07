import type { Line } from "../reader.js";
import type { Entry, Event, Project, SeqRange, Session } from "../model.js";

/**
 * Classification state carried across the entries of one session, in file order. `classify`
 * reads and updates it; it is the only state classification depends on.
 */
export interface ClassifyContext {
  session: Session;
  /** tool_use id → the call event awaiting its result (parallel and out-of-order safe). */
  pending: Map<string, Event>;
  /** Tool names by tool_use id, kept after linking so a late duplicate result still knows its tool. */
  tools: Map<string, string>;
  /** The latest compaction still waiting for its summary. */
  compaction?: Event;
}

export function newContext(session: Session): ClassifyContext {
  return { session, pending: new Map(), tools: new Map() };
}

/** specs/architecture.md#event-model-and-adapters */
export interface Adapter {
  id: string;
  /** Cheap: path shape and the first lines. */
  detect(path: string): Promise<boolean>;
  /** Default log root. */
  root(env?: Record<string, string | undefined>): string;
  listProjects(root: string): AsyncIterable<Project>;
  listSessions(project: Project, opts: { subagents?: boolean }): AsyncIterable<Session>;
  /** Session for a log file path (ignores scope). */
  sessionForPath(path: string, project?: Project): Session;
  /** Parse one line; `null` for a trailing partial line that is not (yet) a whole record. */
  parse(line: Line): Entry | null;
  entries(session: Session, range?: SeqRange): AsyncIterable<Entry>;
  classify(entry: Entry, ctx: ClassifyContext): Event[];
  title(session: Session): Promise<string | undefined>;
}
