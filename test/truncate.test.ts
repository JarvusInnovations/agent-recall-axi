import { describe, expect, it } from "vitest";
import { cutPoint, detail, detailMark, head } from "../src/output/truncate.js";

describe("truncate.head", () => {
  it("cuts at n and marks with …; whole text under the cap is untouched", () => {
    const text = "x".repeat(300);
    expect(head(text, 200)).toEqual({ text: `${"x".repeat(200)}…`, cut: true });
    expect(head("short", 200)).toEqual({ text: "short", cut: false });
    expect(head(text, 0)).toEqual({ text, cut: false });
  });

  it("never cuts inside a URL: the cut moves to its end", () => {
    const url = "https://docs.example.test/a/very/long/path/to/a/page?with=query";
    const text = `${"a".repeat(190)} ${url} and more after it`;
    const r = head(text, 200);
    expect(r.text).toBe(`${"a".repeat(190)} ${url}…`);
    // A URL that ends the text: nothing is cut at all.
    expect(head(`${"a".repeat(190)} ${url}`, 200).cut).toBe(false);
  });

  it("never cuts inside an id", () => {
    const text = `${"a".repeat(195)} 7a2f1c3e:4180.12 rest`;
    expect(head(text, 200).text).toBe(`${"a".repeat(195)} 7a2f1c3e:4180.12…`);
  });

  it("keeps path tokens whole when asked (call targets)", () => {
    const target = `echo hi && cat src/widget/components/listing/table/very/long/file-name.ts && echo done`;
    const r = head(target, 50, { paths: true });
    expect(r.text).toBe("echo hi && cat src/widget/components/listing/table/very/long/file-name.ts…");
    expect(head(target, 50).text).toBe(`${target.slice(0, 50)}…`);
  });

  it("does not split a surrogate pair", () => {
    const text = `${"a".repeat(199)}😀tail`;
    expect(head(text, 200).text).toBe(`${"a".repeat(199)}…`);
  });

  it("the kept text is a byte-for-byte prefix of the original", () => {
    const text = "line one https://example.test/x line two 7a2f1c3e:9 and src/a/b.ts end ".repeat(10);
    for (const n of [5, 13, 40, 77, 120]) {
      const r = head(text, n, { paths: true });
      expect(text.startsWith(r.text.replace(/…$/, ""))).toBe(true);
      expect(cutPoint(text, n, { paths: true })).toBeGreaterThanOrEqual(n - 1);
    }
  });
});

describe("truncate.detail", () => {
  it("adds the house marker with the total length only when cut", () => {
    const text = "y".repeat(8432);
    const r = detail(text);
    expect(r.cut).toBe(true);
    expect(r.text).toBe(`${"y".repeat(4000)}${detailMark(8432)}`);
    expect(detailMark(8432)).toBe(" … (truncated, 8432 chars total)");
    expect(detail("y".repeat(4000))).toEqual({ text: "y".repeat(4000), cut: false });
    expect(detail(text, 0)).toEqual({ text, cut: false });
  });
});

describe("truncation bounds", () => {
  it("a protected span may move the cut at most one cap past n; beyond that the cut is hard", () => {
    const token = `cat ${"QUJD/ZGVm".repeat(12_000)}`; // ~100 KB base64-ish token with slashes
    const r = head(token, 120, { paths: true });
    expect(r.cut).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(2 * 120 + 1);
    expect(token.startsWith(r.text.replace(/…$/, ""))).toBe(true);
    const url = `see https://example.test/${"a".repeat(100_000)} end`;
    const u = head(url, 200);
    expect(u.text.length).toBeLessThanOrEqual(401);
    expect(url.startsWith(u.text.replace(/…$/, ""))).toBe(true);
    const d = detail(`x https://example.test/${"b".repeat(100_000)}`);
    expect(d.text.length).toBeLessThanOrEqual(8000 + detailMark(100_000).length + 30);
  });

  it("an id glued to non-hex text is still protected", () => {
    const text = `${"a".repeat(195)}xxxxdeadbeef:12345 rest`;
    expect(head(text, 200).text).toBe(`${"a".repeat(195)}xxxxdeadbeef:12345…`);
  });

  it("a call target that is a huge path is cut hard, not kept whole", async () => {
    const { targetCut } = await import("../src/output/render.js");
    const path = `src/${"d/".repeat(50_000)}f.ts`;
    const ev = { id: { session: "7a2f1c3e", seq: 1 }, kind: "call", authority: "C", text: "", size: 0, tool: "Read", target: path, files: [path] } as const;
    const r = targetCut(ev as never, 120);
    expect(r.cut).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(2 * 120 + 1);
  });
});

describe("--fields target", () => {
  it("a target column cut counts toward the footer like a text cut", async () => {
    const { renderRows } = await import("../src/output/render.js");
    // An event whose text column is short but which carries a long target (as a future adapter's
    // non-call kind could): the column's cut must still be counted.
    const ev = { id: { session: "7a2f1c3e", seq: 3 }, kind: "notice", authority: "D", text: "short", size: 5, target: `run ${"word ".repeat(60)}` } as const;
    const r = renderRows([ev as never], "UTC", { head: 200, fields: ["target"] });
    expect(String(r.rows[0]!.target).endsWith("…")).toBe(true);
    expect(r.cut).toBe(1);
    expect(r.firstCut).toEqual({ session: "7a2f1c3e", seq: 3 });
  });
});
