/** Typed library error; the CLI maps each code one-to-one onto an AxiError (specs/api.md#errors). */
export const ERROR_CODES = ["USAGE", "VALIDATION_ERROR", "NOT_FOUND", "AMBIGUOUS_SESSION", "NO_SESSIONS", "UNREADABLE", "INTERNAL_ERROR"] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export class AgentSessionError extends Error {
  readonly code: ErrorCode;
  readonly suggestions: string[];
  readonly details?: Record<string, unknown>;

  constructor(message: string, code: ErrorCode, suggestions: string[] = [], details?: Record<string, unknown>) {
    super(message);
    this.name = "AgentSessionError";
    this.code = code;
    this.suggestions = suggestions;
    if (details) this.details = details;
  }
}
