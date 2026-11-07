import { describe, expect, it } from "vitest";
import { formatClock, formatDay, parseSpan, parseWhen, resolveZone } from "../src/lib/time.js";
import { AgentSessionError } from "../src/lib/errors.js";

const now = new Date("2026-11-07T14:30:00.000Z"); // 09:30 in New York, 23:30 in Tokyo

describe("time grammar", () => {
  it("dates are local-day starts; as --to they mean the start of the next day", () => {
    const ny = "America/New_York";
    expect(parseWhen("2026-04-20", { tz: ny }).toISOString()).toBe("2026-04-20T04:00:00.000Z");
    expect(parseWhen("2026-04-20", { tz: ny, endOfDay: true }).toISOString()).toBe("2026-04-21T04:00:00.000Z");
    expect(parseWhen("2026-04-20", { tz: "UTC" }).toISOString()).toBe("2026-04-20T00:00:00.000Z");
  });

  it("ISO instants with and without a zone", () => {
    expect(parseWhen("2026-04-20T14:00", { tz: "UTC" }).toISOString()).toBe("2026-04-20T14:00:00.000Z");
    expect(parseWhen("2026-04-20T14:00", { tz: "Asia/Tokyo" }).toISOString()).toBe("2026-04-20T05:00:00.000Z");
    expect(parseWhen("2026-04-20T14:00:30Z", { tz: "Asia/Tokyo" }).toISOString()).toBe("2026-04-20T14:00:30.000Z");
    expect(parseWhen("2026-04-20T14:00-04:00", { tz: "UTC" }).toISOString()).toBe("2026-04-20T18:00:00.000Z");
  });

  it("tokens", () => {
    const tz = "America/New_York";
    expect(parseWhen("now", { tz, now }).getTime()).toBe(now.getTime());
    expect(parseWhen("today", { tz, now }).toISOString()).toBe("2026-11-07T05:00:00.000Z");
    expect(parseWhen("today", { tz, now, endOfDay: true }).toISOString()).toBe("2026-11-08T05:00:00.000Z");
    expect(parseWhen("yesterday", { tz, now }).toISOString()).toBe("2026-11-06T05:00:00.000Z");
    expect(parseWhen("-1d", { tz, now }).toISOString()).toBe("2026-11-06T05:00:00.000Z");
    // across the DST change (US clocks fell back on 2026-11-01)
    expect(parseWhen("-1w", { tz, now }).toISOString()).toBe("2026-10-31T04:00:00.000Z");
    expect(parseWhen("-2h", { tz, now }).toISOString()).toBe("2026-11-07T12:30:00.000Z");
    expect(parseWhen("+90m", { tz, now }).toISOString()).toBe("2026-11-07T16:00:00.000Z");
  });

  it("spans", () => {
    expect(parseSpan("90m")).toBe(90 * 60_000);
    expect(parseSpan("24h")).toBe(86_400_000);
    expect(parseSpan("7d")).toBe(7 * 86_400_000);
    expect(parseSpan("2w")).toBe(14 * 86_400_000);
    expect(() => parseSpan("7x")).toThrow(AgentSessionError);
  });

  it("rejects what does not parse, with the grammar", () => {
    for (const bad of ["tomorrowish", "2026-13-01", "2026-02-30", "2026-04-20T25:00"]) {
      try {
        parseWhen(bad, { tz: "UTC" });
        expect.fail(bad);
      } catch (err) {
        expect(err).toBeInstanceOf(AgentSessionError);
        expect((err as AgentSessionError).code).toBe("VALIDATION_ERROR");
      }
    }
  });

  it("renders in the zone given", () => {
    const d = new Date("2026-11-07T23:50:00.000Z");
    expect(formatDay(d, "UTC")).toBe("2026-11-07");
    expect(formatDay(d, "Asia/Tokyo")).toBe("2026-11-08");
    expect(formatClock(d, "Asia/Tokyo")).toBe("08:50:00");
  });

  it("zone resolution: flag, then TZ, then the system zone", () => {
    expect(resolveZone("Asia/Tokyo", { TZ: "UTC" })).toBe("Asia/Tokyo");
    expect(resolveZone(undefined, { TZ: "Asia/Tokyo" })).toBe("Asia/Tokyo");
    expect(resolveZone(undefined, { TZ: "Not/AZone" })).toBeTruthy();
    expect(() => resolveZone("Not/AZone", {})).toThrow(AgentSessionError);
  });
});
