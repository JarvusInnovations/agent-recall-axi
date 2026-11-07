import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { countNewlines, headHash, readLines, readLinesBackward } from "../src/lib/reader.js";

const tmp = mkdtempSync(join(tmpdir(), "asa-reader-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function forward(path: string, blockSize?: number) {
  const out = [];
  for await (const l of readLines(path, blockSize ? { blockSize } : {})) out.push(l);
  return out;
}
async function backward(path: string, blockSize?: number) {
  const out = [];
  for await (const l of readLinesBackward(path, blockSize)) out.push(l);
  return out;
}

describe("reader", () => {
  const cases: Record<string, string> = {
    plain: "a\nbb\nccc\n",
    partial: "a\nbb\n{\"type\":\"us",
    leadingBlank: "\na\n\nb\n",
    single: "only",
    empty: "",
    unicode: "héllo\n世界\n🙂x\n",
  };

  for (const [name, content] of Object.entries(cases)) {
    it(`forward and backward agree (${name}) at several block sizes`, async () => {
      const path = join(tmp, `${name}.jsonl`);
      writeFileSync(path, content);
      for (const bs of [1, 2, 3, 7, 1 << 20]) {
        const f = await forward(path, bs);
        const b = (await backward(path, bs)).reverse();
        expect(b.map((l) => [l.offset, l.text, l.partial])).toEqual(f.map((l) => [l.offset, l.text, l.partial]));
        expect(f.map((l) => l.seq)).toEqual(f.map((_, i) => i + 1));
      }
      const f = await forward(path);
      const nl = await countNewlines(path);
      expect(nl).toBe((content.match(/\n/g) ?? []).length);
      for (const l of f) expect(await countNewlines(path, l.offset)).toBe(l.seq - 1);
    });
  }

  it("marks a trailing line without newline as partial", async () => {
    const path = join(tmp, "live.jsonl");
    writeFileSync(path, '{"a":1}\n{"b":');
    const f = await forward(path);
    expect(f.map((l) => l.partial)).toEqual([false, true]);
  });

  it("respects startOffset/startSeq/endSeq", async () => {
    const path = join(tmp, "range.jsonl");
    writeFileSync(path, "l1\nl2\nl3\nl4\n");
    const out = [];
    for await (const l of readLines(path, { startOffset: 3, startSeq: 2, endSeq: 4 })) out.push([l.seq, l.text]);
    expect(out).toEqual([
      [2, "l2"],
      [3, "l3"],
    ]);
  });

  it("head hash depends on the first line only", async () => {
    const a = join(tmp, "h1.jsonl");
    const b = join(tmp, "h2.jsonl");
    writeFileSync(a, "same\nx\n");
    writeFileSync(b, "same\ny\nz\n");
    expect(await headHash(a)).toBe(await headHash(b));
  });
});
