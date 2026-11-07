import type { Adapter } from "../adapter.js";
import type { Entry, SeqRange, Session } from "../../model.js";
import { readLines, type Line } from "../../reader.js";
import { classify } from "./classify.js";
import { detect } from "./detect.js";
import { ADAPTER_ID, defaultRoot, listProjects, listSessions, sessionForPath } from "./sessions.js";

/** One line → Entry. Malformed lines are entries too (counted, kept for `show --raw`). */
export function parseLine(line: Line): Entry | null {
  const entry: Entry = { seq: line.seq, offset: line.offset };
  if (!line.text.trim()) return line.partial ? null : entry; // blank line: silent
  let obj: unknown;
  try {
    obj = JSON.parse(line.text);
  } catch {
    if (line.partial) return null; // a live file mid-append: not a record yet
    entry.malformed = true;
    return entry;
  }
  if (typeof obj !== "object" || obj === null || Array.isArray(obj)) {
    entry.malformed = true;
    return entry;
  }
  const raw = obj as Record<string, unknown>;
  entry.raw = raw;
  if (typeof raw.type === "string") entry.type = raw.type;
  if (typeof raw.uuid === "string") entry.uuid = raw.uuid;
  if (typeof raw.parentUuid === "string") entry.parentUuid = raw.parentUuid;
  if (typeof raw.timestamp === "string") entry.t = raw.timestamp;
  if (raw.isSidechain === true) entry.sidechain = true;
  return entry;
}

export const claudeCode: Adapter = {
  id: ADAPTER_ID,
  detect,
  root: defaultRoot,
  listProjects,
  listSessions,
  sessionForPath,
  parse: parseLine,
  async *entries(session: Session, range?: SeqRange) {
    for await (const line of readLines(session.path, range?.to !== undefined ? { endSeq: range.to } : {})) {
      if (range?.from !== undefined && line.seq < range.from) continue;
      const e = parseLine(line);
      if (e) yield e;
    }
  },
  classify,
  // Titles (custom-title.json, ai-title, first human head) land with sessions-and-recall.
  async title() {
    return undefined;
  },
};
