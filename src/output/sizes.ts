/** Character counts: bare below 1000, then `1.2k`, then `3.4M` (row-format.md#sizes). */
export function formatSize(n: number): string {
  if (n < 1000) return String(n);
  if (n < 999_950) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** File sizes for scan reports: `812 B`, `3.4 KB`, `38.4 MB`, `1.2 GB` (cli.md#find, #recall). */
export function formatBytes(n: number): string {
  if (n < 1000) return `${n} B`;
  if (n < 999_950) return `${(n / 1000).toFixed(1)} KB`;
  if (n < 999_950_000) return `${(n / 1_000_000).toFixed(1)} MB`;
  return `${(n / 1_000_000_000).toFixed(1)} GB`;
}
