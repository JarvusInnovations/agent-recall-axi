/**
 * Claude Code entry → events. The classification table is specs/data-model.md#kinds; this file
 * is the one place to extend it when the log format grows.
 */
import { basename, join } from "node:path";
import { existsSync } from "node:fs";
import type { ClassifyContext } from "../adapter.js";
import { AUTHORITY, type CallStatus, type Entry, type Event, type EventId, type Kind, type Pointer } from "../../model.js";

type Json = Record<string, unknown>;

/** Entry types that never yield events (data-model.md#entry). Unrecognized types are silent too. */
export const SILENT_TYPES: ReadonlySet<string> = new Set([
  "ai-title",
  "custom-title",
  "last-prompt",
  "mode",
  "permission-mode",
  "atis-latch",
  "bridge-session",
  "api-request",
  "api-request-blob",
  "api-request-shape",
  "file-history-snapshot",
  "file-history-delta",
  "queue-operation",
  "session-owner",
  "tools-used",
  "pr-link",
  "frame-link",
  "history-suppression",
]);

export function isSilentType(type: string | undefined): boolean {
  if (type === undefined) return true;
  if (SILENT_TYPES.has(type) || type.startsWith("artifact-")) return true;
  return !MESSAGE_TYPES.has(type);
}

const MESSAGE_TYPES: ReadonlySet<string> = new Set(["user", "assistant", "attachment", "system"]);

/** Path-valued input keys, in target-precedence order (data-model.md#derived-target-calltarget). */
export const PATH_KEYS = ["file_path", "path", "notebook_path", "filePath", "file", "filename"] as const;
const SUBAGENT_TOOLS = new Set(["Task", "Agent"]);
const QUESTION_TOOL = /(^|__)(AskUserQuestion|ask_?user_?question|ask_?question)$/i;

const isObj = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

interface Draft {
  block?: number;
  kind: Kind;
  text: string;
  extra?: Partial<Event>;
}

export function classify(entry: Entry, ctx: ClassifyContext): Event[] {
  const raw = entry.raw;
  if (!raw || entry.malformed || isSilentType(entry.type)) return [];
  let drafts: Draft[];
  switch (entry.type) {
    case "user":
      drafts = classifyUser(raw, ctx);
      break;
    case "assistant":
      drafts = classifyAssistant(raw);
      break;
    case "attachment":
      drafts = classifyAttachment(raw);
      break;
    case "system":
      drafts = classifySystem(raw, ctx);
      break;
    default:
      drafts = [];
  }
  if (drafts.length === 0) return [];

  const single = drafts.length === 1;
  const events = drafts.map((d) => {
    const id: EventId = { session: ctx.session.short, seq: entry.seq };
    if (!single && d.block !== undefined) id.block = d.block;
    const ev: Event = {
      id,
      kind: d.kind,
      authority: AUTHORITY[d.kind],
      text: d.text,
      size: d.text.length,
      ...d.extra,
    };
    if (entry.t) ev.t = entry.t;
    return ev;
  });

  for (const ev of events) link(ev, ctx);
  return events;
}

// ---------------------------------------------------------------------------------------------
// user

function classifyUser(raw: Json, ctx: ClassifyContext): Draft[] {
  const message = isObj(raw.message) ? raw.message : {};
  const content = message.content;
  if (raw.isCompactSummary === true) {
    // A sidechain's compaction is a subagent's context, never the main session's (context-windows.md).
    if (mainSidechain(raw, ctx)) return [notice(joinText(content), { source: "parent" })];
    return [{ kind: "summary", text: joinText(content) }];
  }
  if (typeof content === "string") {
    // String content has no stored blocks; when it splits (a hook wrapper followed by a prompt)
    // its parts are numbered in order, the way blocks are.
    const parts = userText(content, raw, ctx);
    return parts.length > 1 ? parts.map((d, i) => ({ ...d, block: i + 1 })) : parts;
  }
  if (!Array.isArray(content)) return [];
  const out: Draft[] = [];
  content.forEach((block, i) => {
    const n = i + 1;
    if (!isObj(block)) return;
    switch (block.type) {
      case "text": {
        const text = str(block.text) ?? "";
        out.push({ ...foldParts(userText(text, raw, ctx)), block: n });
        break;
      }
      case "tool_result":
        out.push({ ...toolResult(block, raw, ctx), block: n });
        break;
      case "image":
        out.push({ kind: "notice", text: "[image]", block: n });
        break;
      case "document":
        out.push({ kind: "notice", text: "[document]", block: n });
        break;
      default:
        break;
    }
  });
  return out;
}

const SKILL_PREFIX = "Base directory for this skill:";
const CONTINUED_PREFIX = "This session is being continued from a previous conversation";
const REMINDER_ONLY = /^(?:\s*<system-reminder>[\s\S]*?<\/system-reminder>)+\s*$/;
const HARNESS_WRAPPER = /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/;
const HOOK_WRAPPER = /^\s*<user-prompt-submit-hook>([\s\S]*?)(?:<\/user-prompt-submit-hook>|$)/;
/**
 * A slash command is text made only of `<command-*>` tag blocks (and the local-command output
 * the harness folds into them). A prompt that merely mentions a tag is the human's own text.
 */
const SLASH_ONLY = /^(?:\s*<(command-[\w-]+|local-command-(?:stdout|stderr|caveat))>[\s\S]*?<\/\1>)+\s*$/;
/** Text that is nothing but image placeholders (`[Image #1]`, `[Image: source: …]`). */
const IMAGE_ONLY = /^\s*(?:\[Image(?:[:\s#][^\]]*)?\]\s*)+$/;

/** A sidechain entry inside a main session file. */
function mainSidechain(raw: Json, ctx: ClassifyContext): boolean {
  return raw.isSidechain === true && ctx.session.kind === "main";
}

function originKind(raw: Json): string | undefined {
  return isObj(raw.origin) ? str(raw.origin.kind) : undefined;
}

/**
 * One user text → its drafts: usually one; two when a hook wrapper is followed by a prompt (the
 * hook output and the remainder are classified separately).
 */
function userText(text: string, raw: Json, ctx: ClassifyContext): Draft[] {
  const origin = originKind(raw);
  const trimmed = text.trimStart();
  // The legacy compaction summary (no isCompactSummary flag) is recognized by its opening
  // sentence, unless the entry says a human typed it.
  if (origin !== "human" && trimmed.startsWith(CONTINUED_PREFIX)) {
    // Driven by a parent agent (a subagent run, a sidechain): the parent's prompt, not a summary.
    if (ctx.session.kind === "subagent" || raw.isSidechain === true) return [notice(text, { source: "parent" })];
    return [{ kind: "summary", text }];
  }
  if (raw.isMeta === true) {
    if (trimmed.startsWith(SKILL_PREFIX)) return [skillDraft(text)];
    if (trimmed.includes("<task-notification>")) return [taskNotice(text)];
    return [notice(text, origin ? { source: origin } : undefined)];
  }
  if (origin === "task-notification" || trimmed.startsWith("<task-notification>")) return [taskNotice(text)];
  if (origin !== undefined && origin !== "human") return [notice(text, { source: origin })];
  if (/<command-name>/.test(text) && SLASH_ONLY.test(text)) return [slash(text, raw)];
  if (HARNESS_WRAPPER.test(text)) return [notice(text)];
  const hook = HOOK_WRAPPER.exec(text);
  if (hook) {
    const draft: Draft = { kind: "hook", text: (hook[1] ?? "").trim(), extra: { meta: { hook: "UserPromptSubmit" } } };
    const rest = text.slice(hook.index + hook[0].length).replace(/^\s+/, "");
    return rest ? [draft, ...userText(rest, raw, ctx)] : [draft];
  }
  if (REMINDER_ONLY.test(text)) return [notice(text)];
  if (/^\[Request interrupted by user/.test(trimmed) || IMAGE_ONLY.test(text)) return [notice(text)];
  // A subagent transcript, or a sidechain inside a main file, is driven by its parent agent: user
  // text there is the parent's prompt, never something the human typed, unless the entry carries
  // a human origin.
  if ((ctx.session.kind === "subagent" || raw.isSidechain === true) && origin !== "human") {
    return [notice(text, { source: "parent" })];
  }
  const meta: Json = {};
  if (raw.queuePriority === "later") meta.scheduled = true;
  const kind: Kind = raw.promptSource === "queued" ? "human.queued" : "human";
  return [{ kind, text, ...(Object.keys(meta).length ? { extra: { meta } } : {}) }];
}

/**
 * A text block that splits cannot take two ids (`.n` indexes stored blocks), so in array
 * content the hook output rides on the remainder's event as `meta.hook` / `meta.hook_text`.
 */
function foldParts(parts: Draft[]): Draft {
  if (parts.length === 1) return parts[0]!;
  const [hook, rest] = parts as [Draft, Draft];
  const meta = { ...((rest.extra?.meta as Json | undefined) ?? {}), hook: "UserPromptSubmit", hook_text: hook.text };
  return { ...rest, extra: { ...(rest.extra ?? {}), meta } };
}

function skillDraft(text: string): Draft {
  const firstLine = text.trimStart().split("\n", 1)[0] ?? "";
  const path = firstLine.slice(SKILL_PREFIX.length).trim();
  return { kind: "skill", text, extra: { meta: { skill: basename(path), path } } };
}

export function stripTags(text: string): string {
  return text
    .replace(/<\/?[A-Za-z][\w-]*(?:\s[^<>]*)?>/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function notice(text: string, meta?: Json): Draft {
  return { kind: "notice", text: stripTags(text), ...(meta ? { extra: { meta } } : {}) };
}

function tag(text: string, name: string): string | undefined {
  const m = new RegExp(`<${name}>([\\s\\S]*?)</${name}>`).exec(text);
  return m ? m[1] : undefined;
}

function taskNotice(text: string): Draft {
  const summary = tag(text, "summary")?.trim();
  const status = tag(text, "status")?.trim();
  const agent = tag(text, "task-id")?.trim();
  const meta: Json = {};
  if (status) meta.status = status;
  const extra: Partial<Event> = { meta };
  if (agent) extra.agent = agent;
  return { kind: "notice.task", text: summary ?? stripTags(text), extra };
}

function slash(text: string, raw: Json): Draft {
  const rawName = (tag(text, "command-name") ?? "").trim();
  const name = rawName.startsWith("/") ? rawName : `/${rawName}`;
  // Kept as stored (authority.md#verbatim-guarantee): only the tags are dropped.
  const args = tag(text, "command-args") ?? "";
  const meta: Json = { command: name };
  const message = tag(text, "command-message");
  if (message !== undefined) meta.message = message.trim();
  const stdout = tag(text, "local-command-stdout");
  if (stdout !== undefined) meta.stdout = stdout;
  if (raw.queuePriority === "later") meta.scheduled = true;
  return { kind: "human.slash", text: args ? `${name} ${args}` : name, extra: { meta } };
}

function blockTokens(content: unknown): { text: string; images: number; other: number } {
  if (typeof content === "string") return { text: content, images: 0, other: 0 };
  if (!Array.isArray(content)) return { text: "", images: 0, other: 0 };
  const parts: string[] = [];
  let images = 0;
  let other = 0;
  for (const b of content) {
    if (!isObj(b)) continue;
    if (b.type === "text") parts.push(str(b.text) ?? "");
    else if (b.type === "image") {
      images++;
      parts.push("[image]");
    } else {
      other++;
      parts.push(`[${str(b.type) ?? "block"}]`);
    }
  }
  return { text: parts.join("\n"), images, other };
}

function joinText(content: unknown): string {
  return blockTokens(content).text;
}

// ---------------------------------------------------------------------------------------------
// tool results and pointers

// The path runs to the end of its line or the closing tag: stored paths may contain spaces.
const POINTER_RE = /Output too large \(([\d.]+)\s*([KMG]?B)\)\.\s*Full output saved to:[ \t]*([^\n]*?)[ \t]*(?:<\/persisted-output>|\r?\n|$)/;
const SIZE_MULT: Record<string, number> = { B: 1, KB: 1_000, MB: 1_000_000, GB: 1_000_000_000 };

/**
 * Parse a persisted-output notice (with or without the `<persisted-output>` wrapper). A stored
 * path that no longer exists is looked up in the session's own sidecar `tool-results/` (logs
 * moved with their config directory keep their outputs); `exists` reports what is readable now.
 */
export function parsePointer(text: string, sidecar?: string): Pointer | undefined {
  // Only a notice the harness wrote: the wrapped form, or the bare sentence opening the text.
  // The same sentence quoted inside an ordinary result is text (data-model.md#pointer).
  const lead = text.length - text.trimStart().length;
  const body = text.slice(lead);
  let m: RegExpExecArray | null;
  if (body.startsWith("<persisted-output>")) {
    const end = body.indexOf("</persisted-output>");
    m = POINTER_RE.exec(body);
    if (m && end !== -1 && m.index > end) m = null;
  } else {
    m = POINTER_RE.exec(body);
    if (m && m.index !== 0) m = null;
  }
  if (!m || !m[3]) return undefined;
  const stored = m[3];
  const bytes = Math.round(Number(m[1]) * (SIZE_MULT[m[2]!] ?? 1));
  let preview = text;
  const pv = /Preview \(first [^)]*\):\n?/.exec(text);
  if (pv) preview = text.slice(pv.index + pv[0].length);
  preview = preview.replace(/\s*<\/persisted-output>\s*$/, "").replace(/\n?\.\.\.\s*$/, "");
  let path = stored;
  let exists = existsSync(stored);
  if (sidecar) {
    // The session's own copy wins: it is the only place a pointer may be followed from.
    const relocated = join(sidecar, "tool-results", basename(stored));
    if (relocated !== stored && existsSync(relocated)) {
      path = relocated;
      exists = true;
    }
  }
  return { path, stored, bytes, preview, exists };
}

function toolResult(block: Json, raw: Json, ctx: ClassifyContext): Draft {
  const toolUseId = str(block.tool_use_id);
  const { text, images } = blockTokens(block.content);
  const error = block.is_error === true;
  const call = toolUseId ? ctx.pending.get(toolUseId) : undefined;
  const tool = call?.tool ?? (toolUseId ? ctx.tools.get(toolUseId) : undefined);
  const tur = isObj(raw.toolUseResult) ? raw.toolUseResult : undefined;
  const isAnswer = tool ? QUESTION_TOOL.test(tool) : tur !== undefined && Array.isArray(tur.questions) && isObj(tur.answers);
  const extra: Partial<Event> = { error };
  if (tool) extra.tool = tool;
  if (toolUseId) extra.toolUseId = toolUseId;
  const pointer = parsePointer(text, ctx.session.sidecar);
  if (pointer) extra.pointer = pointer;
  const files = resultFiles(tur);
  if (files.length) extra.files = files;
  if (tur && typeof tur.agentId === "string") extra.agent = tur.agentId;
  const meta: Json = {};
  if (images) meta.images = images;
  if (Object.keys(meta).length) extra.meta = meta;
  if (isAnswer) {
    const answers = tur && isObj(tur.answers) ? tur.answers : undefined;
    const answerText = answers ? answersText(answers) : undefined;
    if (answers) extra.meta = { ...(extra.meta ?? {}), answers };
    return { kind: "human.answer", text: answerText ?? text, extra };
  }
  return { kind: "result", text, extra };
}

/**
 * The human's answers without the harness wrapper (`User has answered your questions: …`): one
 * answer is its text alone; several are `<question>: <answer>` lines in the stored order. A
 * multi-select answer (an array) joins with `, `. Undefined when there is no answer text.
 */
function answersText(answers: Json): string | undefined {
  const entries = Object.entries(answers)
    .map(([q, a]) => [q, Array.isArray(a) ? a.map(String).join(", ") : typeof a === "string" ? a : a == null ? "" : String(a)] as const);
  if (entries.length === 0) return undefined;
  if (entries.length === 1) return entries[0]![1];
  return entries.map(([q, a]) => `${q}: ${a}`).join("\n");
}

function resultFiles(tur: Json | undefined): string[] {
  if (!tur) return [];
  const out: string[] = [];
  if (typeof tur.filePath === "string") out.push(tur.filePath);
  if (isObj(tur.file) && typeof tur.file.filePath === "string") out.push(tur.file.filePath);
  return out;
}

function statusOf(result: Event): CallStatus {
  if (result.error) return { state: "error", size: result.size };
  if (result.pointer) return { state: "persisted", size: result.pointer.bytes };
  const images = isObj(result.meta) ? Number(result.meta.images ?? 0) : 0;
  if (images > 0 && result.text.replace(/\[image\]/g, "").trim() === "") return { state: "image" };
  return { state: "ok", size: result.size };
}

// ---------------------------------------------------------------------------------------------
// assistant

function classifyAssistant(raw: Json): Draft[] {
  const message = isObj(raw.message) ? raw.message : {};
  const content = message.content;
  if (typeof content === "string") return content ? [{ kind: "assistant", text: content }] : [];
  if (!Array.isArray(content)) return [];
  const out: Draft[] = [];
  let textRun: Draft | undefined;
  content.forEach((block, i) => {
    const n = i + 1;
    if (!isObj(block)) {
      textRun = undefined;
      return;
    }
    if (block.type === "text") {
      const text = str(block.text) ?? "";
      if (textRun) textRun.text += `\n\n${text}`;
      else {
        textRun = { kind: "assistant", text, block: n };
        out.push(textRun);
      }
      return;
    }
    textRun = undefined;
    if (block.type === "thinking") {
      out.push({ kind: "thinking", text: str(block.thinking) ?? "", block: n });
    } else if (block.type === "redacted_thinking") {
      out.push({ kind: "thinking", text: "[redacted]", block: n });
    } else if (block.type === "tool_use" || block.type === "server_tool_use") {
      const name = str(block.name) ?? "?";
      const input = block.input;
      const extra: Partial<Event> = {
        tool: name,
        input,
        status: { state: "pending" },
      };
      const target = deriveTarget(name, input);
      if (target !== undefined) extra.target = target;
      const files = inputFiles(input);
      if (files.length) extra.files = files;
      const id = str(block.id);
      if (id) extra.toolUseId = id;
      out.push({ kind: "call", text: target ? `${name} ${target}` : name, block: n, extra });
    }
  });
  return out.filter((d) => !(d.kind === "assistant" && d.text === ""));
}

/** data-model.md#derived-target-calltarget */
export function deriveTarget(tool: string, input: unknown): string | undefined {
  if (!isObj(input)) return undefined;
  for (const k of PATH_KEYS) if (typeof input[k] === "string") return input[k] as string;
  if (typeof input.command === "string") return input.command;
  if (typeof input.pattern === "string") return input.pattern;
  if (typeof input.query === "string") return input.query;
  if (SUBAGENT_TOOLS.has(tool) && typeof input.description === "string") return input.description;
  if (typeof input.skill === "string") return input.skill;
  if (typeof input.url === "string") return input.url;
  for (const v of Object.values(input)) if (typeof v === "string") return v;
  return undefined;
}

/** data-model.md#files-touched (the input half; result paths join on linkage). */
export function inputFiles(input: unknown): string[] {
  if (!isObj(input)) return [];
  const out: string[] = [];
  for (const k of PATH_KEYS) if (typeof input[k] === "string") out.push(input[k] as string);
  if (typeof input.command === "string") out.push(...commandPaths(input.command));
  return dedupe(out);
}

export function commandPaths(command: string): string[] {
  const out: string[] = [];
  for (const rawTok of command.split(/[\s;|&()<>]+/)) {
    const tok = rawTok.replace(/^['"`]+|['"`]+$/g, "");
    if (!tok || tok.startsWith("-") || tok.includes("://")) continue;
    if (tok.includes("/") || /\.[A-Za-z0-9]{1,8}$/.test(tok)) out.push(tok);
  }
  return out;
}

function dedupe(xs: string[]): string[] {
  return [...new Set(xs)];
}

// ---------------------------------------------------------------------------------------------
// attachments

function classifyAttachment(raw: Json): Draft[] {
  const a = isObj(raw.attachment) ? raw.attachment : undefined;
  if (!a) return [];
  switch (a.type) {
    case "queued_command": {
      const prompt = typeof a.prompt === "string" ? a.prompt : joinText(a.prompt);
      const origin = isObj(a.origin) ? str(a.origin.kind) : undefined;
      if (origin === "task-notification" || a.commandMode === "task-notification" || prompt.trimStart().startsWith("<task-notification>")) {
        return [taskNotice(prompt)];
      }
      if (origin === "human" || (origin === undefined && (a.commandMode === undefined || a.commandMode === "prompt"))) {
        return [{ kind: "human.queued", text: prompt, extra: { meta: { source: "queued_command" } } }];
      }
      return [notice(prompt, { source: origin ?? str(a.commandMode) ?? "queued_command" })];
    }
    case "hook_success": {
      const stdout = str(a.stdout) ?? str(a.content) ?? "";
      const meta: Json = { hook: str(a.hookEvent) ?? str(a.hookName) ?? "hook" };
      if (typeof a.hookName === "string") meta.name = a.hookName;
      if (typeof a.exitCode === "number") meta.exit = a.exitCode;
      return [{ kind: "hook", text: stdout.replace(/\n+$/, ""), extra: { meta } }];
    }
    case "hook_additional_context": {
      const c = a.content;
      const text = Array.isArray(c) ? c.filter((x) => typeof x === "string").join("\n") : (str(c) ?? "");
      const meta: Json = { hook: str(a.hookEvent) ?? str(a.hookName) ?? "hook", context: true };
      if (typeof a.hookName === "string") meta.name = a.hookName;
      return [{ kind: "hook", text, extra: { meta } }];
    }
    default:
      return [];
  }
}

// ---------------------------------------------------------------------------------------------
// system

function classifySystem(raw: Json, ctx: ClassifyContext): Draft[] {
  const subtype = str(raw.subtype);
  if (subtype === "compact_boundary" && mainSidechain(raw, ctx)) {
    return [notice(str(raw.content) ?? "Conversation compacted", { source: "parent", subtype })];
  }
  if (subtype === "compact_boundary") {
    const cm = isObj(raw.compactMetadata) ? raw.compactMetadata : {};
    const meta: Json = {};
    if (typeof cm.trigger === "string") meta.trigger = cm.trigger;
    if (typeof cm.preTokens === "number") meta.pre_tokens = cm.preTokens;
    if (typeof cm.postTokens === "number") meta.post_tokens = cm.postTokens;
    if (typeof cm.cumulativeDroppedTokens === "number") meta.dropped_tokens = cm.cumulativeDroppedTokens;
    else if (typeof cm.preTokens === "number" && typeof cm.postTokens === "number") meta.dropped_tokens = cm.preTokens - cm.postTokens;
    const pm = isObj(cm.preservedMessages) ? cm.preservedMessages : undefined;
    if (pm && Array.isArray(pm.uuids)) meta.preserved = pm.uuids.filter((u) => typeof u === "string");
    return [{ kind: "compaction", text: str(raw.content) ?? "Conversation compacted", extra: { meta } }];
  }
  if (subtype === "stop_hook_summary") {
    const errors = Array.isArray(raw.hookErrors) ? raw.hookErrors.map(String) : [];
    const context = Array.isArray(raw.hookAdditionalContext) ? raw.hookAdditionalContext.map(String) : [];
    const count = typeof raw.hookCount === "number" ? raw.hookCount : Array.isArray(raw.hookInfos) ? raw.hookInfos.length : 0;
    const lines = [...errors, ...context];
    if (raw.preventedContinuation === true && typeof raw.stopReason === "string" && raw.stopReason) lines.push(raw.stopReason);
    const meta: Json = { hook: "Stop", exit: errors.length ? "error" : "ok", hooks: count };
    if (raw.preventedContinuation === true) meta.prevented = true;
    return [{ kind: "hook", text: lines.length ? lines.join("\n") : `${count} hook${count === 1 ? "" : "s"} ran`, extra: { meta } }];
  }
  const meta: Json = { subtype: subtype ?? "system" };
  let text = str(raw.content);
  if (text === undefined) {
    if (subtype === "turn_duration" && typeof raw.durationMs === "number") {
      const secs = (raw.durationMs / 1000).toFixed(1);
      text = `turn took ${secs}s` + (typeof raw.messageCount === "number" ? `, ${raw.messageCount} messages` : "");
    } else {
      text = subtype ?? "system";
    }
  }
  if (subtype === "local_command" && /<command-name>/.test(text)) {
    const cmd = slash(text, raw);
    return [{ kind: "notice", text: cmd.text, extra: { meta: { ...meta, ...(cmd.extra?.meta ?? {}) } } }];
  }
  return [{ kind: "notice", text: stripTags(text), extra: { meta } }];
}

// ---------------------------------------------------------------------------------------------
// linkage

function link(ev: Event, ctx: ClassifyContext): void {
  // A compaction's summary is the next event after it: any other event ends the wait.
  if (ctx.compaction && ev.kind !== "summary" && ev.kind !== "compaction") ctx.compaction = undefined;
  if (ev.kind === "call" && ev.toolUseId) {
    ctx.pending.set(ev.toolUseId, ev);
    if (ev.tool) ctx.tools.set(ev.toolUseId, ev.tool);
    return;
  }
  if ((ev.kind === "result" || ev.kind === "human.answer") && ev.toolUseId) {
    const call = ctx.pending.get(ev.toolUseId);
    if (call) {
      ctx.pending.delete(ev.toolUseId);
      ev.call = call.id;
      call.result = ev.id;
      call.status = statusOf(ev);
      if (ev.files?.length) {
        call.files = dedupe([...(call.files ?? []), ...ev.files]);
        ev.files = dedupe([...(call.files ?? [])]);
      } else if (call.files?.length) {
        ev.files = [...call.files];
      }
      if (ev.agent && call.tool && SUBAGENT_TOOLS.has(call.tool)) call.agent = ev.agent;
    }
    return;
  }
  if (ev.kind === "compaction") {
    ctx.compaction = ev;
    return;
  }
  if (ev.kind === "summary" && ctx.compaction) {
    const c = ctx.compaction;
    ctx.compaction = undefined;
    c.meta = { ...(c.meta ?? {}), summary: ev.id };
    ev.meta = { ...(ev.meta ?? {}), compaction: c.id };
  }
}
