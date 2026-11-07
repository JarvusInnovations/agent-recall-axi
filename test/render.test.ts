import { describe, expect, it } from "vitest";
import { oneLine, rowText } from "../src/output/render.js";
import type { Event } from "../src/lib/model.js";

describe("row text", () => {
  it("collapses newline runs to one space and changes nothing else", () => {
    expect(oneLine("a\n\nb")).toBe("a b");
    expect(oneLine("a\r\n\r\nb")).toBe("a b");
    // Spaces and tabs around newlines, and at the ends, are the human's bytes.
    expect(oneLine("  keep  \n\t indent\t\n")).toBe("  keep   \t indent\t ");
  });

  it("a human row keeps its spacing", () => {
    const ev: Event = { id: { session: "d0000001", seq: 1 }, kind: "human", authority: "H", text: "fix  this:\n    indented", size: 22 };
    expect(rowText(ev, { head: 200 }).text).toBe("fix  this:     indented");
  });
});
