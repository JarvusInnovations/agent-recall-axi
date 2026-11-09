import { describe, expect, it } from "vitest";
import * as lib from "../src/lib/index.js";
import { fx } from "./helpers/run.js";

describe("linkedResult", () => {
  it("fetches a call's result and a result's call; undefined for a pending call", async () => {
    const linkedResult = (lib as Record<string, unknown>).linkedResult as (s: lib.Session, e: lib.Event) => Promise<lib.Event | undefined>;
    expect(typeof linkedResult).toBe("function");
    const session = await lib.openSession(fx("parallel-tools"));
    const rows = (await lib.listEvents(session, { kinds: "all", limit: 0 })).rows;
    const call = rows.find((e) => e.kind === "call" && e.tool === "Read")!;
    const result = await linkedResult(session, call);
    expect(result?.kind).toBe("result");
    expect(lib.formatId(result!.id)).toBe(lib.formatId(call.result!));
    const back = await linkedResult(session, result!);
    expect(lib.formatId(back!.id)).toBe(lib.formatId(call.id));
    const pending = rows.find((e) => e.kind === "call" && e.tool === "Edit")!;
    expect(await linkedResult(session, pending)).toBeUndefined();
    const multi = await lib.openSession(fx("multi-block"));
    const grep = (await lib.listEvents(multi, { kinds: ["call"], limit: 0 })).rows.find((e) => e.tool === "Grep")!;
    expect(lib.formatId((await linkedResult(multi, grep))!.id)).toBe("b4000015:4.1");
  });
});
