/**
 * Forward shadow test of the listing short (docs/NEMESIS_G4_STRATEGY_SPECS.md §28). Run once a day; it places no orders.
 *
 *   npx tsx scripts/shadow-listings.ts
 *
 * Public endpoints only (exchangeInfo, 1d klines, fundingRate); about 3 calls per tracked listing, spaced out so the
 * request weight stays far below Binance's limits.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { bootstrapMean } from '../src/research/Bootstrap.js';

const BASE = 'https://fapi.binance.com/fapi/v1';
const DAY_MS = 86_400_000;
const ENTRY_DELAY_DAYS = 3;
const HOLD_DAYS = 21;
const STOP_FRACTION = 0.3;
const ROUND_TRIP_COST = 0.0024; // 6 bps per side on both legs
const CALL_SPACING_MS = 300;
const REGISTERED_AT = Date.UTC(2026, 10, 14);
const STATE_FILE = 'data/shadow/listings-state.json';
const JOURNAL_FILE = 'data/shadow/listings.jsonl';

interface Tracked { symbol: string; listingDay: number; entry?: { time: number; price: number; btcPrice: number }; closed?: boolean }
type State = Record<string, Tracked>;
type Kline = { openTime: number; open: number; high: number; low: number; close: number };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const dayStart = (ms: number): number => Math.floor(ms / DAY_MS) * DAY_MS;

async function get(path: string): Promise<unknown> {
  await sleep(CALL_SPACING_MS);
  const response = await fetch(`${BASE}${path}`, { signal: AbortSignal.timeout(20_000) });
  if (response.status === 429 || response.status === 418) throw new Error(`rate limited (${response.status}) on ${path}: stop and retry later`);
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}

async function dailyKlines(symbol: string, from: number, limit: number): Promise<Kline[]> {
  const rows = (await get(`/klines?symbol=${symbol}&interval=1d&startTime=${from}&limit=${limit}`)) as string[][];
  return rows.map((r) => ({ openTime: Number(r[0]), open: Number(r[1]), high: Number(r[2]), low: Number(r[3]), close: Number(r[4]) }));
}

async function fundingBetween(symbol: string, from: number, to: number): Promise<number> {
  const rows = (await get(`/fundingRate?symbol=${symbol}&startTime=${from + 1}&endTime=${to}&limit=1000`)) as { fundingRate: string }[];
  return rows.reduce((sum, r) => sum + Number(r.fundingRate), 0);
}

async function discoverListings(state: State, today: number): Promise<void> {
  const info = (await get('/exchangeInfo')) as { symbols: { symbol: string; contractType: string; quoteAsset: string; status: string; onboardDate: number }[] };
  for (const s of info.symbols) {
    const listingDay = dayStart(s.onboardDate);
    const isRecent = today - listingDay <= (ENTRY_DELAY_DAYS + HOLD_DAYS + 5) * DAY_MS;
    if (s.contractType === 'PERPETUAL' && s.quoteAsset === 'USDT' && isRecent && !state[s.symbol]) state[s.symbol] = { symbol: s.symbol, listingDay };
  }
}

/** First daily bar from the entry day on whose high reaches the stop; the fill is the stop, or the open when it gapped past it. */
function stopFill(bars: Kline[], entry: number): { time: number; price: number } | null {
  const stop = entry * (1 + STOP_FRACTION);
  const hit = bars.find((b) => b.high >= stop);
  return hit ? { time: hit.openTime, price: Math.max(stop, hit.open) } : null;
}

async function settle(t: Tracked, exitTime: number, exitPrice: number, reason: string): Promise<void> {
  const entry = t.entry!;
  const [alt, btc] = [exitPrice / entry.price - 1, (await dailyKlines('BTCUSDT', exitTime, 1))[0]!.open / entry.btcPrice - 1];
  const funding = (await fundingBetween(t.symbol, entry.time, exitTime)) - (await fundingBetween('BTCUSDT', entry.time, exitTime));
  const net = -alt + btc + funding - ROUND_TRIP_COST;
  const row = { symbol: t.symbol, listingDay: new Date(t.listingDay).toISOString().slice(0, 10), entryTime: entry.time, exitTime, reason, altReturn: alt, btcReturn: btc, funding, net, retrospective: entry.time < REGISTERED_AT };
  appendFileSync(JOURNAL_FILE, `${JSON.stringify(row)}\n`);
  t.closed = true;
  console.log(`closed ${t.symbol}: ${reason}, alt ${(alt * 100).toFixed(1)}%, net ${(net * 100).toFixed(1)}%${row.retrospective ? ' (retrospective)' : ''}`);
}

async function advance(t: Tracked, today: number): Promise<void> {
  const entryDay = t.listingDay + ENTRY_DELAY_DAYS * DAY_MS;
  const exitDay = entryDay + HOLD_DAYS * DAY_MS;
  if (!t.entry && today >= entryDay) {
    const bar = (await dailyKlines(t.symbol, entryDay, 1))[0];
    const btc = (await dailyKlines('BTCUSDT', entryDay, 1))[0];
    if (bar && btc && bar.openTime === entryDay) t.entry = { time: entryDay, price: bar.open, btcPrice: btc.open };
  }
  if (!t.entry || t.closed) return;
  const bars = await dailyKlines(t.symbol, entryDay, HOLD_DAYS + 1);
  const stopped = stopFill(bars.filter((b) => b.openTime < exitDay && b.openTime <= today), t.entry.price);
  if (stopped) return settle(t, stopped.time, stopped.price, 'STOP');
  const exitBar = bars.find((b) => b.openTime === exitDay);
  if (exitBar && today >= exitDay) return settle(t, exitDay, exitBar.open, 'TIME');
}

function summary(): string {
  if (!existsSync(JOURNAL_FILE)) return 'no closed events yet';
  const rows = readFileSync(JOURNAL_FILE, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as { net: number; exitTime: number; retrospective: boolean });
  const forward = rows.filter((r) => !r.retrospective);
  const boot = bootstrapMean(forward.map((r) => ({ value: r.net, cluster: new Date(r.exitTime).toISOString().slice(0, 7) })), { confidence: 0.8, seed: 7 });
  const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / Math.max(1, xs.length);
  return `forward events ${forward.length}/100, mean net ${(mean(forward.map((r) => r.net)) * 100).toFixed(2)}%, 90% LCB ${boot ? (boot.ciLow * 100).toFixed(2) : 'n/a'}%; retrospective ${rows.length - forward.length}`;
}

async function main(): Promise<void> {
  mkdirSync('data/shadow', { recursive: true });
  const state: State = existsSync(STATE_FILE) ? (JSON.parse(readFileSync(STATE_FILE, 'utf8')) as State) : {};
  const today = dayStart(Date.now());
  await discoverListings(state, today);
  for (const t of Object.values(state).filter((x) => !x.closed)) {
    try { await advance(t, today); } catch (error) { console.log(`skip ${t.symbol}: ${(error as Error).message}`); if ((error as Error).message.startsWith('rate limited')) break; }
  }
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 1));
  console.log(`tracking ${Object.values(state).filter((x) => !x.closed).length}; ${summary()}`);
}

await main();
