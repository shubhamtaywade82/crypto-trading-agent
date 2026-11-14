/** Loads the archive mirror (daily klines, settled funding, optional Sunday positioning and spot klines) into a `Panel`. */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseFundingCsv, parseMetricsCsv } from '../backtesting/archiveDerivatives.js';
import { readFirstZipEntry } from '../backtesting/archiveKlines.js';
import { DAY_MS, type FundingSeries, type Panel, type SymbolDays } from './CrossSection.js';

const ROOT = path.resolve('data/cache/vision/monthly');
const EXCLUDED = /^(BTCDOM|DEFI|FOOTBALL|BLUEBIRD|USDC)/;
export interface Range { start: number; end: number }

function readKlineZip(file: string, start: number, panelDays: number, data: SymbolDays): void {
  for (const line of readFirstZipEntry(readFileSync(file)).split('\n')) {
    const c = line.trim().split(',').map(Number);
    const day = Math.round((c[0]! - start) / DAY_MS);
    if (c.length < 8 || !Number.isFinite(c[0]!) || day < 0 || day >= panelDays) continue;
    data.open[day] = c[1]!; data.close[day] = c[4]!; data.quoteVolume[day] = c[7]!;
  }
}

function loadSymbol(symbol: string, range: Range, panelDays: number): { days: SymbolDays; funding: FundingSeries } | null {
  const klineDir = path.join(ROOT, 'klines', symbol, '1d');
  if (!existsSync(klineDir)) return null;
  const days: SymbolDays = { open: new Float64Array(panelDays).fill(NaN), close: new Float64Array(panelDays).fill(NaN), quoteVolume: new Float64Array(panelDays).fill(NaN) };
  const inRange = (file: string): boolean => { const t = Date.parse(`${file.match(/(\d{4}-\d{2})\.zip$/)?.[1]}-01T00:00:00Z`); return t >= range.start && t < range.end; };
  for (const f of readdirSync(klineDir).filter(inRange)) readKlineZip(path.join(klineDir, f), range.start, panelDays, days);
  const funding: FundingSeries = { time: [], cum: [] };
  const fundingDir = path.join(ROOT, 'fundingRate', symbol);
  const points = existsSync(fundingDir) ? readdirSync(fundingDir).filter(inRange).sort().flatMap((f) => parseFundingCsv(readFirstZipEntry(readFileSync(path.join(fundingDir, f))))) : [];
  let total = 0;
  for (const p of points.sort((a, b) => a.time - b.time)) { total += p.rate; funding.time.push(p.time); funding.cum.push(total); }
  return { days, funding };
}

const SNAPSHOT_CUTOFF_MS = DAY_MS - 10 * 60_000; // 23:50 UTC: a 5m row stamped t is usable from t + 5m, before the Monday open

/** Sunday end-of-day positioning for the signals that read it; days without a file stay NaN. */
function loadSundayMetrics(panel: Panel): void {
  panel.metrics = panel.symbols.map((symbol) => {
    const topPosition = new Float64Array(panel.days).fill(NaN);
    const openInterestValue = new Float64Array(panel.days).fill(NaN);
    for (let t = Date.UTC(2021, 11, 26); t <= Date.UTC(2024, 11, 29); t += 7 * DAY_MS) {
      const file = path.resolve(`data/cache/vision/daily/metrics/${symbol}/${symbol}-metrics-${new Date(t).toISOString().slice(0, 10)}.zip`);
      if (!existsSync(file)) continue;
      const usable = parseMetricsCsv(readFirstZipEntry(readFileSync(file))).filter((p) => p.time <= t + SNAPSHOT_CUTOFF_MS);
      const last = usable[usable.length - 1];
      if (!last) continue;
      const day = (t - panel.start) / DAY_MS;
      topPosition[day] = last.topTraderPositionRatio; openInterestValue[day] = last.openInterestValue;
    }
    return { topPosition, openInterestValue };
  });
}

/** Spot daily opens/closes for each perp that has a spot market (leading `1000` stripped); other contracts stay NaN. */
function loadSpot(panel: Panel): void {
  panel.spot = panel.symbols.map((symbol) => {
    const open = new Float64Array(panel.days).fill(NaN);
    const close = new Float64Array(panel.days).fill(NaN);
    const dir = path.resolve(`data/cache/vision-spot/monthly/klines/${symbol.replace(/^1000+/, '')}/1d`);
    for (const file of existsSync(dir) ? readdirSync(dir) : []) {
      for (const line of readFirstZipEntry(readFileSync(path.join(dir, file))).split('\n')) {
        const c = line.trim().split(',').map(Number);
        const openTime = c[0]! > 1e14 ? c[0]! / 1000 : c[0]!; // spot archives switched to microseconds in 2025
        const day = Math.round((openTime - panel.start) / DAY_MS);
        if (c.length >= 6 && day >= 0 && day < panel.days) { open[day] = c[1]!; close[day] = c[4]!; }
      }
    }
    return { open, close };
  });
}

export function loadPanel(range: Range, withMetrics: boolean, withSpot: boolean): Panel {
  const panelDays = (range.end - range.start) / DAY_MS;
  const symbols = readdirSync(path.join(ROOT, 'klines')).filter((s) => s.endsWith('USDT') && !EXCLUDED.test(s)).sort();
  const panel: Panel = { start: range.start, days: panelDays, symbols: [], data: [], funding: [] };
  for (const symbol of symbols) {
    const loaded = loadSymbol(symbol, range, panelDays);
    if (!loaded) continue;
    panel.symbols.push(symbol); panel.data.push(loaded.days); panel.funding.push(loaded.funding);
  }
  if (withMetrics) loadSundayMetrics(panel);
  if (withSpot) loadSpot(panel);
  return panel;
}

