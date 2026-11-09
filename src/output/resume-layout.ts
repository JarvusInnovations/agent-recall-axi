/**
 * What each printed part of a resume pack costs against its budget (specs/data-model.md#resume-pack):
 * the renderer's layout (src/output/resume.ts) as numbers, so the library can bound the rendered
 * bytes without producing TOON. A leaf: no TOON here, only the same pure cuts the renderer makes.
 *
 * Each cost is an upper bound on the UTF-8 bytes the part prints as. A text costs its length as
 * a JSON string (quotes and escapes included); TOON quotes and escapes no more than JSON does,
 * and leaves a safe string bare. Times print at most `"MM-DD HH:MM:SS"` (16 bytes quoted), kinds
 * at most `human.answer` (12), a call's status at most `persisted 999.9k` (16, 18 allowed).
 */
import { formatId } from "../lib/ids.js";
import { AUTHORITY, type Event } from "../lib/model.js";
import { detail, DETAIL_CAP, targetCut } from "./truncate.js";

/** The row cap a `tools` target is cut to (render.ts TARGET_HEAD). */
const TARGET_CAP = 120;

/**
 * `  - id: "<id>"` / `    t: "<t>"` / `    kind: <kind>` / `    text: <text>`, one line each:
 * 8+2+1, 7+16+1, 10+12+1, 10+1 bytes around the id and the text.
 */
export const HUMAN_ITEM = 69;
/** A claim item: the human item without its `kind` line. */
export const CLAIM_ITEM = 46;
/** `summary:` and its `  id:`, `  t:`, `  text:` lines: 9, 6+2+1, 5+16+1, 8+1. */
export const SUMMARY_BLOCK = 49;
/** `summary: "dropped to meet the budget; show <id> --full"`, around the id. */
export const SUMMARY_DROPPED = 64;
/** A `tools` row: `  "<id>","<t>",<tool>,<target>,<result>` around the id, tool and target. */
export const TOOL_ROW = 43;
/** The layer key lines: `human[n]:`, `tools[n]{id,t,tool,target,result}:`, `claims[n]:` (n up to 7 digits). */
export const LAYER_KEYS = 80;

/** A text's cost: its UTF-8 length as a JSON string. */
export function textCost(text: string): number {
  return Buffer.byteLength(JSON.stringify(text), "utf8");
}

/** The summary's printed text: cut at the detail cap with the house marker (truncation.md#caps). */
export function summaryText(ev: Event): string {
  return detail(ev.text, DETAIL_CAP).text;
}

/** What an event of the pack costs as printed, by its layer (its kind). */
export function packCost(ev: Event): number {
  const id = formatId(ev.id).length;
  if (ev.kind === "summary") return SUMMARY_BLOCK + id + textCost(summaryText(ev));
  if (ev.kind === "call") return TOOL_ROW + id + textCost(ev.tool ?? "?") + textCost(ev.target !== undefined ? targetCut(ev, TARGET_CAP).text : "");
  if (ev.kind === "assistant") return CLAIM_ITEM + id + textCost(ev.text);
  if (AUTHORITY[ev.kind] === "H") return HUMAN_ITEM + id + textCost(ev.text);
  return id + textCost(ev.text);
}

/** The line a dropped summary leaves in its place. */
export function summaryDroppedCost(ev: Event): number {
  return SUMMARY_DROPPED + formatId(ev.id).length;
}
