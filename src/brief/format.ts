/**
 * Number and time formatting for the market brief. Self-contained on purpose: the brief pipeline
 * must not import the app config (it runs standalone against public endpoints), so symbol-rule
 * lookups are unavailable and precision is chosen from the magnitude of the number instead.
 */

const MISSING = '—';

export function fmtPrice(p: number | null | undefined): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return MISSING;
  const abs = Math.abs(p);
  const digits = abs >= 1 ? 2 : abs >= 0.01 ? 4 : 6;
  return p.toFixed(digits);
}

export function fmtPct(p: number | null | undefined, digits = 3): string {
  if (p === null || p === undefined || !Number.isFinite(p)) return MISSING;
  return `${p >= 0 ? '+' : ''}${p.toFixed(digits)}%`;
}

/** Funding rates are quoted in hundredths of a percent (0.0100%), so they keep four decimals. */
export function fmtRatePct(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || !Number.isFinite(rate)) return MISSING;
  return `${rate >= 0 ? '+' : ''}${(rate * 100).toFixed(4)}%`;
}

/** Base-asset quantities in the brief's style: 15.49k, 10.46M. */
export function fmtQty(q: number | null | undefined): string {
  if (q === null || q === undefined || !Number.isFinite(q)) return MISSING;
  const abs = Math.abs(q);
  if (abs >= 1e9) return `${(q / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(q / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(q / 1e3).toFixed(2)}k`;
  return q.toFixed(2);
}

export function fmtUsdCompact(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return MISSING;
  return `$${fmtQty(v)}`;
}

const two = (n: number) => String(n).padStart(2, '0');

/** "04:15" — candle close boundary, always UTC because the exchange reports UTC. */
export function fmtUtcHm(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return MISSING;
  const d = new Date(ms);
  return `${two(d.getUTCHours())}:${two(d.getUTCMinutes())}`;
}

/** "28 October 2026, 04:24 UTC" — the brief's snapshot stamp. */
export function fmtUtcStamp(ms: number): string {
  const d = new Date(ms);
  const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  return `${d.getUTCDate()} ${months[d.getUTCMonth()]} ${d.getUTCFullYear()}, ${two(d.getUTCHours())}:${two(d.getUTCMinutes())} UTC`;
}

/** "08:00 UTC" — funding settlement stamps. */
export function fmtUtcHmz(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return MISSING;
  return `${fmtUtcHm(ms)} UTC`;
}

/** UTC calendar day key, YYYY-MM-DD, matching the data/market recorder's file naming. */
export function utcDateKey(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${two(d.getUTCMonth() + 1)}-${two(d.getUTCDate())}`;
}
