import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MicrostructureFeed } from '../src/microstructure/MicrostructureFeed.js';
import { OrderBookDepthSource } from '../src/market/OrderBookDepthSource.js';
import { DEFAULT_MICRO_OPTIONS, type MicrostructureReading } from '../src/microstructure/MicrostructureEngine.js';
import { fuseSignals } from '../src/decision/SignalFusion.js';
import { runCandidateFlow, decisionEvidence } from '../src/decision/CandidateFlow.js';
import type { Signal } from '../src/types.js';
import type { MarketState } from '../src/market/types.js';

function mockSignal(overrides: Partial<Signal> = {}): Signal {
  return {
    id: 'sig-1',
    agent: 'STRUCT-LIQ-η',
    symbol: 'BTCUSDT',
    type: 'OPEN_LONG',
    confidence: 0.8,
    entry: 50000,
    stopLoss: 49500,
    takeProfit: 51500,
    reason: 'test signal',
    ts: 1000,
    ...overrides,
  };
}

function mockState(symbol = 'BTCUSDT'): MarketState {
  const baseTf = {
    timeframe: '15m' as const, candleCount: 100, lastClose: 50000,
    ema20: 50000, ema50: 50000, ema200: 50000, emaSlopePct: 0.1,
    adx14: 30, atr14: 200, atrPercentile: 50, rsi14: 55, vwap: 50000,
    bollingerMiddle: 50000, bollingerUpper: 51000, bollingerLower: 49000,
  };
  return {
    version: 1, symbol, generatedAt: 1000, mark: 50000, fundingRate: 0.0001,
    regime: { regime: 'TREND_UP', trendDirection: 'BULLISH', trendStrength: 0.8, volatility: 'MEDIUM', volatilityPercentile: 50, adx14: 30, emaSlopePct: 0.1 },
    timeframes: { '15m': baseTf, '1h': { ...baseTf, timeframe: '1h' }, '4h': { ...baseTf, timeframe: '4h' } },
    htfStructure: { timeframe: '1h', trend: 'BULLISH', swingHighs: [], swingLows: [], lastBreak: null, protectedHigh: null, protectedLow: null },
    ltfStructure: { timeframe: '15m', trend: 'BULLISH', swingHighs: [], swingLows: [], lastBreak: null, protectedHigh: null, protectedLow: null },
    liquidity: { htf: { timeframe: '1h', pools: [], latestSweeps: [], recentSweeps: [] }, ltf: { timeframe: '15m', pools: [], latestSweeps: [], recentSweeps: [] } },
    zones: [],
    pricing: { high: 52000, low: 48000, equilibrium: 50000, positionPct: 40, premium: false, discount: true },
    meanReversion: { mean: 50000, vwap: 50000, zscore: 0, rsi14: 55, bollingerMiddle: 50000, bollingerUpper: 51000, bollingerLower: 49000, deviationPct: 0 },
    crowding: { fundingPercentile: 50, topTraderVsGlobalBias: 1, positioningExtreme: 'BALANCED', takerAggressionRatio: 1, openInterestExpansion: false },
  };
}

function mockMicroReading(overrides: Partial<MicrostructureReading> = {}): MicrostructureReading {
  return {
    symbol: 'BTCUSDT',
    t: 1000,
    book: { status: 'LIVE', reason: '', ageMs: 50 },
    mid: 50000,
    spreadBps: 2.0,
    depthImbalance: { bps10: 0.35, bps25: 0.30 },
    flow: { delta5s: 10, delta30s: 50, buyNotional30s: 100, sellNotional30s: 50, trades30s: 20, cvd: 50 },
    windows: [],
    priceResponseBps30s: 1.5,
    phase: 'INITIATIVE_BUYING',
    friction: { status: 'OK', spreadBps: 2.0, buySlipBps: 1.5, sellSlipBps: 1.5, orderNotional: 5000, reasons: [] },
    events: [],
    evidence: 'SUPPORTS_LONG',
    evidenceReasons: [],
    bias: { bias: 'LONG', since: 1000, candidate: null, reasons: ['buying_dominance'] },
    ...overrides,
  };
}

test('MicrostructureFeed exposes OrderBookDepthSource wired to its local order books', () => {
  const feed = new MicrostructureFeed(['BTCUSDT'], {
    source: { subscribe: async () => ({ on: () => {}, close: () => {} }), depthSnapshot: async () => ({ lastUpdateId: 1, bids: [], asks: [] }) },
    config: { enabled: true, entryGate: 'on', sampleMs: 1000, record: false, recordDir: 'data', tickRecord: false, tickRecordDir: 'data', options: DEFAULT_MICRO_OPTIONS },
    log: () => {},
  });
  assert.ok(feed.depthSource instanceof OrderBookDepthSource);

  // Load snapshot and diff directly into the engine's book
  const engine = feed.engine('BTCUSDT')!;
  engine.onSnapshot({ lastUpdateId: 100, bids: [{ price: 50000, qty: 10 }], asks: [{ price: 50001, qty: 5 }] });
  engine.onDepth({ U: 99, u: 101, pu: 98, E: 1000, b: [['50000', '10']], a: [['50001', '5']] }, 1000);

  const metrics = feed.depthSource.depth('BTCUSDT', 20, 1000);
  assert.ok(metrics !== null);
  assert.ok((metrics.imbalance ?? 0) > 0);
  assert.ok((metrics.spreadBps ?? 0) > 0);
});

test('SignalFusion scores incorporate live order book imbalance, bias and absorption', () => {
  const signal = mockSignal({ agent: 'STRUCT-LIQ-η', type: 'OPEN_LONG' });
  const state = mockState('BTCUSDT');

  // Neutral baseline without microstructure
  const baseline = fuseSignals([signal], { BTCUSDT: state });
  assert.equal(baseline.length, 1);
  const baselineScore = baseline[0].evidenceScore;

  // Fused with supportive microstructure (imbalance + bias + absorption + exhaustion)
  const supportiveMicro = mockMicroReading({
    depthImbalance: { bps10: 0.40, bps25: 0.35 },
    bias: { bias: 'LONG', since: 1000, candidate: null, reasons: ['test'] },
    events: [{ t: 1000, kind: 'ABSORPTION', side: 'bid', price: 49990, peakQty: 50, executedQty: 45, lifetimeMs: 2000 }],
    liquidations: { longNotional1m: 100000, shortNotional1m: 0, longNotional5m: 100000, shortNotional5m: 0, exhaustion: 'LONG_EXHAUSTION', recentCount: 5 },
  });
  const boosted = fuseSignals([signal], { BTCUSDT: state }, { BTCUSDT: supportiveMicro });
  assert.equal(boosted.length, 1);
  assert.ok(boosted[0].evidenceScore > baselineScore);
  assert.ok(boosted[0].reasons.some((r) => r.includes('orderbook_imbalance')));
  assert.ok(boosted[0].reasons.some((r) => r.includes('micro_bias_aligned')));
  assert.ok(boosted[0].reasons.some((r) => r.includes('wall_absorption')));
  assert.ok(boosted[0].reasons.some((r) => r.includes('liquidation_exhaustion')));

  // Fused with opposing microstructure bias
  const opposingMicro = mockMicroReading({
    depthImbalance: { bps10: -0.50, bps25: -0.45 },
    bias: { bias: 'SHORT', since: 1000, candidate: null, reasons: ['test'] },
    events: [],
  });
  const penalized = fuseSignals([signal], { BTCUSDT: state }, { BTCUSDT: opposingMicro });
  assert.ok(penalized.length === 0 || penalized[0].evidenceScore < baselineScore);
});

test('runCandidateFlow and decisionEvidence forward microstructure through the pipeline', () => {
  const signal = mockSignal({ agent: 'STRUCT-LIQ-η', type: 'OPEN_LONG' });
  const state = mockState('BTCUSDT');
  const micro = mockMicroReading();

  const flow = runCandidateFlow([signal], { BTCUSDT: state }, { BTCUSDT: micro });
  assert.equal(flow.signals.length, 1);
  const intent = flow.intents.get('BTCUSDT:STRUCT-LIQ-η');
  assert.ok(intent !== undefined);

  const evidence = decisionEvidence(signal, state, intent, micro);
  assert.equal(evidence.score, intent.evidenceScore);
  assert.ok(evidence.factors.length > 0);
});
