/**
 * Per-command flag declarations and a fail-loud parser (specs/behaviors/errors.md#rules,
 * specs/cli.md#conventions). Unknown flags are rejected by name with the valid set inline.
 */
import { AxiError } from "axi-sdk-js";

export const BIN = "agent-session-axi";

export type { FlagSpec, FlagValue } from "./reference.js";
import { GLOBAL_FLAGS, type FlagSpec } from "./reference.js";

/** Renamed or commonly guessed flags → their replacement (targeted hint instead of the generic list). */
const RENAMED: Record<string, string> = {
  n: "limit",
  num: "limit",
  until: "to",
  json: "json-out",
  kinds: "kind",
};

export interface Parsed {
  flags: Map<string, string | true>;
  positionals: string[];
  help: boolean;
}

export function parseFlags(command: string, args: string[], specs: FlagSpec[]): Parsed {
  const all = [...specs, ...GLOBAL_FLAGS];
  const byName = new Map(all.map((s) => [s.name, s]));
  const flags = new Map<string, string | true>();
  const positionals: string[] = [];
  let help = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (arg === "--help" || arg === "-h") {
      help = true;
      continue;
    }
    if (!arg.startsWith("-") || arg === "-" || /^-\d/.test(arg)) {
      positionals.push(arg);
      continue;
    }
    const body = arg.replace(/^--?/, "");
    const eq = body.indexOf("=");
    const name = eq === -1 ? body : body.slice(0, eq);
    const inline = eq === -1 ? undefined : body.slice(eq + 1);
    const spec = byName.get(name);
    if (!spec) {
      const renamed = RENAMED[name];
      if (renamed && byName.has(renamed)) {
        throw new AxiError(`unknown flag --${name} for \`${command}\``, "UNKNOWN_FLAG", [
          `--${name} is not a flag of this tool; use --${renamed}`,
          validFlagsLine(command, specs),
        ]);
      }
      throw new AxiError(`unknown flag ${arg.split("=")[0]} for \`${command}\``, "UNKNOWN_FLAG", [
        validFlagsLine(command, specs),
        `Run \`${BIN} ${command} --help\` for usage`,
      ]);
    }
    if (spec.planned) {
      throw new AxiError(`--${name} is not available yet in this version (planned: ${spec.planned})`, "USAGE", [
        validFlagsLine(command, specs.filter((s) => !s.planned)),
      ]);
    }
    if (spec.value === "boolean") {
      if (inline !== undefined) throw new AxiError(`--${name} takes no value`, "USAGE", [usageLine(command)]);
      flags.set(name, true);
      continue;
    }
    let value = inline;
    if (value === undefined) {
      if (i + 1 >= args.length) throw new AxiError(`--${name} needs a value ${spec.arg ?? ""}`.trim(), "USAGE", [usageLine(command)]);
      value = args[++i]!;
    }
    if (spec.value === "number" && !/^\d+$/.test(value)) {
      throw new AxiError(`--${name} must be a non-negative integer, got ${value}`, "VALIDATION_ERROR", [`e.g. --${name} 20`]);
    }
    flags.set(name, value);
  }
  return { flags, positionals, help };
}

const usageLines = new Map<string, string>();
export function registerUsage(command: string, usage: string): void {
  usageLines.set(command, usage);
}
function usageLine(command: string): string {
  return `usage: ${usageLines.get(command) ?? `${BIN} ${command}`}`;
}

export function validFlagsLine(command: string, specs: FlagSpec[]): string {
  const names = specs.filter((s) => !s.planned).map((s) => `--${s.name}`);
  return `valid flags for \`${command}\`: ${names.length ? names.join(", ") : "(none)"} (--help and --tz always allowed)`;
}

export function getString(p: Parsed, name: string): string | undefined {
  const v = p.flags.get(name);
  return typeof v === "string" ? v : undefined;
}
export function getNumber(p: Parsed, name: string): number | undefined {
  const v = getString(p, name);
  return v === undefined ? undefined : Number(v);
}
export function getBool(p: Parsed, name: string): boolean {
  return p.flags.get(name) === true;
}
