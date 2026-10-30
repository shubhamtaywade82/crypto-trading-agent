import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  STALE_MARKET_STATE_MS,
  buildDecisionSnapshot,
  snapshotJsonLength,
  snapshotWithinBudget,
} from '../src/decision-intelligence/snapshots/decisionSnapshotBuilder.js';
import { SNAPSHOT_JSON_BUDGET } from '../src/decision-intelligence/types.js';
import type { MarketState } from '../src/market/types.js';
import type { Signal } from '../src/types.js';

const NOW = Date.UTC(2026, 9, 28, 4, 24, 0);

/** A representative SOLUSDT MarketState: bullish HTF, bearish LTF, mixed flow — the shapes the model must judge. */
function state(overrides: Partial<MarketState> = {}): MarketState {
  return {
    version: 1,
    symbol: 'SOLUSDT',
    generatedAt: NOW - 20 * 60_000,
    mark: 101.72,
    fundingRate: 0.0001,
    regime: { regime: 'TREND_UP', trendDirection: 'BULLISH', trendStrength: 0.62, volatility: 'MEDIUM', volatilityPercentile: 0.55, adx14: 27.5, emaSlopePct: 0.31 },
    timeframes: {
      '15m': { timeframe: '15m', candleCount: 200, lastClose: 101.78, ema20: 101.6, ema50: 101.4, ema200: 100.9, emaSlopePct: 0.05, adx14: 21.2, atr14: 0.34, atrPercentile: 0.5, rsi14: 47.8, vwap: 101.55, bollingerMiddle: 101.5, bollingerUpper: 102.1, bollingerLower: 100.9, volumeZ: -0.4 },
      '1h': { timeframe: '1h', candleCount: 200, lastClose: 101.99, ema20: 101.8, ema50: 101.5, ema200: 100.8, emaSlopePct: 0.12, adx14: 28.9, atr14: 0.61, atrPercentile: 0.6, rsi14: 55.1, vwap: 101.7, bollingerMiddle: 101.7, bollingerUpper: 102.6, bollingerLower: 100.8, volumeZ: 0.2 },
      '4h': { timeframe: '4h', candleCount: 150, lastClose: 101.99, ema20: 101.2, ema50: 100.6, ema200: 99.4, emaSlopePct: 0.2, adx14: 31.4, atr14: 1.12, atrPercentile: 0.7, rsi14: 58.3, vwap: 100.9, bollingerMiddle: 100.8, bollingerUpper: 102.9, bollingerLower: 98.7, volumeZ: 0.5 },
    },
    htfStructure: { timeframe: '4h', trend: 'BULLISH', swingHighs: [], swingLows: [], lastBreak: { type: 'BOS', direction: 'BULLISH', level: 101.2, index: 140, time: NOW - 26 * 3600_000, distanceAtr: 1.4, protectedLevel: 99.1 }, protectedHigh: null, protectedLow: null },
    ltfStructure: { timeframe: '15m', trend: 'BEARISH', swingHighs: [], swingLows: [], lastBreak: { type: 'CHOCH', direction: 'BEARISH', level: 101.9, index: 190, time: NOW - 40 * 60_000, distanceAtr: 0.8, protectedLevel: 102.41 }, protectedHigh: null, protectedLow: null },
    liquidity: { htf: { timeframe: '4h', pools: [], latestSweeps: [], recentSweeps: [] }, ltf: { timeframe: '15m', pools: [], latestSweeps: [], recentSweeps: [] } },
    zones: [],
    pricing: { high: 102.41, low: 99.11, equilibrium: 100.76, positionPct: 79.1, premium: true, discount: false },
    meanReversion: { mean: 101.4, vwap: 101.55, zscore: 0.4, rsi14: 47.8, bollingerMiddle: 101.5, bollingerUpper: 102.1, bollingerLower: 100.9, deviationPct: 0.3 },
    derivatives: {
      asOf: NOW - 30_000,
      openInterest: 9_034_000,
      openInterestChangePct: -0.0053,
      globalLongShortRatio: 2.98,
      topTraderAccountLongShortRatio: 1.42,
      topTraderPositionLongShortRatio: 1.8,
      takerBuySellRatio: 0.8472,
      takerVolumeImbalance: -0.08,
      orderBookImbalance: -0.12,
      spreadBps: 0.9,
      basisPct: 0.004,
    },
    crowding: { fundingPercentile: 0.62, topTraderVsGlobalBias: -0.4, positioningExtreme: 'LONG_CROWDED', takerAggressionRatio: 0.84, openInterestExpansion: false },
    ...overrides,
  } as MarketState;
}

function signal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    agent: 'STRUCTURE-TREND-η',
    symbol: 'SOLUSDT',
    type: 'OPEN_LONG',
    confidence: 0.72,
    entry: 101.72,
    stopLoss: 100.96,
    takeProfit: 103.4,
    reason: '4h bullish BOS with 1h continuation; entry on 15m reclaim retest',
    ts: NOW,
    ...overrides,
  };
}

const evidence = { breakdown: null, score: 68, factors: ['4h trend bullish', '15m CHOCH bearish conflicts', 'flow: taker sell-dominant on 5m'] };

// ─── What goes into the snapshot ───

test('carries the candidate geometry, side and strategy with the computed risk/reward', () => {
  const snapshot = buildDecisionSnapshot({ signal: signal(), state: state(), evidence, now: NOW })!;
  assert.equal(snapshot.symbol, 'SOLUSDT');
  assert.equal(snapshot.venue, 'BINANCE_USDM');
  assert.equal(snapshot.decisionTimeframe, '15m');
  assert.equal(snapshot.setup.side, 'LONG');
  assert.equal(snapshot.setup.strategy, 'STRUCTURE-TREND-η');
  assert.equal(snapshot.setup.entry, 101.72);
  assert.equal(snapshot.setup.stopLoss, 100.96);
  assert.equal(snapshot.setup.takeProfit, 103.4);
  // (103.4 - 101.72) / (101.72 - 100.96) = 2.21
  assert.equal(snapshot.setup.riskReward, 2.21);
  assert.equal(snapshot.setup.evidenceScore, 68);
});

test('maps higher-timeframe structure facts compactly, trend plus latest break per timeframe', () => {
  const snapshot = buildDecisionSnapshot({ signal: signal(), state: state(), evidence, now: NOW })!;
  assert.equal(snapshot.higherTimeframes['4h']!.trend, 'BULLISH');
  assert.equal(snapshot.higherTimeframes['4h']!.structure, 'BOS_BULLISH@101.2');
  assert.equal(snapshot.higherTimeframes['15m']!.trend, 'BEARISH');
  assert.equal(snapshot.higherTimeframes['15m']!.structure, 'CHOCH_BEARISH@101.9');
  assert.equal(snapshot.higherTimeframes['1h']!.trend, 'NEUTRAL'); // no 1h structure state falls back to NEUTRAL
  assert.equal(snapshot.higherTimeframes['1h']!.structure, 'NO_BREAK');
});

test('carries regime, funding and range position, with funding converted to percent', () => {
  const snapshot = buildDecisionSnapshot({ signal: signal(), state: state(), evidence, now: NOW })!;
  assert.equal(snapshot.market.regime, 'TREND_UP');
  assert.equal(snapshot.market.trendDirection, 'BULLISH');
  assert.equal(snapshot.market.fundingRatePct, 0.01); // 0.0001 -> 0.01%
  assert.equal(snapshot.market.rangePositionPct, 79.1);
});

test('carries order-flow facts and flags exactly the features the venue feed did not provide', () => {
  const snapshot = buildDecisionSnapshot({ signal: signal(), state: state(), evidence, now: NOW })!;
  assert.equal(snapshot.orderFlow.takerBuySellRatio, 0.8472);
  assert.equal(snapshot.orderFlow.openInterestChangePct, -0.53);
  assert.deepEqual(snapshot.dataQuality.missingFeatures, []);

  const sparse = state({ derivatives: null, crowding: null });
  const sparseSnapshot = buildDecisionSnapshot({ signal: signal(), state: sparse, evidence, now: NOW })!;
  assert.ok(sparseSnapshot.dataQuality.missingFeatures.includes('takerBuySellRatio'));
  assert.ok(sparseSnapshot.dataQuality.missingFeatures.includes('crowding'));
  for (const value of Object.values(sparseSnapshot.orderFlow)) assert.equal(value, null);
});

// ─── Honesty about data quality ───

test('reports state age and staleness against the 45-minute budget a 15m-closed state implies', () => {
  const fresh = buildDecisionSnapshot({ signal: signal(), state: state(), evidence, now: NOW })!;
  assert.equal(fresh.dataQuality.marketStateAgeMs, 20 * 60_000);
  assert.equal(fresh.dataQuality.stale, false);
  assert.equal(fresh.dataQuality.closedCandlesOnly, true);

  const stale = buildDecisionSnapshot({ signal: signal(), state: state({ generatedAt: NOW - STALE_MARKET_STATE_MS - 1 }), evidence, now: NOW })!;
  assert.equal(stale.dataQuality.stale, true);
});

test('a missing MarketState is declared, not invented: unknown regime, no timeframes, market_state in missingFeatures', () => {
  const snapshot = buildDecisionSnapshot({ signal: signal(), state: undefined, evidence, now: NOW })!;
  assert.equal(snapshot.dataQuality.marketStatePresent, false);
  assert.deepEqual(snapshot.higherTimeframes, {});
  assert.equal(snapshot.market.regime, 'UNKNOWN');
  assert.ok(snapshot.dataQuality.missingFeatures.includes('market_state'));
  assert.ok(snapshot.dataQuality.missingFeatures.includes('crowding'));
});

// ─── Candidates that cannot be judged ───

test('returns null for a candidate without complete entry/stop/target geometry', () => {
  assert.equal(buildDecisionSnapshot({ signal: signal({ stopLoss: undefined }), state: state(), evidence, now: NOW }), null);
  assert.equal(buildDecisionSnapshot({ signal: signal({ entry: undefined }), state: state(), evidence, now: NOW }), null);
  assert.equal(buildDecisionSnapshot({ signal: signal({ takeProfit: undefined }), state: state(), evidence, now: NOW }), null);
});

test('returns null when stop and entry coincide (no risk to validate)', () => {
  assert.equal(buildDecisionSnapshot({ signal: signal({ stopLoss: 101.72 }), state: state(), evidence, now: NOW }), null);
});

test('shorts keep their geometry: side SHORT and distances measured the same way', () => {
  const snapshot = buildDecisionSnapshot({
    signal: signal({ type: 'OPEN_SHORT', entry: 101.72, stopLoss: 102.41, takeProfit: 100.56 }),
    state: state(),
    evidence,
    now: NOW,
  })!;
  assert.equal(snapshot.setup.side, 'SHORT');
  assert.equal(snapshot.setup.riskReward, 1.68); // (101.72-100.56)/(102.41-101.72)
});

// ─── Token budget ───

test('a fully populated snapshot serializes well inside the ~2,000-token budget', () => {
  const snapshot = buildDecisionSnapshot({ signal: signal(), state: state(), evidence, now: NOW })!;
  const length = snapshotJsonLength(snapshot);
  assert.ok(snapshotWithinBudget(snapshot), `snapshot is ${length} chars, budget ${SNAPSHOT_JSON_BUDGET}`);
  assert.ok(length < 2200, `a compact snapshot should be small, got ${length} chars`);
});

test('evidence reasons are capped to three and truncated, keeping the payload bounded', () => {
  const verbose = { breakdown: null, score: 68, factors: [`${'long reason '.repeat(30)}#1`, 'reason #2', 'reason #3', 'reason #4'] };
  const snapshot = buildDecisionSnapshot({ signal: signal(), state: state(), evidence: verbose, now: NOW })!;
  assert.equal(snapshot.setup.evidenceReasons.length, 3);
  assert.ok(snapshot.setup.evidenceReasons.every((reason) => reason.length <= 96));
});
