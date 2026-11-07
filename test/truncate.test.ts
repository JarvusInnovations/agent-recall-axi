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
    const r = head(target, 30, { paths: true });
    expect(r.text).toBe("echo hi && cat src/widget/components/listing/table/very/long/file-name.ts…");
    expect(head(target, 30).text).toBe(`${target.slice(0, 30)}…`);
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
