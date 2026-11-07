/**
 * Cuts and marks (specs/behaviors/truncation.md). The library never truncates; every cut a
 * view makes happens here, keeps the text before the cut byte-for-byte, and is marked.
 *
 * A cut never lands inside a URL (it moves to the URL's end), an id, or, in a `call` target,
 * a path (the path is kept whole and the rest of the target is cut).
 */

/** The row mark for a cut head. */
export const ROW_MARK = "…";

const URL_RE = /[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>"'`]+/g;
/** Not `\b`: an id glued to a word (`xxxxdeadbeef:12`) is still an id; only more hex before it is not. */
const ID_RE = /(?<![0-9a-f])[0-9a-f]{8}:[1-9][0-9]*(?:\.[1-9][0-9]*)?(?![0-9])/g;
/** A whitespace-delimited token with a `/` in it, quotes excluded. */
const PATH_RE = /[^\s'"`;|&()<>]*\/[^\s'"`;|&()<>]*/g;

export interface CutOpts {
  /** Also keep path-like tokens whole (`call` targets). */
  paths?: boolean;
}

function spans(text: string, opts: CutOpts): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const res = [URL_RE, ID_RE, ...(opts.paths ? [PATH_RE] : [])];
  for (const re of res) {
    re.lastIndex = 0;
    for (let m = re.exec(text); m; m = re.exec(text)) {
      if (m[0].length === 0) {
        re.lastIndex++;
        continue;
      }
      out.push([m.index, m.index + m[0].length]);
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Where a cut aimed at `n` may land: never inside a protected span or a surrogate pair. The cut
 * moves to a span's end only when that end is at most one cap (`n`) further on; a span longer
 * than that (a 100 KB URL or token) is cut hard at `n`, so a head stays within twice its cap.
 */
export function cutPoint(text: string, n: number, opts: CutOpts = {}): number {
  if (n >= text.length) return text.length;
  const hard = (at: number) => {
    const code = text.charCodeAt(at);
    return code >= 0xdc00 && code <= 0xdfff ? at - 1 : at;
  };
  const limit = n + n;
  let end = n;
  const protectedSpans = spans(text, opts);
  for (let moved = true; moved; ) {
    moved = false;
    for (const [s, e] of protectedSpans) {
      if (s < end && end < e) {
        if (e > limit) return hard(n);
        end = e;
        moved = true;
      }
    }
  }
  return end === n ? hard(n) : end;
}

/** A row head: at most `n` chars (more only to finish a URL, id or path), `…` when cut. `n <= 0` = uncapped. */
export function head(text: string, n: number, opts: CutOpts = {}): { text: string; cut: boolean } {
  if (n <= 0 || text.length <= n) return { text, cut: false };
  const end = cutPoint(text, n, opts);
  if (end >= text.length) return { text, cut: false };
  return { text: `${text.slice(0, end)}${ROW_MARK}`, cut: true };
}

/** The detail-view cap (`show` text, input JSON, result text). */
export const DETAIL_CAP = 4000;

/** The house marker: ` … (truncated, 8432 chars total)`. */
export function detailMark(total: number): string {
  return ` … (truncated, ${total} chars total)`;
}

/** A detail field: whole up to `cap`, else the head plus the house marker. `cap <= 0` = uncapped. */
export function detail(text: string, cap = DETAIL_CAP): { text: string; cut: boolean } {
  if (cap <= 0 || text.length <= cap) return { text, cut: false };
  const end = cutPoint(text, cap);
  if (end >= text.length) return { text, cut: false };
  return { text: `${text.slice(0, end)}${detailMark(text.length)}`, cut: true };
}
