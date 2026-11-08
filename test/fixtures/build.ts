/**
 * Synthetic Claude Code session logs for tests (specs/architecture.md#fixtures).
 *
 * Every shape the adapter must handle, written with a small generic vocabulary (widget, gadget,
 * example.test). Nothing here is copied from a real session: ids are derived from the fixture
 * name, paths are under /src and /fixture-root, text is invented.
 *
 *   bun test/fixtures/build.ts            rewrite test/fixtures/claude/
 *   bun test/fixtures/build.ts <out-dir>  write somewhere else (the regeneration test does this)
 */
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

type Json = Record<string, unknown>;
type Line = Json | string; // a string is written verbatim (malformed lines)

const VERSION = "2.1.0";

export const PROJECTS = {
  widget: { cwd: "/src/widget", encoded: "-src-widget" },
  gadget: { cwd: "/src/gadget", encoded: "-src-gadget" },
  sprocket: { cwd: "/src/sprocket", encoded: "-src-sprocket" },
} as const;
type ProjectName = keyof typeof PROJECTS;

const hex = (n: number, w: number) => n.toString(16).padStart(w, "0");

/** A deterministic uuid in a fixture's namespace. */
export function fixtureUuid(s8: string, n: number): string {
  return `${s8}-${hex(n >> 16, 4)}-4000-8000-${hex(n, 12)}`;
}

class SessionBuilder {
  readonly lines: Line[] = [];
  private n = 0;
  private lastUuid: string | null = null;
  private clock: number;
  readonly id: string;
  readonly s8: string;

  constructor(
    readonly project: ProjectName,
    s8: string,
    start: string,
    readonly opts: { agentId?: string; parent?: string; id?: string } = {},
  ) {
    this.s8 = s8;
    this.id = opts.id ?? fixtureUuid(s8, 0);
    this.clock = Date.parse(start);
  }

  /** Advance the clock; returns the ISO timestamp. */
  tick(seconds = 2): string {
    this.clock += seconds * 1000;
    return new Date(this.clock).toISOString();
  }

  at(iso: string): this {
    this.clock = Date.parse(iso);
    return this;
  }

  private envelope(type: string, body: Json, opts: { ts?: string | null; t?: number } = {}): Json {
    const uuid = fixtureUuid(this.s8, ++this.n);
    const ts = opts.ts === null ? undefined : (opts.ts ?? this.tick(opts.t));
    const entry: Json = {
      parentUuid: this.lastUuid,
      isSidechain: this.opts.agentId !== undefined,
      ...(this.opts.agentId ? { agentId: this.opts.agentId } : {}),
      type,
      ...body,
      uuid,
      ...(ts ? { timestamp: ts } : {}),
      userType: "external",
      entrypoint: "cli",
      cwd: PROJECTS[this.project].cwd,
      sessionId: this.opts.parent ?? this.id,
      version: VERSION,
      gitBranch: "main",
    };
    this.lastUuid = uuid;
    return entry;
  }

  push(line: Line): this {
    this.lines.push(line);
    return this;
  }

  user(content: string | Json[], extra: Json = {}, opts: { ts?: string | null; t?: number } = {}): this {
    return this.push(this.envelope("user", { message: { role: "user", content }, ...extra }, opts));
  }

  human(text: string, extra: Json = {}): this {
    return this.user(text, { origin: { kind: "human" }, promptSource: "typed", ...extra });
  }

  assistant(content: Json[], opts: { ts?: string; t?: number } = {}): this {
    const message = {
      model: "model-x",
      id: `msg_${this.s8}${hex(this.n + 1, 4)}`,
      type: "message",
      role: "assistant",
      content,
      stop_reason: content.some((b) => b.type === "tool_use") ? "tool_use" : "end_turn",
      usage: { input_tokens: 10, output_tokens: 20 },
    };
    return this.push(this.envelope("assistant", { message, requestId: `req_${this.s8}${hex(this.n + 1, 4)}` }, opts));
  }

  say(text: string): this {
    return this.assistant([{ type: "text", text }]);
  }

  toolUse(id: string, name: string, input: Json): Json {
    return { type: "tool_use", id, name, input, caller: { type: "direct" } };
  }

  toolResult(id: string, content: string | Json[], extra: Json = {}, blockExtra: Json = {}, opts: { ts?: string; t?: number } = {}): this {
    return this.push(
      this.envelope(
        "user",
        {
          message: { role: "user", content: [{ tool_use_id: id, type: "tool_result", content, is_error: false, ...blockExtra }] },
          ...extra,
        },
        opts,
      ),
    );
  }

  attachment(attachment: Json, opts: { ts?: string; t?: number } = {}): this {
    return this.push(this.envelope("attachment", { attachment }, opts));
  }

  system(subtype: string, body: Json = {}, opts: { ts?: string; t?: number } = {}): this {
    return this.push(this.envelope("system", { subtype, level: "info", ...body, isMeta: false }, opts));
  }

  /** A silent entry: no uuid, no timestamp, like most of Claude Code's bookkeeping lines. */
  silent(type: string, body: Json = {}): this {
    return this.push({ type, ...body, sessionId: this.opts.parent ?? this.id });
  }

  get fileName(): string {
    return this.opts.agentId ? `agent-${this.opts.agentId}.jsonl` : `${this.id}.jsonl`;
  }

  render(): string {
    return this.lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n";
  }
}

interface Fixture {
  name: string;
  session: SessionBuilder;
  /** Extra files relative to the project dir. */
  files?: Record<string, string>;
}

const START = "2026-11-07T13:40:00.000Z";
const TOOL = (s8: string, n: number) => `toolu_fx${s8}${hex(n, 4)}`;

function deterministicText(words: string[], chars: number): string {
  let out = "";
  let i = 0;
  while (out.length < chars) {
    out += words[i % words.length] + (i % 12 === 11 ? "\n" : " ");
    i++;
  }
  return out.slice(0, chars);
}

const VOCAB = ["widget", "gadget", "sprocket", "flange", "config", "build", "test", "render", "listing", "example"];

// ---------------------------------------------------------------------------------------------

function stringContent(): Fixture {
  const s = new SessionBuilder("widget", "a1000001", START);
  s.silent("permission-mode", { permissionMode: "default" });
  s.human("the widget listing loops back to itself after the callback; can you look?");
  s.say("Looking at the callback handler now.");
  s.human("also\n\nkeep the old redirect for staging");
  s.say("Understood: the staging redirect stays.");
  return { name: "string-content", session: s };
}

function arrayContent(): Fixture {
  const s = new SessionBuilder("widget", "a2000002", START);
  s.user([{ type: "text", text: "render the gadget list as a table" }], { origin: { kind: "human" }, promptSource: "typed" });
  // One assistant entry with two text blocks (merged into one event) and a tool call:
  // blocks 1-2 → one `assistant` event (.1), block 3 → `call` (.3).
  s.assistant([
    { type: "text", text: "Two parts to this." },
    { type: "text", text: "First the table, then the pager." },
    s.toolUse(TOOL("a2000002", 1), "Read", { file_path: "src/gadget/list.ts" }),
  ]);
  s.toolResult(TOOL("a2000002", 1), [{ type: "text", text: "1\texport function list() {}\n" }], {
    toolUseResult: { type: "text", file: { filePath: "src/gadget/list.ts", content: "export function list() {}\n" } },
  });
  s.say("The list renders through `list()`; switching it to a table.");
  return { name: "array-content", session: s };
}

function parallelTools(): Fixture {
  const id = "a3000003";
  const s = new SessionBuilder("widget", id, START);
  s.human("run the tests and the linter, and check the config");
  // Current logs write one block per assistant line, sharing a message id.
  s.assistant([s.toolUse(TOOL(id, 1), "Bash", { command: "bun test src/widget.test.ts", description: "Run tests" })]);
  s.assistant([s.toolUse(TOOL(id, 2), "Bash", { command: "bun run lint", description: "Run linter" })]);
  s.assistant([s.toolUse(TOOL(id, 3), "Read", { file_path: "config/staging.env" })]);
  // Results arrive out of order: 2, then 3 (three entries after its call), then 1 with an error.
  s.toolResult(TOOL(id, 2), "lint clean", { toolUseResult: { stdout: "lint clean", stderr: "", interrupted: false } });
  s.attachment({ type: "hook_success", hookName: "PostToolUse:Bash", hookEvent: "PostToolUse", content: "", stdout: "", stderr: "", exitCode: 0, command: "true", durationMs: 5, toolUseID: TOOL(id, 2) });
  s.toolResult(TOOL(id, 3), "1\tAPP_HOST=staging.example.test\n2\tREDIRECT=https://old.example.test/callback\n", {
    toolUseResult: { type: "text", file: { filePath: "config/staging.env", content: "APP_HOST=staging.example.test\n" } },
  });
  s.toolResult(TOOL(id, 1), "FAIL src/widget.test.ts\n  expected 2 got 3", { toolUseResult: { stdout: "", stderr: "FAIL", interrupted: false } }, { is_error: true });
  s.say("One test fails; the linter is clean.");
  // A call that never gets a result (the session was interrupted): `pending`.
  s.assistant([s.toolUse(TOOL(id, 4), "Edit", { file_path: "src/widget.ts", old_string: "2", new_string: "3" })]);
  return { name: "parallel-tools", session: s };
}

const PERSISTED_SIZE = 42_800;

function persistedOutput(): Fixture {
  const id = "a4000004";
  const s = new SessionBuilder("widget", id, START);
  const full = deterministicText(VOCAB, PERSISTED_SIZE);
  const preview = full.slice(0, 2000);
  const stored = `/fixture-root/projects/${PROJECTS.widget.encoded}/${s.id}/tool-results/bfx0001.txt`;
  s.human("dump the whole widget log");
  s.assistant([s.toolUse(TOOL(id, 1), "Bash", { command: "cat logs/widget.log", description: "Show log" })]);
  s.toolResult(
    TOOL(id, 1),
    `<persisted-output>\nOutput too large (42.8KB). Full output saved to: ${stored}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`,
    { toolUseResult: { stdout: preview, stderr: "", interrupted: false, persistedOutputPath: stored, persistedOutputSize: PERSISTED_SIZE } },
  );
  s.say("The log is long; the interesting part is near the end.");
  return { name: "persisted-output", session: s, files: { [`${s.id}/tool-results/bfx0001.txt`]: full } };
}

function persistedMissing(): Fixture {
  const id = "a5000005";
  const s = new SessionBuilder("widget", id, START);
  const preview = deterministicText(VOCAB, 600);
  // Older logs: the same sentence without the <persisted-output> wrapper; the file is gone.
  const stored = `/fixture-root/projects/${PROJECTS.widget.encoded}/${s.id}/tool-results/bfx0002.txt`;
  s.human("show me every gadget");
  s.assistant([s.toolUse(TOOL(id, 1), "Bash", { command: "ls -R src/gadget", description: "List gadgets" })]);
  s.toolResult(TOOL(id, 1), `Output too large (12.5KB). Full output saved to: ${stored}\n\nPreview (first 2KB):\n${preview}`);
  s.say("There are many gadgets.");
  return { name: "persisted-missing", session: s };
}

function compaction(): Fixture {
  const id = "a6000006";
  const s = new SessionBuilder("widget", id, START);
  s.human("keep refactoring the flange module");
  s.say("Refactoring the flange module.");
  s.push({
    parentUuid: null,
    logicalParentUuid: fixtureUuid(id, 2),
    isSidechain: false,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    compactMetadata: {
      trigger: "auto",
      preTokens: 998_600,
      postTokens: 25_100,
      cumulativeDroppedTokens: 973_500,
      durationMs: 1200,
      preservedMessages: { anchorUuid: fixtureUuid(id, 4), uuids: [fixtureUuid(id, 1), fixtureUuid(id, 2)] },
    },
    uuid: fixtureUuid(id, 3),
    timestamp: s.tick(),
    userType: "external",
    entrypoint: "cli",
    cwd: PROJECTS.widget.cwd,
    sessionId: s.id,
    version: VERSION,
    gitBranch: "main",
  });
  // The summary lands with an earlier timestamp than the boundary, as in real logs.
  s.user(
    "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.\n\nSummary:\n1. The flange module is being split into two files.",
    { isVisibleInTranscriptOnly: true, isCompactSummary: true },
    { ts: "2026-11-07T13:40:05.000Z" },
  );
  s.human("continue with the second file");
  s.say("Writing the second flange file.");
  return { name: "compaction", session: s };
}

function compactionLegacy(): Fixture {
  const s = new SessionBuilder("widget", "a7000007", START);
  // Older logs: no structured boundary and no isCompactSummary flag; only the summary sentence.
  s.user(
    "This session is being continued from a previous conversation that ran out of context. The conversation is summarized below:\nThe sprocket tests were being fixed.",
  );
  s.human("pick up where we left off");
  s.say("Back on the sprocket tests.");
  return { name: "compaction-legacy", session: s };
}

export const QUEUED_PROMPT = "also check the staging config while you're in there";

function queuedCommand(): Fixture {
  const id = "a8000008";
  const s = new SessionBuilder("widget", id, START);
  s.human("fix the sprocket build");
  s.assistant([s.toolUse(TOOL(id, 1), "Bash", { command: "bun run build", description: "Build" })]);
  // Sent by the human while the agent was working.
  s.attachment({ type: "queued_command", prompt: QUEUED_PROMPT, source_uuid: fixtureUuid(id, 90), commandMode: "prompt", origin: { kind: "human" }, timestamp: s.tick(0) });
  s.toolResult(TOOL(id, 1), "build ok");
  // A background task completing: not the human.
  s.attachment({
    type: "queued_command",
    prompt: "<task-notification>\n<task-id>b0c0d0e0f0a0b0c0d</task-id>\n<status>completed</status>\n<summary>Agent \"Survey gadgets\" finished</summary>\n</task-notification>",
    commandMode: "task-notification",
    origin: { kind: "task-notification", producer: "session-task" },
  });
  // A queued prompt promoted to a user entry.
  s.user("and bump the version afterwards", { origin: { kind: "human" }, promptSource: "queued" });
  s.say("Build fixed, staging config checked, version bumped.");
  return { name: "queued-command", session: s };
}

function slashCommand(): Fixture {
  const s = new SessionBuilder("widget", "a9000009", START);
  s.user("<command-name>/review</command-name>\n            <command-message>review</command-message>\n            <command-args>src/widget.ts --strict</command-args>", { origin: { kind: "human" }, promptSource: "typed" });
  s.user("<local-command-stdout>Review queued</local-command-stdout>");
  s.say("Reviewing src/widget.ts strictly.");
  s.user("<command-name>/compact</command-name>\n            <command-message>compact</command-message>\n            <command-args></command-args>", { origin: { kind: "human" }, promptSource: "typed" });
  return { name: "slash-command", session: s };
}

function hooks(): Fixture {
  const id = "aa00000a";
  const s = new SessionBuilder("widget", id, START);
  s.attachment({ type: "hook_success", hookName: "SessionStart:startup", toolUseID: fixtureUuid(id, 70), hookEvent: "SessionStart", content: "widget project: 3 open tasks", stdout: "widget project: 3 open tasks\n", stderr: "", exitCode: 0, command: "echo tasks", durationMs: 12 });
  s.human("run the build");
  s.assistant([s.toolUse(TOOL(id, 1), "Bash", { command: "bun run build", description: "Build" })]);
  s.attachment({ type: "hook_additional_context", content: ["Reminder: builds write to dist/"], hookName: "PreToolUse:Bash", toolUseID: TOOL(id, 1), hookEvent: "PreToolUse" });
  s.toolResult(TOOL(id, 1), "built");
  s.say("Built.");
  s.system("stop_hook_summary", { hookCount: 2, hookInfos: [{ command: "notify", durationMs: 3 }, { command: "check", durationMs: 4 }], hookErrors: [], hookAdditionalContext: [], preventedContinuation: false, stopReason: "", hasOutput: false, toolUseID: fixtureUuid(id, 71) });
  s.system("turn_duration", { durationMs: 8400, messageCount: 6 });
  return { name: "hooks", session: s };
}

function skill(): Fixture {
  const id = "ab00000b";
  const s = new SessionBuilder("widget", id, START);
  s.human("use the release skill");
  s.assistant([s.toolUse(TOOL(id, 1), "Skill", { skill: "release" })]);
  s.toolResult(TOOL(id, 1), "Launching skill: release");
  s.user([{ type: "text", text: "Base directory for this skill: /src/widget/.skills/release\n\n# release\n\nCut a release of the widget." }], { isMeta: true, sourceToolUseID: TOOL(id, 1) });
  s.say("Cutting the release.");
  return { name: "skill", session: s };
}

function notices(): Fixture {
  const id = "ac00000c";
  const s = new SessionBuilder("widget", id, START);
  s.user([{ type: "text", text: "<system-reminder>\nThe date has changed.\n</system-reminder>" }]);
  s.user([
    { type: "text", text: "what does this screenshot show?" },
    { type: "text", text: "[Image: source: /tmp/fixture/shot-1.png]" },
  ], { origin: { kind: "human" }, promptSource: "typed" });
  s.say("A widget table.");
  s.user([{ type: "text", text: "[Request interrupted by user]" }]);
  s.user("<task-notification>\n<task-id>c0d0e0f0a0b0c0d0e</task-id>\n<status>completed</status>\n<summary>Agent \"Check sprockets\" finished</summary>\n</task-notification>", { origin: { kind: "task-notification", producer: "session-task" }, promptSource: "system" });
  s.user("Another session sent a message:\n<agent-message from=\"c0d0e0f0a0b0c0d0e\">report</agent-message>", { isMeta: true, origin: { kind: "peer", from: "c0d0e0f0a0b0c0d0e" }, promptSource: "system" });
  s.system("away_summary", { content: "Working on the widget table; next: the pager." });
  s.system("informational", { content: "Remote control disconnected", level: "warning" });
  s.system("local_command", { content: "<command-name>/rename</command-name>\n            <command-message>rename</command-message>\n            <command-args>widget-table</command-args>" });
  return { name: "notices", session: s };
}

function thinking(): Fixture {
  const id = "ad00000d";
  const s = new SessionBuilder("widget", id, START);
  s.human("why is the flange slow?");
  s.assistant([{ type: "thinking", thinking: "The flange loop allocates on every pass.", signature: "sig-fixture" }]);
  s.assistant([{ type: "text", text: "It allocates on every loop pass." }]);
  return { name: "thinking", session: s };
}

export const SUBAGENT_ID = "ae0f1e2d3c4b5a697";

function subagent(): Fixture[] {
  const id = "ae00000e";
  const s = new SessionBuilder("widget", id, START);
  s.human("survey every gadget in the repo");
  s.assistant([s.toolUse(TOOL(id, 1), "Agent", { description: "Survey gadgets", prompt: "List every gadget under src/gadget.", subagent_type: "general-purpose" })]);
  s.toolResult(TOOL(id, 1), [{ type: "text", text: "Found 3 gadgets." }], { toolUseResult: { status: "completed", agentId: SUBAGENT_ID, content: [{ type: "text", text: "Found 3 gadgets." }] } });
  s.say("Three gadgets.");

  const sub = new SessionBuilder("widget", SUBAGENT_ID.slice(0, 8), "2026-11-07T13:40:03.000Z", { agentId: SUBAGENT_ID, parent: s.id });
  sub.user("List every gadget under src/gadget.");
  sub.assistant([sub.toolUse(TOOL("ae0f1e2d", 1), "Glob", { pattern: "src/gadget/**/*.ts" })]);
  sub.toolResult(TOOL("ae0f1e2d", 1), "src/gadget/a.ts\nsrc/gadget/b.ts\nsrc/gadget/c.ts");
  sub.say("Found 3 gadgets.");

  return [
    {
      name: "subagent-parent",
      session: s,
      files: {
        [`${s.id}/custom-title.json`]: JSON.stringify({ customTitle: "gadget survey" }) + "\n",
        [`${s.id}/subagents/agent-${SUBAGENT_ID}.meta.json`]: JSON.stringify({ agentType: "general-purpose", description: "Survey gadgets", toolUseId: TOOL(id, 1) }) + "\n",
      },
    },
    { name: "subagent", session: sub },
  ];
}

/** Every silent type the data model lists, an unknown type, and one malformed line. */
export const SILENT_FIXTURE_TYPES = [
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
  "artifact-publish",
];

function silent(): Fixture {
  const s = new SessionBuilder("widget", "af00000f", START);
  for (const t of SILENT_FIXTURE_TYPES) s.silent(t, { note: `${t} bookkeeping` });
  s.silent("widget-telemetry", { note: "a type the adapter does not know" });
  s.push('{"type":"user","message":{"role":"user","content":"truncated mid-write');
  s.attachment({ type: "deferred_tools_delta", addedNames: ["WidgetTool"] });
  return { name: "silent", session: s };
}

function outOfOrder(): Fixture {
  const id = "b0000010";
  const s = new SessionBuilder("widget", id, START);
  s.human("tidy the sprocket imports");
  s.say("Tidying.", );
  // An attachment written after the reply but stamped earlier; file order stays the truth.
  s.attachment({ type: "queued_command", prompt: "and sort them", commandMode: "prompt", origin: { kind: "human" } }, { ts: "2026-11-07T13:40:01.000Z" });
  s.say("Sorted as well.");
  return { name: "out-of-order", session: s };
}

function twoDay(): Fixture {
  const s = new SessionBuilder("widget", "b1000011", "2026-11-07T23:50:00.000Z");
  s.human("start the overnight widget migration");
  s.say("Starting the migration.");
  s.at("2026-11-08T00:05:00.000Z");
  s.human("how far along is it?");
  s.say("Halfway.");
  return { name: "two-day", session: s };
}

function question(): Fixture {
  const id = "b2000012";
  const s = new SessionBuilder("widget", id, START);
  s.human("set up the gadget release");
  s.assistant([s.toolUse(TOOL(id, 1), "AskUserQuestion", { questions: [{ question: "Which channel?", options: [{ label: "beta" }, { label: "stable" }] }] })]);
  s.toolResult(TOOL(id, 1), 'User has answered your questions: "Which channel?"="beta".', {
    toolUseResult: { questions: [{ question: "Which channel?" }], answers: { "Which channel?": "beta" } },
  });
  s.say("Releasing to beta.");
  return { name: "question", session: s };
}

export const NESTED_TS_EARLY = "2026-11-01T09:00:00.000Z";
export const NESTED_TS_LATE = "2026-12-25T00:00:00.000Z";

/**
 * The edges of the authority rules: text that looks like a wrapper but is the human's, a hook
 * wrapper followed by a prompt, sidechain prompts in a main file, a multi-question answer, a
 * persisted path with a space, and `timestamp` fields nested inside an entry's payload.
 */
function authorityEdges(): Fixture {
  const id = "b3000014";
  const s = new SessionBuilder("widget", id, START);
  // A queued prompt whose attachment carries its own (earlier) timestamp ahead of the entry's.
  s.attachment({ type: "queued_command", prompt: "start with the flange", commandMode: "prompt", origin: { kind: "human" }, timestamp: NESTED_TS_EARLY });
  s.human("what does the <command-name> tag mean?");
  s.say("It names the slash command that was run.");
  // Older logs: no origin; the hook wrapper and then the prompt in one string.
  s.user("<user-prompt-submit-hook>widget lint: clean</user-prompt-submit-hook>\nnow bump the gadget version");
  s.user([{ type: "text", text: "[Image #1] why is this widget row misaligned?" }, { type: "text", text: "[Image #2]" }], { origin: { kind: "human" }, promptSource: "typed" });
  s.human("This session is being continued from a previous conversation, so here is my recap: the flange split is done.");
  // A sidechain prompt inside a main session file: the parent agent's text.
  s.user("Survey the sprockets under src/sprocket.", { isSidechain: true });
  s.assistant([
    s.toolUse(TOOL(id, 1), "AskUserQuestion", {
      questions: [
        { question: "Which channel?", options: [{ label: "beta" }, { label: "stable" }] },
        { question: "Which regions?", options: [{ label: "eu" }, { label: "us" }], multiSelect: true },
      ],
    }),
  ]);
  s.toolResult(TOOL(id, 1), 'User has answered your questions: "Which channel?"="beta", "Which regions?"="eu, us".', {
    toolUseResult: { questions: [{ question: "Which channel?" }, { question: "Which regions?" }], answers: { "Which channel?": "beta", "Which regions?": ["eu", "us"] } },
  });
  const stored = `/fixture-root/projects/${PROJECTS.widget.encoded}/${s.id}/tool-results/bfx 0003.txt`;
  const full = deterministicText(VOCAB, 3100);
  s.assistant([s.toolUse(TOOL(id, 2), "Bash", { command: "cat 'logs/gadget run.log'", description: "Show log" })]);
  s.toolResult(TOOL(id, 2), `<persisted-output>\nOutput too large (3.1KB). Full output saved to: ${stored}\n\nPreview (first 2KB):\n${full.slice(0, 2000)}\n...\n</persisted-output>`);
  // A tool input with its own timestamp field, written ahead of the entry's.
  s.assistant([s.toolUse(TOOL(id, 3), "ScheduleWakeup", { timestamp: NESTED_TS_LATE, note: "check the gadget build" })]);
  return { name: "authority-edges", session: s, files: { [`${s.id}/tool-results/bfx 0003.txt`]: full } };
}

/** One assistant entry holding text plus three parallel calls: four events, `.1`..`.4`. */
function multiBlock(): Fixture {
  const id = "b4000015";
  const s = new SessionBuilder("widget", id, START);
  s.human("check the flange config, the sprocket tests and the build");
  s.silent("file-history-snapshot", { note: "bookkeeping between two events" });
  s.assistant([
    { type: "text", text: "Three checks, in parallel." },
    s.toolUse(TOOL(id, 1), "Read", { file_path: "config/flange.toml" }),
    s.toolUse(TOOL(id, 2), "Grep", { pattern: "sprocket", path: "src/sprocket" }),
    s.toolUse(TOOL(id, 3), "Bash", { command: "bun run build", description: "Build" }),
  ]);
  s.user(
    [
      { tool_use_id: TOOL(id, 2), type: "tool_result", content: "src/sprocket/a.test.ts", is_error: false },
      { tool_use_id: TOOL(id, 1), type: "tool_result", content: "1\tteeth = 12\n", is_error: false },
      { tool_use_id: TOOL(id, 3), type: "tool_result", content: "build ok", is_error: false },
    ],
  );
  s.say("All three look fine.");
  return { name: "multi-block", session: s };
}

export const LONG_URL = "https://docs.example.test/widget/guides/redirects/staging-callback-loop-troubleshooting";
export const LONG_PATH = "src/widget/components/listing/table/pagination/controls/next-page-button/handlers/legacy/compat/adapters/on-click-handler.ts";

/** Long texts for the caps: row heads, URLs and paths across the cut, the 4,000-char detail cap. */
function longText(): Fixture {
  const id = "b5000016";
  const s = new SessionBuilder("widget", id, START);
  s.human(deterministicText(VOCAB, 300).replace(/\n/g, " "));
  // The 200-char head would fall inside the URL.
  s.human(`${"see the redirect notes ".repeat(8).slice(0, 180)}${LONG_URL} and then fix it`);
  s.assistant([s.toolUse(TOOL(id, 1), "Read", { file_path: `${LONG_PATH}` })]);
  s.toolResult(TOOL(id, 1), deterministicText(VOCAB, 5000));
  // A shell command whose 120-char target cut would fall inside a path.
  s.assistant([s.toolUse(TOOL(id, 2), "Bash", { command: `${"echo widget && ".repeat(6)}cat ${LONG_PATH} && echo done`, description: "Show handler" })]);
  s.toolResult(TOOL(id, 2), "export function onClick() {}");
  s.say(deterministicText(VOCAB, 4500));
  s.say("Short reply.");
  // H text over the detail cap: `show` never cuts it.
  s.human(deterministicText(VOCAB, 4600));
  // A hook wrapper inside a text block rides on the prompt's event as meta.hook_text.
  s.user([{ type: "text", text: `<user-prompt-submit-hook>${deterministicText(VOCAB, 4400)}</user-prompt-submit-hook>\nnow the short prompt` }], { origin: { kind: "human" }, promptSource: "typed" });
  return { name: "long-text", session: s };
}

/**
 * Prefix collisions in their own project: two sessions sharing 7 characters (an 8-character
 * prefix tells them apart) and two sharing all 8 (only a longer prefix does).
 */
function prefixCollisions(): Fixture[] {
  // The pair sharing 8 characters is the newest, so listings and `latest` land on it.
  const one = (s8: string, idOverride?: string) => {
    const start = s8 === "c3b5d7e9" ? "2026-11-06T10:00:00.000Z" : "2026-11-06T09:00:00.000Z";
    const s = new SessionBuilder("sprocket", s8, start, idOverride ? { id: idOverride } : {});
    s.human(`sprocket task for ${idOverride ?? s8}`);
    s.say("Done.");
    return s;
  };
  return [
    { name: "seven-a", session: one("c2a4e6f1") },
    { name: "seven-b", session: one("c2a4e6f9") },
    { name: "eight-a", session: one("c3b5d7e9") },
    { name: "eight-b", session: one("c3b5d7e9", "c3b5d7e9-ffff-4000-8000-000000000000") },
  ];
}

function gadgetProject(): Fixture {
  const s = new SessionBuilder("gadget", "c1000013", "2026-11-06T10:00:00.000Z");
  s.human("add a gadget counter");
  s.say("Added a counter to the gadget panel.");
  return { name: "gadget", session: s };
}

// ---------------------------------------------------------------------------------------------
// find (plans/find.md): every handle find takes, in one session

export const FIND_DEEP_WORD = "zanzibar-quartz";

/**
 * A session for `find`: a phrase in human, assistant, call-input and result text (with a hidden
 * thinking row between hits), calls that touch `config/staging.env` by path and by shell
 * command, several shell calls, a persisted output whose phrase is only in the file, and two
 * halves an hour and a half apart so `--since 1h` selects the second.
 */
function findSession(): Fixture {
  const id = "e1000018";
  const s = new SessionBuilder("widget", id, "2026-11-07T12:00:00.000Z");
  s.human("the deploy keeps hitting the old redirect after login");
  s.say("Checking the redirect handler first.");
  s.assistant([{ type: "thinking", thinking: "The REDIRECT is probably cached somewhere.", signature: "sig-fixture" }]);
  s.assistant([s.toolUse(TOOL(id, 1), "Read", { file_path: "config/staging.env" })]);
  s.toolResult(TOOL(id, 1), "1\tAPP_HOST=staging.example.test\n2\tOAUTH_REDIRECT=https://old.example.test/callback\n", {
    toolUseResult: { type: "text", file: { filePath: "config/staging.env", content: "APP_HOST=staging.example.test\n" } },
  });
  s.assistant([s.toolUse(TOOL(id, 2), "Grep", { pattern: "redirect_uri", path: "src" })]);
  s.toolResult(TOOL(id, 2), "src/widget/callback.ts:12: const uri = cfg.uri;");
  s.assistant([s.toolUse(TOOL(id, 3), "Bash", { command: "grep -n HOST config/staging.env", description: "Find the host" })]);
  s.toolResult(TOOL(id, 3), "1:APP_HOST=staging.example.test", { toolUseResult: { stdout: "1:APP_HOST=staging.example.test", stderr: "", interrupted: false } });
  s.assistant([s.toolUse(TOOL(id, 4), "Edit", { file_path: "config/staging.env", old_string: "old.example.test", new_string: "new.example.test" })]);
  s.toolResult(TOOL(id, 4), "The file config/staging.env has been updated.", { toolUseResult: { filePath: "config/staging.env" } });
  s.assistant([s.toolUse(TOOL(id, 5), "Bash", { command: "bun test src/widget.test.ts", description: "Run tests" })]);
  s.toolResult(TOOL(id, 5), "3 pass\n0 fail", { toolUseResult: { stdout: "3 pass", stderr: "", interrupted: false } });
  s.at("2026-11-07T13:30:00.000Z");
  s.human("now deploy it to staging");
  s.say("Deploying now; the deploy script prints a lot.");
  const preview = deterministicText(VOCAB, 2000);
  const full = `${preview}${deterministicText(VOCAB, 3000)}\nfinal line: ${FIND_DEEP_WORD} checksum ok\n`;
  const stored = `/fixture-root/projects/${PROJECTS.widget.encoded}/${s.id}/tool-results/bfx0004.txt`;
  s.assistant([s.toolUse(TOOL(id, 6), "Bash", { command: "./scripts/deploy.sh staging", description: "Deploy" })]);
  s.toolResult(TOOL(id, 6), `<persisted-output>\nOutput too large (5.1KB). Full output saved to: ${stored}\n\nPreview (first 2KB):\n${preview}\n...\n</persisted-output>`);
  s.say("Deployed to staging.");
  return { name: "find", session: s, files: { [`${s.id}/tool-results/bfx0004.txt`]: full } };
}

export function fixtures(): Fixture[] {
  return [
    stringContent(),
    arrayContent(),
    parallelTools(),
    persistedOutput(),
    persistedMissing(),
    compaction(),
    compactionLegacy(),
    queuedCommand(),
    slashCommand(),
    hooks(),
    skill(),
    notices(),
    thinking(),
    ...subagent(),
    silent(),
    outOfOrder(),
    twoDay(),
    question(),
    authorityEdges(),
    multiBlock(),
    longText(),
    ...prefixCollisions(),
    gadgetProject(),
    findSession(),
  ];
}

/** Relative path of a fixture's log file under the output root. */
export function fixturePath(f: Fixture): string {
  const base = join("projects", PROJECTS[f.session.project].encoded);
  if (f.session.opts.agentId) return join(base, f.session.opts.parent!, "subagents", f.session.fileName);
  return join(base, f.session.fileName);
}

/** name → relative path, for tests. */
export function fixtureIndex(): Record<string, string> {
  return Object.fromEntries(fixtures().map((f) => [f.name, fixturePath(f)]));
}

export function buildFixtures(outDir: string): string[] {
  rmSync(join(outDir, "projects"), { recursive: true, force: true });
  const written: string[] = [];
  const write = (rel: string, data: string) => {
    const abs = join(outDir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, data);
    written.push(rel);
  };
  const all = fixtures();
  for (const f of all) {
    write(fixturePath(f), f.session.render());
    for (const [rel, data] of Object.entries(f.files ?? {})) write(join("projects", PROJECTS[f.session.project].encoded, rel), data);
  }
  // The optional accelerator: deliberately incomplete and stale (one listed file does not exist).
  const indexed = all.filter((f) => f.session.project === "widget" && !f.session.opts.agentId).slice(0, 3);
  const index = {
    version: 1,
    entries: [
      ...indexed.map((f) => ({
        sessionId: f.session.id,
        fullPath: `/fixture-root/projects/${PROJECTS.widget.encoded}/${f.session.fileName}`,
        firstPrompt: "fixture",
        messageCount: f.session.lines.length,
        created: START,
        modified: START,
        gitBranch: "main",
        projectPath: PROJECTS.widget.cwd,
        isSidechain: false,
      })),
      {
        sessionId: fixtureUuid("deadbeef", 0),
        fullPath: `/fixture-root/projects/${PROJECTS.widget.encoded}/${fixtureUuid("deadbeef", 0)}.jsonl`,
        firstPrompt: "a session whose file is gone",
        messageCount: 2,
        created: START,
        modified: START,
        gitBranch: "main",
        projectPath: PROJECTS.widget.cwd,
        isSidechain: false,
      },
    ],
    originalPath: PROJECTS.widget.cwd,
  };
  write(join("projects", PROJECTS.widget.encoded, "sessions-index.json"), JSON.stringify(index, null, 2) + "\n");
  return written.sort();
}

/**
 * A large synthetic session for the streaming/memory test: generated at test time into a temp
 * dir, never committed. Each turn is a prompt, a call, a sizeable result and a reply.
 */
export async function buildLarge(path: string, bytes: number): Promise<void> {
  const { createWriteStream } = await import("node:fs");
  const s8 = "f0000099";
  const out = createWriteStream(path);
  const filler = deterministicText(VOCAB, 3800);
  let written = 0;
  let n = 0;
  let clock = Date.parse("2026-11-01T00:00:00.000Z");
  const line = (obj: Json) => {
    const text = JSON.stringify(obj) + "\n";
    written += Buffer.byteLength(text);
    return out.write(text) ? Promise.resolve() : new Promise<void>((r) => out.once("drain", () => r()));
  };
  const env = (type: string, body: Json): Json => {
    clock += 1000;
    return { type, ...body, uuid: fixtureUuid(s8, ++n), timestamp: new Date(clock).toISOString(), cwd: PROJECTS.widget.cwd, sessionId: fixtureUuid(s8, 0) };
  };
  let turn = 0;
  while (written < bytes) {
    turn++;
    const tid = `toolu_fxlarge${hex(turn, 8)}`;
    await line(env("user", { message: { role: "user", content: `turn ${turn}: process the next widget batch` }, origin: { kind: "human" } }));
    await line(env("assistant", { message: { role: "assistant", content: [{ type: "tool_use", id: tid, name: "Bash", input: { command: `process --batch ${turn}` } }] } }));
    await line(env("user", { message: { role: "user", content: [{ type: "tool_result", tool_use_id: tid, content: filler, is_error: false }] } }));
    await line(env("assistant", { message: { role: "assistant", content: [{ type: "text", text: `Batch ${turn} done.` }] } }));
  }
  await new Promise<void>((r) => out.end(() => r()));
}

// ---------------------------------------------------------------------------------------------
// pan (plan pan): a long session generated at test time, never committed

/**
 * A session long enough for several offset-table checkpoints (~1,300 lines), mixing every shape
 * a seek must reproduce: hidden kinds between visible rows, multi-event entries, silent runs,
 * results that arrive turns later (pending across checkpoints), question answers, compactions
 * with their summaries, and one malformed line.
 */
export function panSession(s8 = "e1000021"): string {
  const s = new SessionBuilder("widget", s8, START);
  const late: Array<{ due: number; id: string; text: string }> = [];
  for (let turn = 1; turn <= 130; turn++) {
    if (turn % 60 === 0) {
      // The second compaction sits on the last line before a checkpoint, so its summary opens one.
      if (turn === 120) while ((s.lines.length + 1) % 256 !== 0) s.silent("file-history-snapshot", { pad: s.lines.length });
      s.push({
        parentUuid: null,
        isSidechain: false,
        type: "system",
        subtype: "compact_boundary",
        content: "Conversation compacted",
        level: "info",
        compactMetadata: { trigger: "auto", preTokens: 900_000 + turn, postTokens: 20_000, preservedMessages: { uuids: [fixtureUuid(s8, 1), fixtureUuid(s8, 2)] } },
        uuid: fixtureUuid(s8, 50_000 + turn),
        timestamp: s.tick(),
        cwd: PROJECTS.widget.cwd,
        sessionId: s.id,
        version: VERSION,
      });
      for (let k = 0; k < turn % 5; k++) s.silent("file-history-snapshot", { n: k });
      s.user(`This session is being continued from a previous conversation. Summary: turn ${turn} widget work.`, { isCompactSummary: true });
    }
    s.human(`turn ${turn}: process the next ${VOCAB[turn % VOCAB.length]} batch`);
    if (turn % 3 === 0) s.attachment({ type: "queued_command", prompt: `also check ${VOCAB[(turn + 1) % VOCAB.length]} ${turn}`, commandMode: "prompt" });
    s.assistant([{ type: "thinking", thinking: `turn ${turn} needs two calls`, signature: "sig-fixture" }]);
    const a = TOOL(s8, turn * 4);
    const b = TOOL(s8, turn * 4 + 1);
    s.assistant([
      { type: "text", text: `Running ${turn}a and ${turn}b.` },
      s.toolUse(a, "Bash", { command: `process --batch ${turn}` }),
      s.toolUse(b, "Read", { file_path: `src/${VOCAB[turn % VOCAB.length]}/batch-${turn}.ts` }),
    ]);
    for (let k = 0; k < (turn * 7) % 4; k++) s.silent("permission-mode", { permissionMode: "default", n: k });
    s.toolResult(b, `export const batch${turn} = ${turn};`);
    // Every fifth turn's Bash result arrives three turns later, after other prompts.
    if (turn % 5 === 0) late.push({ due: turn + 3, id: a, text: `batch ${turn} finished late` });
    else s.toolResult(a, turn % 7 === 0 ? `FAIL batch ${turn}` : `ok batch ${turn}`, {}, turn % 7 === 0 ? { is_error: true } : {});
    for (const l of late.filter((x) => x.due === turn)) s.toolResult(l.id, l.text);
    if (turn % 25 === 0) {
      const q = TOOL(s8, turn * 4 + 2);
      s.assistant([s.toolUse(q, "AskUserQuestion", { questions: [{ question: `Ship batch ${turn}?`, options: [{ label: "yes" }, { label: "no" }] }] })]);
      for (let k = 0; k < 3; k++) s.silent("file-history-snapshot", { n: k });
      s.toolResult(q, `User has answered your questions: "Ship batch ${turn}?"="yes".`, {
        toolUseResult: { questions: [{ question: `Ship batch ${turn}?` }], answers: { [`Ship batch ${turn}?`]: "yes" } },
      });
    }
    if (turn === 40) s.push('{"type":"assistant","message":{"content":[{"type":"text","text":"cut off');
    s.say(`Batch ${turn} done.`);
    s.system("turn_duration", { durationMs: 1000 + turn, messageCount: 6 });
  }
  for (const l of late.filter((x) => x.due > 130)) s.toolResult(l.id, l.text);
  return s.render();
}

/**
 * A question whose result arrives twice: once in turn, once as a late duplicate 300 lines later,
 * past a checkpoint. Only the tool-use id → tool map says the duplicate is a `human.answer`.
 */
export function duplicateAnswerSession(s8 = "e2000022"): string {
  const s = new SessionBuilder("widget", s8, START);
  s.human("start the widget release");
  const q = TOOL(s8, 1);
  s.assistant([s.toolUse(q, "AskUserQuestion", { questions: [] })]);
  s.toolResult(q, "first answer");
  for (let i = 4; i <= 300; i++) s.say(`filler ${i}`);
  s.toolResult(q, "late duplicate answer");
  s.say("end");
  return s.render();
}

/** A call whose result arrives after 1,100 silent lines: held by visible events, not by lines. */
export function longHoldSession(s8 = "e3000023"): string {
  const s = new SessionBuilder("widget", s8, START);
  s.human("start");
  const b = TOOL(s8, 1);
  s.assistant([s.toolUse(b, "Bash", { command: "sleep 1" })]);
  s.say("waiting");
  for (let i = 0; i < 1100; i++) s.silent("permission-mode", { permissionMode: "default", n: i });
  s.toolResult(b, "done");
  return s.render();
}

// ---------------------------------------------------------------------------------------------
// views (plan views): shapes the committed fixtures do not cover, generated at test time

/** A call whose result is only an image block: status `image`. */
export function imageResultSession(s8 = "e4000024"): string {
  const s = new SessionBuilder("widget", s8, START);
  s.human("look at the widget screenshot");
  s.assistant([s.toolUse(TOOL(s8, 1), "Read", { file_path: "docs/widget.png" })]);
  s.toolResult(TOOL(s8, 1), [{ type: "image", source: { type: "base64", media_type: "image/png", data: "iVBORw0KGgo=" } }]);
  s.say("The screenshot shows the widget table.");
  return s.render();
}

/** A structured compaction boundary line (the shape Claude Code writes). */
function boundaryLine(s: SessionBuilder, n: number, extra: Json = {}): Json {
  return {
    parentUuid: null,
    isSidechain: false,
    type: "system",
    subtype: "compact_boundary",
    content: "Conversation compacted",
    level: "info",
    compactMetadata: { trigger: "auto", preTokens: 500_000, postTokens: 20_000 },
    uuid: fixtureUuid(s.s8, 60_000 + n),
    timestamp: s.tick(),
    cwd: PROJECTS[s.project].cwd,
    sessionId: s.id,
    version: VERSION,
    ...extra,
  };
}

const CONTINUED = "This session is being continued from a previous conversation that ran out of context.";

/** Long messages around a compaction whose summary is longer than the 4,000-char detail cap. */
export function longSummarySession(s8 = "e5000025"): string {
  const s = new SessionBuilder("widget", s8, START);
  for (let i = 1; i <= 3; i++) {
    s.human(`before ${i}: ${deterministicText(VOCAB, 3000)}`);
    s.say(`Noted ${i}.`);
  }
  s.push(boundaryLine(s, 1));
  s.user(`${CONTINUED} Summary:\n${deterministicText(VOCAB, 10_000)}`, { isCompactSummary: true });
  for (let i = 1; i <= 5; i++) {
    s.human(`after ${i}: ${deterministicText(VOCAB, 2000)}`);
    s.say(`Done ${i}.`);
  }
  return s.render();
}

/** A main session whose sidechain entries carry a boundary, a summary and the summary sentence. */
export function sidechainBoundarySession(s8 = "e6000026"): string {
  const s = new SessionBuilder("widget", s8, START);
  s.human("survey the gadgets with a helper");
  s.say("Starting a helper.");
  s.push(boundaryLine(s, 1, { isSidechain: true }));
  s.user(`${CONTINUED} Summary: the helper's own context.`, { isCompactSummary: true, isSidechain: true });
  s.user(`${CONTINUED} The helper was surveying gadgets.`, { isSidechain: true });
  s.human("and the sprockets too");
  s.say("Both surveyed.");
  return s.render();
}

/** A subagent transcript whose parent prompt opens with the summary sentence. */
export function subagentContinuedSession(agentId = "e7a0b1c2d3e4f5a6b", parent = fixtureUuid("e6000026", 0)): string {
  const s = new SessionBuilder("widget", agentId.slice(0, 8), START, { agentId, parent });
  s.user(`${CONTINUED} Pick up the gadget survey.`);
  s.say("Picking it up.");
  return s.render();
}

/**
 * A compaction whose wait is ended by a human prompt (no summary), then a summary-looking line
 * much later, which is a boundary of its own; and a call touching two files.
 */
export function farSummarySession(s8 = "e8000028"): string {
  const s = new SessionBuilder("widget", s8, START);
  s.human("start the flange work");
  s.say("Starting.");
  s.push(boundaryLine(s, 1));
  s.silent("file-history-snapshot", { n: 1 });
  s.human("keep going");
  s.assistant([s.toolUse(TOOL(s8, 1), "Bash", { command: "cp src/flange/a.ts src/flange/b.ts" })]);
  s.toolResult(TOOL(s8, 1), "copied");
  s.say("Copied.");
  s.user(`${CONTINUED} The flange work was copied.`);
  s.human("now the second half");
  s.say("Second half done.");
  return s.render();
}

/** Two sessions sharing an <s8>, each with several messages long enough for a small budget to bite. */
export function sharedS8Sessions(): Array<{ name: string; text: string }> {
  return ["c4d6e8fa-0000-4000-8000-000000000000", "c4d6e8fa-ffff-4000-8000-000000000000"].map((id, k) => {
    const s = new SessionBuilder("gadget", "c4d6e8fa", k === 0 ? "2026-11-06T09:00:00.000Z" : "2026-11-06T10:00:00.000Z", { id });
    for (let i = 1; i <= 4; i++) {
      s.human(`gadget step ${i} for ${id.slice(9, 13)}: ${deterministicText(VOCAB, 60)}`);
      s.say(`Step ${i} done.`);
    }
    return { name: `${id}.jsonl`, text: s.render() };
  });
}

/** A slash command whose args carry leading, inner and trailing spaces. */
export function spacedSlashSession(s8 = "e9000029"): string {
  const s = new SessionBuilder("widget", s8, START);
  s.user("<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args> src/a.ts  --strict </command-args>", { origin: { kind: "human" }, promptSource: "typed" });
  s.say("Reviewing.");
  return s.render();
}

// ---------------------------------------------------------------------------------------------
// resume pack (plan resume-pack-library): generated at test time

/** The window-1 `H` texts of `resumeSession()`, as each event's text must read: oldest first. */
export const RESUME_HUMAN = [
  `pick up the flange split where the summary left off:\n  1. keep the public API\n  2. "no" renames\n${deterministicText(VOCAB, 600)}`,
  "/review src/flange/a.ts  --strict ",
  `also run the sprocket tests when you're done — ünïcode and trailing space ${deterministicText(VOCAB, 400)} `,
  "beta",
  `${deterministicText(VOCAB, 600)}\n\nthen tell me what is left`,
  `last thing: ship it and update the plan file ${deterministicText(VOCAB, 500)}`,
];

/**
 * A session with one compaction (two windows) whose last window holds every `H` kind (typed,
 * slash, queued, answer), 12 tool calls (one error, one persisted output, one pending), and five
 * assistant texts; message sizes chosen so a 2,000-char budget has to drop claims, then calls,
 * then the oldest human messages.
 */
export function resumeSession(s8 = "ea00002a"): string {
  const s = new SessionBuilder("widget", s8, START);
  s.human("start the flange split");
  s.assistant([s.toolUse(TOOL(s8, 100), "Read", { file_path: "src/flange/index.ts" })]);
  s.toolResult(TOOL(s8, 100), "export * from './a';");
  s.say("Window zero work done.");
  s.push(boundaryLine(s, 1));
  s.user(`${CONTINUED} Summary:\n1. The flange module is being split into a.ts and b.ts.`, { isCompactSummary: true });
  const [typed, slash, queued, answer, long, last] = RESUME_HUMAN;
  s.human(typed!);
  s.user(`<command-name>/review</command-name>\n<command-message>review</command-message>\n<command-args>src/flange/a.ts  --strict </command-args>`, { origin: { kind: "human" }, promptSource: "typed" });
  let n = 0;
  const call = (name: string, input: Json, result: string, extra: Json = {}) => {
    const id = TOOL(s8, ++n);
    s.assistant([s.toolUse(id, name, input)]);
    s.toolResult(id, result, {}, extra);
  };
  call("Read", { file_path: "src/flange/a.ts" }, "export const a = 1;");
  s.say(`Claim one: ${deterministicText(VOCAB, 180)}`);
  call("Edit", { file_path: "src/flange/a.ts", old_string: "1", new_string: "2" }, "updated");
  s.attachment({ type: "queued_command", prompt: queued!, commandMode: "prompt", origin: { kind: "human" } });
  call("Bash", { command: "bun test src/flange", description: "Test" }, "FAIL flange.test.ts", { is_error: true });
  s.say(`Claim two: ${deterministicText(VOCAB, 180)}`);
  const q = TOOL(s8, ++n);
  s.assistant([s.toolUse(q, "AskUserQuestion", { questions: [{ question: "Which channel?", options: [{ label: "beta" }, { label: "stable" }] }] })]);
  s.toolResult(q, `User has answered your questions: "Which channel?"="${answer!}".`, {
    toolUseResult: { questions: [{ question: "Which channel?" }], answers: { "Which channel?": answer! } },
  });
  s.human(long!);
  for (const f of ["b.ts", "c.ts", "d.ts"]) call("Write", { file_path: `src/flange/${f}`, content: "x" }, "written");
  s.say(`Claim three: ${deterministicText(VOCAB, 180)}`);
  const stored = `/fixture-root/projects/${PROJECTS.widget.encoded}/${s.id}/tool-results/bfx00ea.txt`;
  call("Bash", { command: "bun run build", description: "Build" }, `<persisted-output>\nOutput too large (9.9KB). Full output saved to: ${stored}\n\nPreview (first 2KB):\nbuild log\n...\n</persisted-output>`);
  for (const f of ["e.ts", "f.ts", "g.ts"]) call("Read", { file_path: `src/flange/${f}` }, "ok");
  s.say(`Claim four: ${deterministicText(VOCAB, 180)}`);
  s.human(last!);
  call("Bash", { command: "git push", description: "Push" }, "pushed");
  s.say(`Claim five: ${deterministicText(VOCAB, 180)}`);
  // A call whose result never arrives: `pending`.
  s.assistant([s.toolUse(TOOL(s8, ++n), "Bash", { command: "gh pr create", description: "Open the PR" })]);
  return s.render();
}

/** Human prompts and tool calls but no assistant text: an empty `claims` layer. */
export function silentAgentSession(s8 = "eb00002b"): string {
  const s = new SessionBuilder("widget", s8, START);
  s.human("list the gadgets");
  s.assistant([s.toolUse(TOOL(s8, 1), "Bash", { command: "ls src/gadget" })]);
  s.toolResult(TOOL(s8, 1), "a.ts\nb.ts");
  return s.render();
}

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = join(here, "claude");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : FIXTURE_ROOT;
  const files = buildFixtures(out);
  process.stdout.write(`wrote ${files.length} files under ${out}\n`);
}
