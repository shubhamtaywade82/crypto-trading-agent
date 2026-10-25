import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { MarketState } from '../../src/market/types.js';
import type { Candle } from '../../src/types.js';
import { blackScholes } from '../../src/options/blackScholes.js';
import { optionsConfigFromEnv, type OptionsConfig } from '../../src/options/config.js';
import type { RawOptionSymbol } from '../../src/options/contract.js';
import type { OptionsMarketSource } from '../../src/options/OptionChainService.js';
import type { OptionRight } from '../../src/options/types.js';
import { StaleContextError, type UnderlyingContext, type UnderlyingContextSource } from '../../src/options/UnderlyingContext.js';

/** 2026-10-25 04:41 UTC; BTC-261030-* expire 2026-10-30 08:00 UTC, 123.3 h later. */
export const T0 = Date.UTC(2026, 9, 25, 4, 41);
export const EXPIRY = Date.UTC(2026, 9, 30, 8);
export const SPOT = 80_000;
export const IV = 0.5;

export function rawSymbol(symbol: string, overrides: Partial<RawOptionSymbol> = {}): RawOptionSymbol {
  const parts = symbol.split('-');
  return {
    symbol,
    underlying: `${parts[0]}USDT`,
    strikePrice: Number(parts[2]),
    expiryDate: EXPIRY,
    unit: 1,
    status: 'TRADING',
    filters: [
      { filterType: 'PRICE_FILTER', tickSize: '5', minPrice: '5', maxPrice: '100000' },
      { filterType: 'LOT_SIZE', minQty: '0.01', stepSize: '0.01', maxQty: '1000' },
    ],
    ...overrides,
  };
}

export const modelPrice = (right: OptionRight, strike: number, now: number, spot = SPOT, vol = IV): number =>
  blackScholes({ right, spot, strike, timeToExpiryMs: EXPIRY - now, vol, rate: 0 })!.price;

export interface BookSpec {
  bids: Array<[number, number]>;
  asks: Array<[number, number]>;
}

/**
 * An in-memory Binance Options (eapi) market. Marks default to the Black-Scholes price at IV so the model-consistency
 * screen passes; books default to a 30-USDT-wide market around the mark with plenty of size.
 */
export class FakeOptionsMarket implements OptionsMarketSource {
  symbols: RawOptionSymbol[] = [rawSymbol('BTC-261030-80000-C'), rawSymbol('BTC-261030-80000-P'), rawSymbol('BTC-261030-95000-C')];
  spot = SPOT;
  indexTime: number | null = null;
  markOverrides = new Map<string, number>();
  ivOverrides = new Map<string, number | null>();
  books = new Map<string, BookSpec>();
  /** Books consumed one per depth call before falling back to `books`, e.g. to thin the book between selection and order. */
  nextBooks = new Map<string, BookSpec[]>();
  failDepth = false;
  depthCalls: string[] = [];

  constructor(private readonly clock: () => number) {}

  async exchangeInfo() {
    return { optionSymbols: this.symbols };
  }

  async index(underlying?: string) {
    return [{ underlying: underlying ?? 'BTCUSDT', indexPrice: this.spot, time: this.indexTime ?? this.clock() }];
  }

  markOf(symbol: string): number {
    const raw = this.symbols.find((s) => s.symbol === symbol)!;
    const right: OptionRight = symbol.endsWith('-C') ? 'CE' : 'PE';
    return this.markOverrides.get(symbol) ?? modelPrice(right, raw.strikePrice, this.clock(), this.spot);
  }

  async mark(symbol?: string) {
    const rows = this.symbols.filter((s) => !symbol || s.symbol === symbol);
    return rows.map((s) => {
      const iv = this.ivOverrides.has(s.symbol) ? this.ivOverrides.get(s.symbol) : IV;
      return { symbol: s.symbol, markPrice: this.markOf(s.symbol), markIV: iv === null ? undefined : String(iv), riskFreeInterest: '0' };
    });
  }

  async depth(symbol: string) {
    this.depthCalls.push(symbol);
    if (this.failDepth) throw new Error('eapi depth timeout');
    const mark = this.markOf(symbol);
    const book = this.nextBooks.get(symbol)?.shift() ?? this.books.get(symbol) ?? { bids: [[mark - 15, 10]], asks: [[mark + 15, 10]] };
    const fmt = (levels: Array<[number, number]>) => levels.map(([p, q]) => [String(p), String(q)] as const);
    return { bids: fmt(book.bids), asks: fmt(book.asks) };
  }
}

export type Trend = 'BULL' | 'BEAR' | 'FLAT';

/** Hourly closes alternating +/-0.48% log return: about 45% annualised realized volatility. */
export function hourlyCandles(count = 60, start = SPOT): Candle[] {
  const r = 0.0048;
  const out: Candle[] = [];
  let close = start;
  for (let i = 0; i < count; i += 1) {
    close = close * Math.exp(i % 2 === 0 ? r : -r);
    out.push({ openTime: T0 - (count - i) * 3_600_000, open: close, high: close * 1.001, low: close * 0.999, close, volume: 100 });
  }
  return out;
}

export function marketState(trend: Trend, overrides: { rsi?: number; adx?: number; atr1h?: number } = {}): MarketState {
  const regime = trend === 'BULL' ? 'TREND_UP' : trend === 'BEAR' ? 'TREND_DOWN' : 'RANGE';
  const htf = trend === 'BULL' ? 'BULLISH' : trend === 'BEAR' ? 'BEARISH' : 'NEUTRAL';
  const ema20 = trend === 'BEAR' ? 79_500 : 80_200;
  const ema50 = trend === 'BEAR' ? 80_100 : 79_800;
  const tf = (atr: number) => ({
    candleCount: 300, lastClose: SPOT, ema20, ema50, ema200: 79_000, emaSlopePct: 0.1, adx14: overrides.adx ?? 28, atr14: atr,
    atrPercentile: 50, rsi14: overrides.rsi ?? (trend === 'BEAR' ? 42 : 58), vwap: SPOT, bollingerMiddle: SPOT, bollingerUpper: SPOT * 1.01, bollingerLower: SPOT * 0.99,
  });
  return {
    version: 1,
    symbol: 'BTCUSDT',
    generatedAt: T0,
    mark: SPOT,
    fundingRate: 0,
    regime: { regime, trendDirection: htf, trendStrength: 0.7, volatility: 'MEDIUM', volatilityPercentile: 50, adx14: overrides.adx ?? 28, emaSlopePct: 0.1 },
    timeframes: { '15m': { timeframe: '15m', ...tf(250) }, '1h': { timeframe: '1h', ...tf(overrides.atr1h ?? 600) }, '4h': { timeframe: '4h', ...tf(1_200) } },
    htfStructure: { timeframe: '1h', trend: htf, swingHighs: [], swingLows: [], lastBreak: null, protectedHigh: null, protectedLow: null },
    ltfStructure: { timeframe: '15m', trend: htf, swingHighs: [], swingLows: [], lastBreak: null, protectedHigh: null, protectedLow: null },
  } as unknown as MarketState;
}

export class FakeContext implements UnderlyingContextSource {
  trend: Trend = 'BULL';
  overrides: { rsi?: number; adx?: number; atr1h?: number } = {};
  stale = false;

  async context(underlying: string): Promise<UnderlyingContext> {
    if (this.stale) throw new StaleContextError(`${underlying}: newest closed 15m candle closed 45 min ago`);
    return { marketState: marketState(this.trend, this.overrides), candles1h: hourlyCandles(), lastClosedAt: T0 };
  }
}

export function testConfig(env: Record<string, string> = {}): OptionsConfig {
  const dir = mkdtempSync(path.join(tmpdir(), 'options-test-'));
  return optionsConfigFromEnv({
    OPTIONS_UNDERLYINGS: 'BTCUSDT',
    OPTIONS_STATE_PATH: path.join(dir, 'state.json'),
    OPTIONS_JOURNAL_PATH: path.join(dir, 'journal.jsonl'),
    ...env,
  });
}
