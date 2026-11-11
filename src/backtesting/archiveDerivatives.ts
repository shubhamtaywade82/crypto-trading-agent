import { mirrorFirstFetch, readFirstZipEntry, type FetchLike } from './archiveKlines.js';

/**
 * Funding and positioning history from Binance's public archive (data.binance.vision, read through the local mirror).
 * The REST endpoints for open-interest and long/short history only serve 30 days; these files go back years.
 */
const BASE = 'https://data.binance.vision/data/futures/um';
const DAY_MS = 86_400_000;

export interface FundingPoint { time: number; rate: number }

/**
 * One 5-minute snapshot. `time` is the archive's create_time; treat a value as usable only after it, never before.
 * Ratio fields are Binance's: top-trader account and position long/short ratios, all-account ratio, taker buy/sell volume ratio.
 */
export interface MetricsPoint {
  time: number;
  openInterest: number;
  openInterestValue: number;
  topTraderAccountRatio: number;
  topTraderPositionRatio: number;
  globalAccountRatio: number;
  takerBuySellRatio: number;
}

export interface SeriesResult<T> { points: T[]; missing: string[] }

const isoDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

async function zipText(url: string, fetchImpl: FetchLike): Promise<string | null> {
  const response = await fetchImpl(url, { signal: AbortSignal.timeout(20_000) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
  return readFirstZipEntry(Buffer.from(await response.arrayBuffer()));
}

export function parseFundingCsv(text: string): FundingPoint[] {
  const out: FundingPoint[] = [];
  for (const line of text.split('\n')) {
    const [calcTime, , rate] = line.trim().split(',');
    const point = { time: Number(calcTime), rate: Number(rate) };
    if (Number.isFinite(point.time) && Number.isFinite(point.rate) && rate !== undefined && rate !== '') out.push(point);
  }
  return out;
}

export function parseMetricsCsv(text: string): MetricsPoint[] {
  const out: MetricsPoint[] = [];
  for (const line of text.split('\n')) {
    const c = line.trim().split(',');
    if (c.length < 8) continue;
    const time = Date.parse(`${c[0]!.replace(' ', 'T')}Z`);
    const cells = c.slice(2, 8);
    const values = cells.map(Number);
    if (!Number.isFinite(time) || cells.some((v) => v === '') || values.some((v) => !Number.isFinite(v))) continue; // header, or a blank field Binance left in
    const [openInterest, openInterestValue, topTraderAccountRatio, topTraderPositionRatio, globalAccountRatio, takerBuySellRatio] = values as [number, number, number, number, number, number];
    out.push({ time, openInterest, openInterestValue, topTraderAccountRatio, topTraderPositionRatio, globalAccountRatio, takerBuySellRatio });
  }
  return out;
}

/** Settled funding in [fromMs, toMs). Monthly files only exist for finished months; unpublished months are listed in `missing`. */
export async function loadFunding(symbol: string, fromMs: number, toMs: number, fetchImpl: FetchLike = mirrorFirstFetch): Promise<SeriesResult<FundingPoint>> {
  const points: FundingPoint[] = [];
  const missing: string[] = [];
  for (let d = new Date(Date.UTC(new Date(fromMs).getUTCFullYear(), new Date(fromMs).getUTCMonth(), 1)); d.getTime() < toMs; d.setUTCMonth(d.getUTCMonth() + 1)) {
    const month = isoDay(d.getTime()).slice(0, 7);
    const text = await zipText(`${BASE}/monthly/fundingRate/${symbol}/${symbol}-fundingRate-${month}.zip`, fetchImpl);
    if (text === null) { missing.push(month); continue; }
    points.push(...parseFundingCsv(text).filter((p) => p.time >= fromMs && p.time < toMs));
  }
  return { points: points.sort((a, b) => a.time - b.time), missing };
}

/** 5-minute positioning snapshots in [fromMs, toMs), from daily files. Days without a file are listed in `missing`; gaps inside a day are left as gaps. */
export async function loadMetrics(symbol: string, fromMs: number, toMs: number, fetchImpl: FetchLike = mirrorFirstFetch): Promise<SeriesResult<MetricsPoint>> {
  const points: MetricsPoint[] = [];
  const missing: string[] = [];
  for (let day = Math.floor(fromMs / DAY_MS) * DAY_MS; day < toMs; day += DAY_MS) {
    const text = await zipText(`${BASE}/daily/metrics/${symbol}/${symbol}-metrics-${isoDay(day)}.zip`, fetchImpl);
    if (text === null) { missing.push(isoDay(day)); continue; }
    points.push(...parseMetricsCsv(text).filter((p) => p.time >= fromMs && p.time < toMs));
  }
  return { points: points.sort((a, b) => a.time - b.time), missing };
}
