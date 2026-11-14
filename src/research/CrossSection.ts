/**
 * Weekly dollar-neutral rank portfolios across USDⓈ-M perps (docs/NEMESIS_G4_STRATEGY_SPECS.md §13).
 * Signals read daily bars closed before the Monday entry; fills are at Monday's daily open; costs only on traded notional.
 */
export const DAY_MS = 86_400_000;
export const HOLD_DAYS = 7;
const UNIVERSE_SIZE = 30;
const MIN_ELIGIBLE = 15;
const MIN_HISTORY_DAYS = 90;
const MIN_QUOTE_VOLUME = 10_000_000;
const VOLUME_WINDOW = 30;
export const SIDE_COST_RATE = 0.0006; // 4 bps taker + 2 bps slippage (§3)

/** One array entry per UTC day since `Panel.start`; days without a bar are NaN. */
export interface SymbolDays { open: Float64Array; close: Float64Array; quoteVolume: Float64Array }
/** Settlements sorted by time; `cum[i]` is the sum of rates 0..i. */
export interface FundingSeries { time: number[]; cum: number[] }
export interface Panel { start: number; days: number; symbols: string[]; data: SymbolDays[]; funding: FundingSeries[] }

export type SignalId = 'X1' | 'X2' | 'X3' | 'X4' | 'X5' | 'X6';
export const SIGNALS: readonly SignalId[] = ['X1', 'X2', 'X3', 'X4', 'X5', 'X6'];

export interface WeekUniverse { day: number; time: number; symbols: number[]; ret: number[]; funding: number[] }
export interface WeekResult { time: number; gross: number; funding: number; cost: number; marketReturn: number; contributions: Map<number, number> }

/** Sum of funding rates with `from < time <= to` (a position held through (from, to]). */
export function fundingSum(f: FundingSeries, from: number, to: number): number {
  return cumulativeAt(f, to) - cumulativeAt(f, from);
}

function cumulativeAt(f: FundingSeries, t: number): number {
  let lo = 0;
  let hi = f.time.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (f.time[mid]! <= t) lo = mid + 1; else hi = mid;
  }
  return lo === 0 ? 0 : f.cum[lo - 1]!;
}

function mean30Volume(d: SymbolDays, m: number): number {
  let sum = 0;
  let count = 0;
  for (let k = m - VOLUME_WINDOW; k < m; k += 1) if (Number.isFinite(d.quoteVolume[k]!)) { sum += d.quoteVolume[k]!; count += 1; }
  return count >= 25 ? sum / count : NaN;
}

/** Point-in-time universe on day index `m`: enough history, liquid, top `size` by 30-day quote volume. */
export function universeAt(panel: Panel, m: number, size = UNIVERSE_SIZE): number[] {
  const ranked: { s: number; volume: number }[] = [];
  panel.data.forEach((d, s) => {
    const hasHistory = Number.isFinite(d.close[m - MIN_HISTORY_DAYS]!) && Number.isFinite(d.open[m]!);
    const volume = hasHistory ? mean30Volume(d, m) : NaN;
    if (volume >= MIN_QUOTE_VOLUME) ranked.push({ s, volume });
  });
  return ranked.sort((a, b) => b.volume - a.volume).slice(0, size).map((x) => x.s);
}

/** Last finite close in days [m, m + hold): where a symbol that stopped trading mid-hold is exited. */
function exitPrice(d: SymbolDays, m: number, hold = HOLD_DAYS): number {
  if (Number.isFinite(d.open[m + hold]!)) return d.open[m + hold]!;
  for (let k = m + hold - 1; k >= m; k -= 1) if (Number.isFinite(d.close[k]!)) return d.close[k]!;
  return NaN;
}

/** Realised open-to-open return and funding for every universe member, independent of any signal. */
export function buildWeeks(panel: Panel, firstMonday: number, lastMonday: number): WeekUniverse[] {
  const weeks: WeekUniverse[] = [];
  for (let time = firstMonday; time <= lastMonday; time += HOLD_DAYS * DAY_MS) {
    const m = (time - panel.start) / DAY_MS;
    if (m + HOLD_DAYS >= panel.days) break;
    const symbols = universeAt(panel, m).filter((s) => Number.isFinite(exitPrice(panel.data[s]!, m)));
    if (symbols.length < MIN_ELIGIBLE) continue;
    const ret = symbols.map((s) => exitPrice(panel.data[s]!, m) / panel.data[s]!.open[m]! - 1);
    const funding = symbols.map((s) => fundingSum(panel.funding[s]!, time, time + HOLD_DAYS * DAY_MS));
    weeks.push({ day: m, time, symbols, ret, funding });
  }
  return weeks;
}

function dailyReturns(d: SymbolDays, from: number, to: number): number[] {
  const out: number[] = [];
  for (let k = from; k < to; k += 1) if (Number.isFinite(d.close[k]!) && Number.isFinite(d.close[k - 1]!)) out.push(d.close[k]! / d.close[k - 1]! - 1);
  return out;
}

function stdev(xs: readonly number[]): number {
  const m = xs.reduce((s, v) => s + v, 0) / xs.length;
  return Math.sqrt(xs.reduce((s, v) => s + (v - m) ** 2, 0) / (xs.length - 1));
}

/** Higher score = long side. NaN when the inputs are missing. */
export function score(panel: Panel, id: SignalId, s: number, m: number, time: number): number {
  const d = panel.data[s]!;
  const periodReturn = (days: number): number => d.close[m - 1]! / d.close[m - 1 - days]! - 1;
  if (id === 'X1') return periodReturn(14);
  if (id === 'X2') return periodReturn(28);
  if (id === 'X3') return -periodReturn(7);
  if (id === 'X4') return -fundingSum(panel.funding[s]!, time - HOLD_DAYS * DAY_MS - 1, time - 1);
  const returns = dailyReturns(d, m - 30, m);
  if (returns.length < 25) return NaN;
  return id === 'X5' ? -stdev(returns) : -Math.max(...returns);
}

export function scoreWeeks(panel: Panel, weeks: readonly WeekUniverse[], id: SignalId): number[][] {
  return weeks.map((w) => w.symbols.map((s) => score(panel, id, s, w.day, w.time)));
}

/** Indices of the top-q and bottom-q finite scores, or null when fewer than 2q are usable. */
function pickLongShort(scores: readonly number[], q: number): { longs: number[]; shorts: number[] } | null {
  const order = scores.map((_, i) => i).filter((i) => Number.isFinite(scores[i]!)).sort((a, b) => scores[b]! - scores[a]!);
  if (order.length < 2 * q) return null;
  return { longs: order.slice(0, q), shorts: order.slice(-q) };
}

function turnover(previous: ReadonlyMap<number, number>, next: ReadonlyMap<number, number>): number {
  let total = 0;
  for (const [s, w] of next) total += Math.abs(w - (previous.get(s) ?? 0));
  for (const [s, w] of previous) if (!next.has(s)) total += Math.abs(w);
  return total;
}

function targetWeights(week: WeekUniverse, picks: { longs: number[]; shorts: number[] }, q: number): Map<number, number> {
  const weights = new Map<number, number>();
  for (const i of picks.longs) weights.set(week.symbols[i]!, 1 / q);
  for (const i of picks.shorts) weights.set(week.symbols[i]!, -1 / q);
  return weights;
}

/** One return per usable week for a signal's long/short basket of `q` names per side; unit = one leg's notional. */
export function runPortfolio(weeks: readonly WeekUniverse[], scores: readonly number[][], q: number): WeekResult[] {
  const results: WeekResult[] = [];
  let previous = new Map<number, number>();
  weeks.forEach((week, i) => {
    const picks = pickLongShort(scores[i]!, q);
    if (!picks) return;
    const weights = targetWeights(week, picks, q);
    const contributions = new Map<number, number>();
    let gross = 0;
    let funding = 0;
    week.symbols.forEach((s, k) => {
      const w = weights.get(s) ?? 0;
      if (w === 0) return;
      gross += w * week.ret[k]!;
      funding -= w * week.funding[k]!;
      contributions.set(s, w * (week.ret[k]! - week.funding[k]!));
    });
    const marketReturn = week.ret.reduce((sum, v) => sum + v, 0) / week.ret.length;
    results.push({ time: week.time, gross, funding, cost: SIDE_COST_RATE * turnover(previous, weights), marketReturn, contributions });
    previous = weights;
  });
  return results;
}

export const netReturn = (w: WeekResult, costScale = 1): number => w.gross + w.funding - costScale * w.cost;

/** Mean cost-free weekly return of `n` random long/short baskets (same universe and q each week). */
export function randomBasketMeans(weeks: readonly WeekUniverse[], q: number, n: number, random: () => number): number[] {
  const means: number[] = [];
  for (let run = 0; run < n; run += 1) {
    let total = 0;
    for (const week of weeks) {
      const idx = week.symbols.map((_, i) => i);
      for (let i = 0; i < 2 * q; i += 1) {
        const j = i + Math.floor(random() * (idx.length - i));
        [idx[i], idx[j]] = [idx[j]!, idx[i]!];
      }
      const leg = (from: number): number => idx.slice(from, from + q).reduce((s, k) => s + week.ret[k]! - week.funding[k]!, 0) / q;
      total += leg(0) - leg(q);
    }
    means.push(total / weeks.length);
  }
  return means;
}

export interface ListingEvent { time: number; ret: number; funding: number; btcRet: number; btcFunding: number; peers: { ret: number[]; funding: number[] } }
export const LISTING_ROUND_TRIP_COST = 4 * SIDE_COST_RATE; // short leg and BTC hedge leg, in and out

/** Hedged short of each new listing: entry at the open of day L+delay, exit `hold` days later (§14). */
export function listingEvents(panel: Panel, btc: number, delay: number, hold: number, from: number, to: number): ListingEvent[] {
  const events: ListingEvent[] = [];
  panel.data.forEach((d, s) => {
    const listed = d.close.findIndex((v) => Number.isFinite(v));
    const m = listed + delay;
    const time = panel.start + m * DAY_MS;
    if (listed < 60 || time < from || time > to || m + hold >= panel.days || !Number.isFinite(d.open[m]!)) return;
    const move = (k: number): { ret: number; funding: number } => ({ ret: exitPrice(panel.data[k]!, m, hold) / panel.data[k]!.open[m]! - 1, funding: fundingSum(panel.funding[k]!, time, time + hold * DAY_MS) });
    const alt = move(s);
    if (!Number.isFinite(alt.ret)) return;
    const peers = universeAt(panel, m, Infinity).filter((k) => k !== s && Number.isFinite(move(k).ret)).map(move);
    events.push({ time, ret: alt.ret, funding: alt.funding, btcRet: move(btc).ret, btcFunding: move(btc).funding, peers: { ret: peers.map((p) => p.ret), funding: peers.map((p) => p.funding) } });
  });
  return events.sort((a, b) => a.time - b.time);
}

/** Excess return of shorting the listing against a BTC long. */
export const listingNet = (e: ListingEvent, costScale = 1): number => -e.ret + e.btcRet + e.funding - e.btcFunding - costScale * LISTING_ROUND_TRIP_COST;

/** Mean cost-free hedged return of shorting one random eligible peer per event instead of the listing. */
export function randomPeerMeans(events: readonly ListingEvent[], n: number, random: () => number): number[] {
  const usable = events.filter((e) => e.peers.ret.length > 0);
  return Array.from({ length: n }, () => {
    const total = usable.reduce((sum, e) => {
      const i = Math.floor(random() * e.peers.ret.length);
      return sum - e.peers.ret[i]! + e.btcRet + e.peers.funding[i]! - e.btcFunding;
    }, 0);
    return total / usable.length;
  });
}
