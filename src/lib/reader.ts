/**
 * Streaming, read-only line access to log files (specs/architecture.md#streaming-and-memory).
 * Files are opened with flag "r" only; nothing here writes (specs/behaviors/privacy.md).
 */
import { createHash } from "node:crypto";
import { open } from "node:fs/promises";

export const BLOCK_SIZE = 1 << 20; // 1 MB
const NL = 0x0a;

export interface Line {
  /** 1-based line number. */
  seq: number;
  /** Byte offset of the line's first byte. */
  offset: number;
  text: string;
  /** The last line of a file that does not end in a newline (a live file mid-append). */
  partial: boolean;
}

export interface ForwardOpts {
  /** Byte offset to start at; must be a line start. Default 0. */
  startOffset?: number;
  /** The seq of the line at `startOffset`. Default 1. */
  startSeq?: number;
  /** Stop before this seq (exclusive). */
  endSeq?: number;
  blockSize?: number;
}

/** Forward line stream with seq stamps; memory is one block plus the longest line. */
export async function* readLines(path: string, opts: ForwardOpts = {}): AsyncGenerator<Line> {
  const blockSize = opts.blockSize ?? BLOCK_SIZE;
  const fh = await open(path, "r");
  try {
    let position = opts.startOffset ?? 0;
    let seq = opts.startSeq ?? 1;
    let lineStart = position;
    let pieces: Buffer[] = [];
    const buf = Buffer.allocUnsafe(blockSize);
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, blockSize, position);
      if (bytesRead === 0) break;
      const chunk = buf.subarray(0, bytesRead);
      let from = 0;
      for (;;) {
        const nl = chunk.indexOf(NL, from);
        if (nl === -1) break;
        const part = chunk.subarray(from, nl);
        const text = pieces.length ? Buffer.concat([...pieces, part]).toString("utf8") : part.toString("utf8");
        pieces = [];
        if (opts.endSeq !== undefined && seq >= opts.endSeq) return;
        yield { seq, offset: lineStart, text, partial: false };
        seq++;
        lineStart = position + nl + 1;
        from = nl + 1;
      }
      if (from < bytesRead) pieces.push(Buffer.from(chunk.subarray(from)));
      position += bytesRead;
    }
    if (pieces.length) {
      if (opts.endSeq !== undefined && seq >= opts.endSeq) return;
      yield { seq, offset: lineStart, text: Buffer.concat(pieces).toString("utf8"), partial: true };
    }
  } finally {
    await fh.close();
  }
}

export interface BackwardLine {
  offset: number;
  text: string;
  partial: boolean;
}

/** Lines newest first, read in blocks from the end; no seq (see `countNewlines`). */
export async function* readLinesBackward(path: string, blockSize = BLOCK_SIZE): AsyncGenerator<BackwardLine> {
  const fh = await open(path, "r");
  try {
    const { size } = await fh.stat();
    if (size === 0) return;
    let end = size;
    // Bytes of the line whose start has not been found yet (everything after the newest newline seen).
    let carry: Buffer = Buffer.alloc(0);
    // The first fragment emitted is what follows the file's final newline: empty, or a partial line.
    let first = true;
    const emit = (offset: number, bytes: Buffer): BackwardLine | undefined => {
      if (first) {
        first = false;
        return bytes.length > 0 ? { offset, text: bytes.toString("utf8"), partial: true } : undefined;
      }
      return { offset, text: bytes.toString("utf8"), partial: false };
    };
    while (end > 0) {
      const start = Math.max(0, end - blockSize);
      const buf = Buffer.allocUnsafe(end - start);
      await readFully(fh, buf, start);
      let stop = buf.length;
      while (stop > 0) {
        const nl = buf.lastIndexOf(NL, stop - 1);
        if (nl === -1) break;
        const line = emit(start + nl + 1, Buffer.concat([buf.subarray(nl + 1, stop), carry]));
        carry = Buffer.alloc(0);
        if (line) yield line;
        stop = nl;
      }
      carry = Buffer.concat([buf.subarray(0, stop), carry]);
      end = start;
    }
    const line = emit(0, carry);
    if (line) yield line;
  } finally {
    await fh.close();
  }
}

async function readFully(fh: import("node:fs/promises").FileHandle, buf: Buffer, position: number): Promise<void> {
  let done = 0;
  while (done < buf.length) {
    const { bytesRead } = await fh.read(buf, done, buf.length - done, position + done);
    if (bytesRead === 0) break;
    done += bytesRead;
  }
}

/** Count newline bytes in `[0, endOffset)`; the seq of the line starting at `endOffset` is this + 1. */
export async function countNewlines(path: string, endOffset?: number, blockSize = BLOCK_SIZE): Promise<number> {
  const fh = await open(path, "r");
  try {
    const limit = endOffset ?? (await fh.stat()).size;
    const buf = Buffer.allocUnsafe(blockSize);
    let position = 0;
    let count = 0;
    while (position < limit) {
      const want = Math.min(blockSize, limit - position);
      const { bytesRead } = await fh.read(buf, 0, want, position);
      if (bytesRead === 0) break;
      let from = 0;
      const view = buf.subarray(0, bytesRead);
      for (;;) {
        const nl = view.indexOf(NL, from);
        if (nl === -1) break;
        count++;
        from = nl + 1;
      }
      position += bytesRead;
    }
    return count;
  } finally {
    await fh.close();
  }
}

/** sha256 of the first line's bytes (rewrite detection keys on it; see ids-and-show). */
export async function headHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const line of readLines(path)) {
    hash.update(line.text);
    break;
  }
  return hash.digest("hex");
}
