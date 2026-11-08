/**
 * SessionStart payload detection: hook mode for the home view (specs/cli.md#home-view-no-arguments).
 * Claude Code (and Codex) write one JSON object to a hook's stdin. The read is bounded so a home
 * view started with a stdin nobody writes to never hangs, and anything that is not a usable
 * payload means "print the listing", never an error.
 */
import type { Readable } from "node:stream";

export interface HookPayload {
  session_id: string;
  source: string;
  transcript_path?: string;
}

export interface ReadLimits {
  /** Give up when no byte has arrived within this long. */
  firstByteMs: number;
  /** Stop this long after the first byte. */
  totalMs: number;
  /** Stop after this many bytes. */
  maxBytes: number;
}

export const HOOK_READ_LIMITS: ReadLimits = { firstByteMs: 200, totalMs: 1000, maxBytes: 64 * 1024 };

/** The sources after which the agent has lost its context: print the resume pack. */
export const RESUME_SOURCES = new Set(["compact", "resume"]);

const SESSION_ID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$|^[0-9a-f]{8,}$/i;

/** A SessionStart payload with a usable `session_id` and `source`, or undefined. */
export function parseHookPayload(text: string | undefined): HookPayload | undefined {
  if (!text || !text.trim()) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const v = value as Record<string, unknown>;
  if (typeof v.session_id !== "string" || typeof v.source !== "string") return undefined;
  // Only a session id goes on to resume-pack: never a path, a flag or a reference like `latest`.
  if (!SESSION_ID.test(v.session_id)) return undefined;
  const out: HookPayload = { session_id: v.session_id.toLowerCase(), source: v.source };
  if (typeof v.transcript_path === "string") out.transcript_path = v.transcript_path;
  return out;
}

/** process.stdin, or a test's stream. */
export type StdinLike = Readable & { isTTY?: boolean };

/**
 * Read a hook payload from stdin within `limits`; undefined for a TTY, nothing, or not JSON.
 * Resolves as soon as the bytes read parse as one JSON object, so a writer that never closes
 * the pipe costs nothing.
 */
export function readHookStdin(stdin: StdinLike | undefined, limits: ReadLimits = HOOK_READ_LIMITS): Promise<string | undefined> {
  if (!stdin || stdin.isTTY) return Promise.resolve(undefined);
  return new Promise((resolveText) => {
    let text = "";
    let bytes = 0;
    let done = false;
    let total: ReturnType<typeof setTimeout> | undefined;
    const finish = (value: string | undefined) => {
      if (done) return;
      done = true;
      clearTimeout(first);
      if (total) clearTimeout(total);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("close", onEnd);
      stdin.removeListener("error", onError);
      // Release the handle so a pipe left open by its writer does not keep the process alive.
      try {
        stdin.pause();
        stdin.destroy();
      } catch {
        // already closed
      }
      resolveText(value);
    };
    const onData = (chunk: Buffer | string) => {
      if (total === undefined) total = setTimeout(() => finish(text || undefined), limits.totalMs);
      const s = typeof chunk === "string" ? chunk : chunk.toString("utf8");
      bytes += typeof chunk === "string" ? Buffer.byteLength(chunk) : chunk.length;
      text += s;
      if (bytes >= limits.maxBytes) return finish(text);
      if (text.trimEnd().endsWith("}")) {
        try {
          JSON.parse(text);
          finish(text);
        } catch {
          // not complete yet
        }
      }
    };
    const onEnd = () => finish(text || undefined);
    const onError = () => finish(undefined);
    const first = setTimeout(() => {
      if (bytes === 0) finish(undefined);
    }, limits.firstByteMs);
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("close", onEnd);
    stdin.on("error", onError);
  });
}
