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
    readonly opts: { agentId?: string; parent?: string } = {},
  ) {
    this.s8 = s8;
    this.id = fixtureUuid(s8, 0);
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

function gadgetProject(): Fixture {
  const s = new SessionBuilder("gadget", "c1000013", "2026-11-06T10:00:00.000Z");
  s.human("add a gadget counter");
  s.say("Added a counter to the gadget panel.");
  return { name: "gadget", session: s };
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
    gadgetProject(),
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

const here = dirname(fileURLToPath(import.meta.url));
export const FIXTURE_ROOT = join(here, "claude");

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const out = process.argv[2] ? resolve(process.argv[2]) : FIXTURE_ROOT;
  const files = buildFixtures(out);
  process.stdout.write(`wrote ${files.length} files under ${out}\n`);
}
