import { readLines } from "../../reader.js";

/**
 * Is this a Claude Code session log? Cheap: the extension and the first lines. I/O errors
 * (EACCES, ENOENT) propagate: an unreadable file is not "not a log" (errors.md#codes).
 */
export async function detect(path: string): Promise<boolean> {
  if (!path.endsWith(".jsonl")) return false;
  let n = 0;
  let sawLine = false;
  for await (const line of readLines(path)) {
    if (++n > 20) break;
    if (!line.text.trim()) continue;
    sawLine = true;
    try {
      const obj = JSON.parse(line.text) as unknown;
      if (typeof obj === "object" && obj !== null && typeof (obj as { type?: unknown }).type === "string") return true;
    } catch {
      // a malformed line does not disqualify the file
    }
  }
  return !sawLine; // an empty log is still a log
}
