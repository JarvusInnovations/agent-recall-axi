/**
 * The resume pack's TOON (specs/cli.md#resume-pack-session): the one renderer the `resume-pack`
 * command and the `agent-session-axi/render` subpath share, so a library caller gets the CLI's
 * exact bytes for the same pack.
 */
import { encode } from "@toon-format/toon";
import { formatId } from "../lib/ids.js";
import type { Event } from "../lib/model.js";
import type { ResumePack } from "../lib/resume.js";
import { DEFAULT_HEAD, headCut, oneLine, renderBlockList, renderHelp, renderStatus, targetCut, TARGET_HEAD, timeColumn } from "./render.js";
import { formatSize } from "./sizes.js";
import { summaryText } from "./resume-layout.js";

import { BIN } from "../invocation.js";

export interface RenderResumeOpts {
  /** IANA zone for the time column. */
  tz: string;
  /** How hints name the session, scope flags included; default its `<s8>`. */
  ref?: string;
  /** Appended to `show` hints so their ids resolve the way the session did (` --session <uuid>`). */
  showCarry?: string;
  /** Appended to every hint (` --tz <zone>` when the caller gave one). */
  carry?: string;
  /** A rewrite notice to print first (behaviors/id-stability.md). */
  notice?: string;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;

function windowLine(w: ResumePack["window"]): string {
  const range = w.count === 1 ? "only window 0" : `windows 0..${w.count - 1}`;
  return w.index === w.count - 1 ? `${w.index} (last; ${range})` : `${w.index} (${range})`;
}

/** specs/api.md#resume-pack: the bytes `resume-pack` prints for this pack (no trailing newline). */
export function renderResumePack(pack: ResumePack, opts: RenderResumeOpts): string {
  const s = pack.session;
  const ref = opts.ref ?? s.short;
  const showCarry = opts.showCarry ?? "";
  const carry = opts.carry ?? "";
  const header: Record<string, unknown> = {};
  if (opts.notice) header.notice = opts.notice;
  // The title as a row cell: one line, cut to the row head (data-model.md#session).
  header.session = pack.title !== undefined ? `${s.short} ${headCut(oneLine(pack.title).trim(), DEFAULT_HEAD).text}` : s.short;
  if (s.kind === "subagent") {
    header.kind = "subagent";
    if (s.parent) header.parent = s.parent.slice(0, 8);
  }
  header.window = windowLine(pack.window);
  header.budget = pack.budget.limit > 0 ? `${formatSize(pack.budget.used)} of ${formatSize(pack.budget.limit)} used` : `${formatSize(pack.budget.used)} used (no limit)`;
  header.layers = `${pack.summary || pack.omitted.summary ? "summary C; " : ""}human H (verbatim); tools C (results D); claims C`;
  const all: Event[] = [...(pack.summary ? [pack.summary] : []), ...pack.human, ...pack.tools, ...pack.claims];
  const time = timeColumn(all, opts.tz);
  Object.assign(header, time.header);
  header.tz = opts.tz;
  const help: string[] = [];
  if (pack.omitted.human > 0 && pack.omitted.continueTo) {
    // --budget 0: every omitted message, not just as many as `human`'s own budget fits.
    const cont = `human ${ref} --window ${pack.window.index} --to ${formatId(pack.omitted.continueTo)} --budget 0${carry}`;
    header.omitted = `${plural(pack.omitted.human, "earlier message")}; continue with ${cont}`;
    help.push(`Run \`${BIN} ${cont}\` for the ${plural(pack.omitted.human, "earlier message")}`);
  }

  const parts = [encode(header)];
  if (pack.summary) {
    const sm = pack.summary;
    const doc: Record<string, unknown> = { id: formatId(sm.id) };
    if (sm.t) doc.t = time.format(sm);
    // C text: the detail cap and house marker (truncation.md#caps), as in `human`.
    doc.text = summaryText(sm);
    parts.push(encode({ summary: doc }));
    if (doc.text !== sm.text) help.push(`Run \`${BIN} show ${formatId(sm.id)} --full${showCarry}${carry}\` for the whole summary (${formatSize(sm.size)} chars)`);
  }
  if (pack.omitted.summary) {
    const id = formatId(pack.omitted.summary);
    parts.push(encode({ summary: `dropped to meet the budget; show ${id} --full` }));
    help.push(`Run \`${BIN} show ${id} --full${showCarry}${carry}\` for the window's opening summary, dropped to meet the budget`);
  }
  // H, whole and verbatim (authority.md#verbatim-guarantee).
  parts.push(renderBlockList("human", pack.human.map((m) => ({ id: formatId(m.id), t: time.format(m), kind: m.kind, text: m.text }))));
  const rows = pack.tools.map((ev) => ({
    id: formatId(ev.id),
    t: time.format(ev),
    tool: ev.tool ?? "?",
    target: ev.target !== undefined ? targetCut(ev, TARGET_HEAD).text : "",
    result: renderStatus(ev.status),
  }));
  // An empty layer still prints, as `tools[0]:` (the encoder writes an empty array as `[]`).
  parts.push(rows.length ? encode({ tools: rows }) : "tools[0]:");
  parts.push(renderBlockList("claims", pack.claims.map((c) => ({ id: formatId(c.id), t: time.format(c), text: c.text }))));

  help.push(`Run \`${BIN} tail ${ref}${carry}\` to see the last rows in order`);
  help.push(`Run \`${BIN} human ${ref} --window all${carry}\` for every human message in the session`);
  const persisted = pack.tools.filter((c) => c.status?.state === "persisted" && c.result).pop();
  if (persisted) help.push(`Run \`${BIN} show ${formatId(persisted.result!)} --full${showCarry}${carry}\` to read the newest persisted output`);
  const h = renderHelp(help);
  return [...parts, ...(h ? [h] : [])].join("\n");
}
