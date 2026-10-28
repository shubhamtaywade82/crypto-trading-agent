import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BriefMarketData } from '../src/brief/types.js';
import { splitKlines, collectBriefMarketData, DEFAULT_BRIEF_COLLECTION_OPTIONS } from '../src/brief/MarketBriefData.js';
import { buildMarketBrief, buildSnapshotComparisons, DEFAULT_BRIEF_BUILD_OPTIONS } from '../src/brief/MarketBriefBuilder.js';
import { renderBriefMarkdown } from '../src/brief/render.js';
import type { MinuteRecord } from '../src/marketdata/MinuteAggregator.js';

/**
 * Fixture: the SOLUSDT snapshot of 28 October 2026, 04:24 UTC — last 101.72, 24h range
 * 99.11–102.41, sell-dominant 5m/15m taker flow, declining OI, 2.98:1 long-crowded accounts and
 * price testing support under a bullish 1h/4h recovery. Every number mirrors a real Binance
 * response shape (strings in klines and derivatives endpoints).
 */
const NOW = Date.UTC(2026, 9, 28, 4, 24);
const T = (h: number, m = 0, day = 28): number => Date.UTC(2026, 9, day, h, m);
const MIN = 60_000;

/** [open, high, low, close] per candle. */
type Spec = [number, number, number, number];

const C5: Spec[] = [
  [101.60, 101.68, 101.55, 101.66], [101.66, 101.75, 101.60, 101.72], [101.72, 101.85, 101.70, 101.82],
  [101.82, 101.95, 101.78, 101.92], [101.92, 102.05, 101.88, 102.02], [102.02, 102.15, 101.98, 102.12],
  [102.12, 102.25, 102.08, 102.19], [102.19, 102.41, 102.15, 102.30], [102.30, 102.38, 102.10, 102.15],
  [102.15, 102.20, 101.98, 102.02], [102.02, 102.08, 101.85, 101.90], [101.90, 101.95, 101.74, 101.78],
];
const F5: Spec = [101.78, 101.80, 101.68, 101.72];

const C15: Spec[] = [
  [100.85, 101.08, 100.80, 101.05], [101.05, 101.10, 101.00, 100.98], [100.98, 101.25, 100.97, 101.20],
  [101.20, 101.28, 100.96, 101.10], [101.10, 101.35, 101.02, 101.30], [101.30, 101.38, 101.12, 101.18],
  [101.18, 101.50, 101.14, 101.45], [101.52, 101.60, 101.50, 101.55], [101.55, 101.68, 101.48, 101.62],
  [101.62, 101.72, 101.46, 101.58], [101.58, 102.41, 101.50, 102.19], [102.19, 102.29, 101.90, 101.95],
  [101.95, 102.07, 101.52, 101.79],
];
const F15: Spec = [101.79, 101.82, 101.68, 101.72];

const C1H: Spec[] = [
  [100.10, 100.30, 100.10, 100.25], [100.25, 100.45, 100.12, 100.40], [100.40, 100.50, 100.05, 100.20],
  [100.20, 100.55, 100.15, 100.50], [100.50, 100.85, 100.45, 100.80], [100.80, 101.10, 100.75, 101.05],
  [101.05, 101.70, 100.98, 101.63], [101.63, 102.41, 101.52, 101.99],
];
const F1H: Spec = [101.99, 102.05, 101.68, 101.72];

const C4H: Spec[] = [
  [102.40, 102.55, 102.30, 102.45], [102.45, 102.65, 102.35, 102.60], [102.60, 102.73, 102.40, 102.55],
  [102.55, 102.60, 102.20, 102.30], [102.30, 102.35, 101.90, 102.00], [102.00, 102.10, 101.60, 101.70],
  [101.70, 101.80, 101.20, 101.30], [101.30, 101.45, 100.90, 101.05], [101.05, 101.20, 100.55, 100.70],
  [100.70, 100.90, 100.35, 100.55], [100.55, 100.75, 100.30, 100.70], [100.70, 102.41, 100.65, 101.99],
];
const F4H: Spec = [101.99, 102.05, 101.68, 101.72];

function rawKlines(candles: Spec[], firstOpen: number, intervalMs: number, forming?: Spec): any[][] {
  const rows = candles.map((c, i) => {
    const openTime = firstOpen + i * intervalMs;
    return [String(openTime), String(c[0]), String(c[1]), String(c[2]), String(c[3]), '100'];
  });
  if (forming) {
    const openTime = firstOpen + candles.length * intervalMs;
    rows.push([String(openTime), String(forming[0]), String(forming[1]), String(forming[2]), String(forming[3]), '40']);
  }
  return rows;
}

interface FixtureOverrides {
  c15?: Spec[];
  f15?: Spec;
  ticker?: Record<string, any> | null;
  rejectTopTrader?: boolean;
}

function fakeClient(overrides: FixtureOverrides = {}) {
  const c15 = overrides.c15 ?? C15;
  const f15 = overrides.f15 ?? F15;
  return {
    async getKlines({ interval }: { interval: string }) {
      const rows: Record<string, any[][]> = {
        '5m': rawKlines(C5, T(3, 20), 5 * MIN, F5),
        '15m': rawKlines(c15, T(1, 0), 15 * MIN, f15),
        '1h': rawKlines(C1H, T(20, 0, 27), 60 * MIN, F1H),
        '4h': rawKlines(C4H, T(4, 0, 26), 4 * 60 * MIN, F4H),
      };
      return rows[interval] ?? [];
    },
    async get24hrChangeStatistics() {
      if (overrides.ticker === null) throw new Error('ticker unavailable');
      return overrides.ticker ?? {
        symbol: 'SOLUSDT', lastPrice: '101.72', priceChangePercent: '1.588', priceChange: '1.59',
        highPrice: '102.41', lowPrice: '99.11', volume: '10460000', quoteVolume: '1053000000',
      };
    },
    async getMarkPrice() {
      return {
        symbol: 'SOLUSDT', markPrice: '101.7113', indexPrice: '101.7506',
        lastFundingRate: '0.0001', nextFundingTime: String(T(8, 0)),
      };
    },
    async getOpenInterest() {
      return { symbol: 'SOLUSDT', openInterest: '9034000', time: String(NOW) };
    },
    async getOpenInterestStatistics() {
      return [
        { symbol: 'SOLUSDT', sumOpenInterest: '9086500', timestamp: String(T(2, 0)) },
        { symbol: 'SOLUSDT', sumOpenInterest: '9050000', timestamp: String(T(3, 0)) },
        { symbol: 'SOLUSDT', sumOpenInterest: '9038000', timestamp: String(T(4, 0)) },
      ];
    },
    async getGlobalLongShortAccountRatio() {
      return [{ symbol: 'SOLUSDT', longShortRatio: '2.98', longAccount: '0.7488', shortAccount: '0.2512', timestamp: String(T(4, 0)) }];
    },
    async getTopTradersLongShortPositionRatio() {
      if (overrides.rejectTopTrader) throw new Error('top trader ratio unavailable');
      return [{ symbol: 'SOLUSDT', longShortRatio: '2.51', timestamp: String(T(4, 0)) }];
    },
    async getTakerBuySellVolume({ period }: { period: string }) {
      const buckets: Record<string, any[]> = {
        '5m': [{ buySellRatio: '0.8472', buyVol: '15490', sellVol: '18290', timestamp: String(T(4, 15)) }],
        '15m': [{ buySellRatio: '0.4669', buyVol: '30270', sellVol: '64840', timestamp: String(T(3, 45)) }],
        '1h': [{ buySellRatio: '1.1514', buyVol: '245040', sellVol: '212810', timestamp: String(T(3, 0)) }],
      };
      return buckets[period] ?? [];
    },
    async getOrderBook() {
      return {
        lastUpdateId: 1,
        bids: [['101.72', '12'], ['101.68', '5'], ['101.56', '300']],
        asks: [['101.73', '10'], ['101.89', '250']],
      };
    },
  };
}

function record(overrides: Partial<MinuteRecord> & { t: number }): MinuteRecord {
  return {
    symbol: 'SOLUSDT', trades: 10, buyQty: 1, sellQty: 1, buyQuote: 100, sellQuote: 100,
    liqLongQty: 0, liqShortQty: 0, liqCount: 0, spreadBps: null, bookImbalance: null, bookSamples: 0,
    mark: null, index: null, funding: null, openInterest: null, takerRatio: null,
    ...overrides,
  };
}

const HISTORY: MinuteRecord[] = [
  record({ t: T(23, 59, 21), mark: 108.60, index: 108.61, funding: 0.0001, openInterest: 9500000, takerRatio: 1.05 }),
  record({ t: T(23, 59, 21) + 30_000, mark: 108.75, index: 108.76, funding: 0.0001, openInterest: 9500000, takerRatio: 1.05 }),
  record({ t: T(23, 59, 25), mark: 101.495, index: 101.50 }),
];

async function collect(overrides: FixtureOverrides = {}): Promise<BriefMarketData> {
  return collectBriefMarketData('SOLUSDT', fakeClient(overrides) as any, DEFAULT_BRIEF_COLLECTION_OPTIONS, NOW);
}

test('splitKlines separates confirmed candles from the forming candle', () => {
  const intervalMs = 5 * MIN;
  const raw = [
    [String(NOW - 3 * intervalMs), '100', '101', '99', '100.5', '10'],
    [String(NOW - 2 * intervalMs), '100.5', '102', '98', '101', '20'],
    [String(NOW - 30_000), '101', '102', '100', '101.72', '5'], // still open at NOW
  ];
  const split = splitKlines(raw, '5m', NOW);
  assert.equal(split.confirmed.length, 2);
  assert.equal(split.confirmed[1]!.close, 101);
  assert.ok(split.forming);
  assert.equal(split.forming!.last, 101.72);
  assert.equal(split.forming!.low, 100);
});

test('collectBriefMarketData parses every endpoint and degrades failures to null', async () => {
  const data = await collect({ rejectTopTrader: true });

  assert.equal(data.ticker?.lastPrice, 101.72);
  assert.equal(data.ticker?.changePct, 1.588);
  assert.equal(data.ticker?.volumeQuote, 1053000000);
  assert.equal(data.mark?.markPrice, 101.7113);
  assert.equal(data.mark?.indexPrice, 101.7506);
  assert.equal(data.mark?.fundingRate, 0.0001);
  assert.equal(data.mark?.nextFundingTime, T(8, 0));

  assert.equal(data.candles['5m']?.confirmed.length, 12);
  assert.equal(data.candles['5m']?.forming?.last, 101.72);
  assert.equal(data.candles['15m']?.confirmed.length, 13);
  assert.equal(data.candles['1h']?.confirmed.length, 8);
  assert.equal(data.candles['4h']?.confirmed.length, 12);

  assert.equal(data.openInterest, 9034000);
  assert.deepEqual(data.oiHistory, [
    { sumOpenInterest: 9086500, timestamp: T(2, 0) },
    { sumOpenInterest: 9050000, timestamp: T(3, 0) },
    { sumOpenInterest: 9038000, timestamp: T(4, 0) },
  ]);
  // The exchange reports account shares as decimals; the brief speaks in percent.
  assert.equal(data.globalRatio?.ratio, 2.98);
  assert.ok(Math.abs((data.globalRatio?.longPct ?? 0) - 74.88) < 1e-9);
  assert.ok(Math.abs((data.globalRatio?.shortPct ?? 0) - 25.12) < 1e-9);
  assert.equal(data.topTraderPositionRatio, null);
  assert.ok(data.errors.some((e) => e.startsWith('top trader position ratio')));

  assert.equal(data.taker['5m'].ratio, 0.8472);
  assert.equal(data.taker['5m'].dominance, 'SELL');
  assert.equal(data.taker['15m'].dominance, 'SELL');
  assert.equal(data.taker['1h'].dominance, 'BUY');

  assert.equal(data.book.bestBid, 101.72);
  assert.equal(data.book.bestAsk, 101.73);
  assert.equal(data.book.largestBidLevel?.price, 101.56);
  assert.equal(data.book.largestBidLevel?.notional, 101.56 * 300);
  assert.equal(data.book.largestAskLevel?.price, 101.89);
});

test('buildMarketBrief reproduces the SOL no-trade brief', async () => {
  const brief = buildMarketBrief(await collect({ rejectTopTrader: true }), {
    history: HISTORY,
    compareDates: ['2026-10-25', '2026-10-21'],
    now: NOW,
  });

  assert.equal(brief.symbol, 'SOLUSDT');
  assert.equal(brief.generatedAt, NOW);
  assert.equal(brief.decision, 'NO_TRADE');
  assert.equal(brief.decisionHeadline, 'NO TRADE — wait for confirmation');

  // Structure: confirmed closes only, forming candles reported separately.
  assert.equal(brief.timeframes['5m'].trend, 'DOWN');
  assert.equal(brief.timeframes['15m'].trend, 'FLAT');
  assert.equal(brief.timeframes['1h'].trend, 'UP');
  assert.equal(brief.timeframes['4h'].trend, 'UP');
  assert.equal(brief.timeframes['15m'].confirmed?.close, 101.79);
  assert.equal(brief.timeframes['15m'].forming?.last, 101.72);
  assert.equal(brief.timeframes['15m'].formingVsConfirmedClose, 'BELOW');
  assert.equal(brief.timeframes['1h'].confirmed?.open, 101.63);
  assert.equal(brief.timeframes['1h'].confirmed?.high, 102.41);

  // Zones: 15m swing lows 101.46/100.96 under price, 24h high 102.41 and 4h 102.73 above.
  const immediate = brief.zones.find((z) => z.role === 'IMMEDIATE_SUPPORT')!;
  assert.equal(immediate.low, 101.46);
  const next = brief.zones.find((z) => z.role === 'NEXT_SUPPORT')!;
  assert.equal(next.low, 100.96);
  const reclaim = brief.zones.find((z) => z.role === 'RECLAIM_ZONE')!;
  assert.equal(reclaim.high, 102.41);
  const nearTerm = brief.zones.find((z) => z.role === 'NEAR_TERM_RESISTANCE')!;
  assert.equal(nearTerm.low, 102.73);
  const major = brief.zones.find((z) => z.role === 'MAJOR_REFERENCE')!;
  assert.equal(major.low, 99.11);
  assert.deepEqual(brief.noEntryZone, { low: 101.46, high: 102.41 });

  // Positioning.
  assert.equal(brief.positioning.fundingRate, 0.0001);
  assert.equal(brief.positioning.fundingAprPct, 0.0001 * 3 * 365 * 100);
  assert.equal(brief.positioning.openInterest, 9034000);
  assert.equal(brief.positioning.openInterestNotionalUsd, 9034000 * 101.72);
  assert.equal(brief.positioning.oiTrend.changePct !== null ? +brief.positioning.oiTrend.changePct.toFixed(3) : 0, -0.534);
  assert.ok(Math.abs((brief.positioning.globalLongPct ?? 0) - 74.88) < 1e-9);
  assert.equal(brief.positioning.topTraderPositionLongShortRatio, null);

  // The four evidence-based NO_TRADE reasons of the snapshot.
  const reasons = brief.noTradeReasons.join(' | ');
  assert.match(reasons, /inside the no-entry zone between support \(101\.46\) and the reclaim zone \(102\.41\)/);
  assert.match(reasons, /sell-dominant \(5m 0\.8472, 15m 0\.4669\)/);
  assert.match(reasons, /open interest has declined 0\.53%/);
  assert.match(reasons, /long-crowded at 2\.98 long accounts per short \(74\.88% long\)/);

  // Scenarios reference the mapped levels.
  assert.equal(brief.scenarios.bullish.confirmationLevel, 102.41);
  assert.match(brief.scenarios.bullish.steps[0]!, /102\.41/);
  assert.equal(brief.scenarios.bearish.confirmationLevel, 101.46);
  assert.match(brief.scenarios.bearish.steps[0]!, /below 101\.46/);

  // Recorded-snapshot comparisons.
  assert.equal(brief.history.length, 2);
  assert.equal(brief.history[0]!.date, '2026-10-25');
  assert.equal(brief.history[0]!.recordedMark, 101.495);
  assert.equal(brief.history[0]!.currentVsRecordedPct !== null ? +brief.history[0]!.currentVsRecordedPct!.toFixed(3) : 0, 0.222);
  assert.equal(brief.history[0]!.recordedOpenInterest, null);
  assert.equal(brief.history[1]!.date, '2026-10-21');
  assert.equal(brief.history[1]!.recordedMark, 108.75);
  assert.equal(brief.history[1]!.currentVsRecordedPct !== null ? +brief.history[1]!.currentVsRecordedPct!.toFixed(3) : 0, -6.464);
  assert.equal(brief.history[1]!.oiChangePct !== null ? +brief.history[1]!.oiChangePct!.toFixed(3) : 0, -4.905);

  assert.match(brief.bottomLine, /NO TRADE\. Wait for a confirmed reclaim above 102\.41 or a confirmed breakdown below 101\.46/);
});

test('a deeper 15m pullback adds the conflicting-timeframes reason', async () => {
  const c15 = [...C15];
  c15[11] = [102.19, 102.29, 101.52, 101.60]; // 03:45 closes weaker
  c15[12] = [101.60, 101.68, 101.48, 101.50]; // 04:00 closes weaker still, above 101.46
  const brief = buildMarketBrief(await collect({ c15, f15: [101.50, 101.75, 101.45, 101.72] }), { now: NOW });

  assert.equal(brief.timeframes['15m'].trend, 'DOWN');
  assert.equal(brief.decision, 'NO_TRADE');
  assert.match(brief.noTradeReasons.join(' | '), /bullish 1h\/4h structure conflicts with the bearish 5m\/15m pressure/);
  assert.match(brief.summary[0]!, /pulling back from the \$102\.41 high/);
});

test('a confirmed 15m close above the reclaim zone flips the call to LONG_BIAS', async () => {
  const c15 = [...C15];
  c15[12] = [102.20, 102.55, 102.10, 102.50]; // confirmed close above the zone
  const ticker = { symbol: 'SOLUSDT', lastPrice: '102.45', priceChangePercent: '2.6', priceChange: '2.6', highPrice: '102.45', lowPrice: '99.11', volume: '10460000', quoteVolume: '1060000000' };
  const brief = buildMarketBrief(await collect({ c15, f15: [102.50, 102.58, 102.30, 102.45], ticker }), { now: NOW });

  assert.equal(brief.decision, 'LONG_BIAS');
  assert.equal(brief.noTradeReasons.length, 0);
  assert.match(brief.decisionHeadline, /LONG BIAS — reclaim confirmed above 102\.45/);
});

test('a confirmed 15m close below the nearest floor flips the call to SHORT_BIAS', async () => {
  const c15 = [...C15];
  c15[12] = [100.60, 100.70, 100.00, 100.02]; // confirmed close below the 100.05 floor
  const ticker = { symbol: 'SOLUSDT', lastPrice: '100.10', priceChangePercent: '-0.5', priceChange: '-0.5', highPrice: '102.41', lowPrice: '99.11', volume: '10460000', quoteVolume: '1050000000' };
  const brief = buildMarketBrief(await collect({ c15, f15: [100.02, 100.25, 99.95, 100.10], ticker }), { now: NOW });

  assert.equal(brief.decision, 'SHORT_BIAS');
  assert.match(brief.decisionHeadline, /SHORT BIAS — breakdown confirmed below 100\.05/);
});

test('buildSnapshotComparisons uses the last record of each requested day and skips missing days', () => {
  const comparisons = buildSnapshotComparisons(HISTORY, 101.72, 9034000, ['2026-10-25', '2026-10-22'], NOW);
  assert.equal(comparisons.length, 1);
  assert.equal(comparisons[0]!.date, '2026-10-25');
  assert.equal(comparisons[0]!.recordedMark, 101.495); // last record of the day, not the first
});

test('buildSnapshotComparisons defaults to the two most recent recorded days before today', () => {
  const comparisons = buildSnapshotComparisons(HISTORY, 101.72, 9034000, undefined, NOW);
  assert.deepEqual(comparisons.map((c) => c.date), ['2026-10-21', '2026-10-25']);
});

test('renderBriefMarkdown lays out every section of the brief', async () => {
  const brief = buildMarketBrief(await collect({ rejectTopTrader: true }), {
    ...DEFAULT_BRIEF_BUILD_OPTIONS,
    history: HISTORY,
    compareDates: ['2026-10-25', '2026-10-21'],
    now: NOW,
  });
  const md = renderBriefMarkdown(brief);

  assert.match(md, /# SOLUSDT USDⓈ-M Futures — Live Market Brief/);
  assert.match(md, /Snapshot: 28 October 2026, 04:24 UTC/);
  assert.match(md, /Executive decision: NO TRADE — wait for confirmation/);
  for (const section of [
    '## 1. Price and 24-hour statistics',
    '## 2. Multi-timeframe structure',
    '## 3. Derivatives, positioning and order flow',
    '## 4. Key support and resistance',
    '## 5. Conditional scenarios',
    '## 6. Explicit NO-TRADE condition',
    '## 7. Change versus recent recorded context',
    '## Bottom line',
  ]) {
    assert.ok(md.includes(section), `missing section: ${section}`);
  }

  // Price stats and candle labels (an open-time label names the candle that opened then).
  assert.match(md, /\$101\.72/);
  assert.match(md, /\+1\.588% \(\+\$1\.59\)/);
  assert.match(md, /10\.46M SOL/);
  assert.match(md, /~\$1\.05B USDT/);
  assert.match(md, /04:15 close: \$101\.78/);
  assert.match(md, /04:00 close: \$101\.79/);
  assert.match(md, /03:00 close: \$101\.99/);
  assert.match(md, /00:00 close: \$101\.99/);

  // Derivatives rows, including the unavailable top-trader ratio.
  assert.match(md, /\+0\.0100%/);
  assert.match(md, /74\.88% long accounts vs 25\.12% short/);
  assert.match(md, /not available in the retrieved data/);
  assert.match(md, /0\.8472/);
  assert.match(md, /bucket 04:15–04:20 UTC/);
  assert.match(md, /bucket 03:45–04:00 UTC/);
  assert.match(md, /bucket 03:00–04:00 UTC/);
  assert.match(md, /9\.09M at 02:00 → 9\.04M at 04:00 \(-0\.53%\)/);

  // Zones and book concentrations.
  assert.match(md, /\$101\.46 \| Immediate support/);
  assert.match(md, /\$102\.41 \| Reclaim zone/);
  assert.match(md, /\$102\.73 \| Major near-term resistance/);
  assert.match(md, /\$99\.11 \| Major reference/);
  assert.match(md, /bid liquidity near \$101\.56 and ask liquidity near \$101\.89/);

  // Stand-aside conditions and recorded-snapshot comparisons.
  assert.match(md, /- 5m\/15m selling persists while the 1h\/4h structure remains bullish;/);
  assert.match(md, /2026-10-25/);
  assert.match(md, /\+0\.22%/);
  assert.match(md, /2026-10-21/);
  assert.match(md, /-6\.46%/);
  assert.match(md, /did not contain a verified synchronized funding and taker-flow baseline/);

  // Data availability note for the rejected endpoint.
  assert.match(md, /Data availability: 1 endpoint\(s\) failed/);
});

test('a brief with no usable price stays NO_TRADE and says why', async () => {
  const data = await collect({ ticker: null });
  // Simulate mark failing too: rebuild the raw data with mark cleared.
  const blinded: BriefMarketData = { ...data, mark: null, ticker: null };
  const brief = buildMarketBrief(blinded, { now: NOW });
  // Price falls back to the forming 5m candle, so the brief still works...
  assert.equal(brief.price.lastPrice, 101.72);

  const blindedFurther: BriefMarketData = {
    ...blinded,
    candles: {}, // ...and with no candles at all there is no price reading left
  };
  const blind = buildMarketBrief(blindedFurther, { now: NOW });
  assert.equal(blind.price.lastPrice, null);
  assert.equal(blind.decision, 'NO_TRADE');
  assert.match(blind.noTradeReasons.join(' | '), /no usable price reading is available/);
  assert.equal(blind.zones.length, 0);
  const md = renderBriefMarkdown(blind);
  assert.match(md, /No complete zone map could be derived/);
  assert.match(md, /No recorded snapshots were found/);
});
