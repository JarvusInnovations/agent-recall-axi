/** Character counts: bare below 1000, then `1.2k`, then `3.4M` (row-format.md#sizes). */
export function formatSize(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_950) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}
