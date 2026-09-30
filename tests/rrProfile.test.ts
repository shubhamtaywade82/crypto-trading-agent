import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import { RiskAgent } from '../src/agents/RiskAgent.js';
import { config } from '../src/config.js';
import type { DecisionRecord } from '../src/decision/DecisionJournal.js';
import { classifyRiskRefusal, isStandingBlock } from '../src/decision/NoTrade.js';
import { PerformanceEngine } from '../src/risk/performanceEngine.js';
import { riskLimitsFromConfig } from '../src/risk/riskConfig.js';
import { calibrateRrFloors, costAdjustedRr, minRrFor, type RrProfile } from '../src/risk/rrProfile.js';
import { RefusalSuppressor } from '../src/runtime/refusalSuppressor.js';
import type { Candle, Position, Signal } from '../src/types.js';

const COSTS = { feeRate: 0.0004, slippageRate: 0.0002 };

test('cost-adjusted RR charges both legs against reward and adds them to risk', () => {
  // cost = 100 * 2 * 0.0006 = 0.12; reward 6 - 0.12; risk 2 + 0.12
  const rr = costAdjustedRr({ entry: 100, stopLoss: 98, takeProfit: 106, side: 'LONG' }, COSTS);
  assert.ok(Math.abs(rr - 5.88 / 2.12) < 1e-9);
  assert.ok(costAdjustedRr({ entry: 100, stopLoss: 98, takeProfit: 106, side: 'SHORT' }, COSTS) < 3);
});

test('a scalp with raw RR 1.05 can be cost-negative', () => {
  const rr = costAdjustedRr({ entry: 100, stopLoss: 99.9, takeProfit: 100.105, side: 'LONG' }, COSTS);
  assert.ok(rr < 0.05, `expected near-zero, got ${rr}`);
});

test('funding paid by the position lowers RR; funding received is not counted as edge', () => {
  const base = { entry: 100, stopLoss: 98, takeProfit: 106 };
  const flat = costAdjustedRr({ ...base, side: 'LONG' }, COSTS);
  assert.ok(costAdjustedRr({ ...base, side: 'LONG', fundingRate: 0.001, fundingIntervals: 3 }, COSTS) < flat);
  assert.equal(costAdjustedRr({ ...base, side: 'SHORT', fundingRate: 0.001, fundingIntervals: 3 }, COSTS), flat);
});

test('degenerate inputs yield NaN so the RR gate fails closed', () => {
  assert.ok(Number.isNaN(costAdjustedRr({ entry: 100, stopLoss: 100, takeProfit: 105, side: 'LONG' }, COSTS)));
});

const decision = (id: number, strategy: string, plannedRr: number, rMultiple: number): DecisionRecord => ({
  decisionId: String(id), timestamp: id, symbol: 'BTCUSDT', strategy: strategy as never, signalType: 'OPEN_LONG', side: 'LONG',
  signalId: String(id), confidence: 0.7, marketStateTime: null, marketStateVersion: null,
  evidence: { breakdown: null, score: 0, factors: [] }, entry: 100, stopLoss: 99, takeProfit: 100 + plannedRr,
  notionalUsdt: 1000, riskDecision: { approved: true, size: 1, leverage: 5, reason: '' }, status: 'EXECUTED', rejectionReason: null,
  outcome: { closedAt: id, exit: 100, qty: 1, pnl: 0, rMultiple, reason: 'TP' },
});

// deterministic noisy cohort: mean around `mean`, alternating +-spread
const cohort = (strategy: string, plannedRr: number, count: number, mean: number, spread: number, startId: number) =>
  Array.from({ length: count }, (_, i) => decision(startId + i, strategy, plannedRr, mean + (i % 2 === 0 ? spread : -spread)));

test('calibration picks the lowest floor whose cohort has enough samples and a positive lower bound', () => {
  const records = [
    ...cohort('A', 0.8, 40, -1.0, 0.3, 0),
    ...cohort('A', 1.6, 40, 0.5, 0.3, 100),
    ...cohort('A', 2.2, 40, 0.6, 0.3, 200),
  ];
  const { profile, verdicts } = calibrateRrFloors(records, { ...COSTS });
  // cohort >=0.5 and >=1.25 differ: the first includes losing 0.8-RR trades, so the floor must exclude them
  assert.equal(verdicts[0].status, 'CALIBRATED');
  assert.ok(profile.floors.A.minRr > 0.8 && profile.floors.A.minRr <= 1.6, `floor ${profile.floors.A.minRr}`);
  assert.ok(profile.floors.A.lcbNetR > 0);
});

test('a strategy that never beats costs is reported as NO_PROVEN_EDGE and gets no floor', () => {
  const { profile, verdicts } = calibrateRrFloors(cohort('B', 1.5, 60, -0.1, 0.5, 0), { ...COSTS });
  assert.equal(verdicts[0].status, 'NO_PROVEN_EDGE');
  assert.equal(profile.floors.B, undefined);
});

test('too few trades is INSUFFICIENT_DATA, not a floor', () => {
  const { verdicts } = calibrateRrFloors(cohort('C', 2, 10, 1, 0.1, 0), { ...COSTS });
  assert.equal(verdicts[0].status, 'INSUFFICIENT_DATA');
});

test('fees are deducted: a gross-positive strategy that costs eat is not calibrated', () => {
  // stop distance 1 on entry 100 => costR = 100 * 2 * 0.0006 / 1 = 0.12; gross mean 0.1 => net -0.02
  const { verdicts } = calibrateRrFloors(cohort('D', 2, 60, 0.1, 0.02, 0), { ...COSTS });
  assert.equal(verdicts[0].status, 'NO_PROVEN_EDGE');
});

test('unexecuted or outcome-less decisions are ignored', () => {
  const rejected = { ...decision(1, 'E', 2, 1), status: 'RISK_REJECTED' as const };
  const open = { ...decision(2, 'E', 2, 1), outcome: undefined };
  assert.equal(calibrateRrFloors([rejected, open], { ...COSTS }).verdicts.length, 0);
});

test('minRrFor falls back when the strategy has no calibrated floor', () => {
  const profile: RrProfile = { version: 1, generatedAt: 0, floors: { A: { minRr: 1.7, n: 50, meanNetR: 0.4, lcbNetR: 0.1 } } };
  assert.equal(minRrFor(profile, 'A', 1), 1.7);
  assert.equal(minRrFor(profile, 'Z', 1), 1);
  assert.equal(minRrFor(undefined, 'A', 1), 1);
});

// --- RiskAgent integration -------------------------------------------------------------------
const risk = {
  minLeverage: 5, maxLeverage: 10, maxExposurePct: 80, riskPerTradePct: 1, maxDrawdownPct: 5, minLiqBufferAtr: 2,
  maxDailyLossPct: 3, maxLossStreak: 4, maxConcurrentPositions: 4, maxSymbolExposurePct: 80, maxCorrelatedExposurePct: 80,
  minRr: 0, takerFeeRate: 0.0004, slippageBufferRate: 0.0002,
};
Object.assign(config.risk, risk);
const limits = riskLimitsFromConfig(risk);
const EQUITY = 100_000;
setSymbolRules('BTCUSDT', { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 });
const candles: Candle[] = Array.from({ length: 30 }, (_, i) => ({ openTime: i, open: 100, high: 100.25, low: 99.75, close: 100, volume: 1 }));
const engine = new PerformanceEngine(EQUITY, () => 0);
engine.onEquity(EQUITY);
const ctx = (over: Partial<MarketContext> = {}): MarketContext => ({
  candles: { BTCUSDT: candles }, funding: {}, marks: {}, spot: {}, equity: EQUITY, positions: [],
  performance: { circuit: 'NORMAL', snapshot: engine.snapshot(EQUITY) }, ...over,
});
const signal = (over: Partial<Signal> = {}): Signal =>
  ({ id: 's', agent: 'MOMENTUM-γ', symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.75, entry: 100, stopLoss: 98, takeProfit: 102.5, reason: '', ts: 0, ...over });
const profile: RrProfile = { version: 1, generatedAt: 0, floors: { 'MOMENTUM-γ': { minRr: 1.5, n: 50, meanNetR: 0.4, lcbNetR: 0.1 } } };

test('without a profile the RR gate stays off exactly as before (MIN_RR=0)', () => {
  const agent = new RiskAgent({} as BinanceService, { riskEngine: 'on', limits });
  assert.equal(agent.gate(signal({ takeProfit: 100.06 }), ctx()).approved, true);
});

test('a calibrated floor refuses a low-RR signal and reports cost-adjusted RR', () => {
  const agent = new RiskAgent({} as BinanceService, { riskEngine: 'on', limits, rrProfile: profile });
  const low = agent.gate(signal({ takeProfit: 100.06 }), ctx());
  assert.equal(low.approved, false);
  assert.match(low.reason, /min_rr: rr -?\d/);
  assert.equal(classifyRiskRefusal(low.reason), 'RR_TOO_LOW');
});

test('raw RR 1.25 passes a raw 1.2 floor but fails a 1.2 floor once costs are charged', () => {
  const agent = new RiskAgent({} as BinanceService, { riskEngine: 'on', limits, rrProfile: { ...profile, floors: { 'MOMENTUM-γ': { ...profile.floors['MOMENTUM-γ'], minRr: 1.2 } } } });
  // entry 100 sl 99.5 tp 100.625: raw 1.25; cost 0.12 => (0.625-0.12)/(0.5+0.12) = 0.81
  assert.equal(agent.gate(signal({ stopLoss: 99.5, takeProfit: 100.625 }), ctx()).approved, false);
  assert.equal(agent.gate(signal({ stopLoss: 98, takeProfit: 104 }), ctx()).approved, true);
});

test('a strategy without a floor keeps the global limit', () => {
  const agent = new RiskAgent({} as BinanceService, { riskEngine: 'on', limits, rrProfile: profile });
  assert.equal(agent.gate(signal({ agent: 'CROWDING-ε' as never, takeProfit: 100.06 }), ctx()).approved, true);
});

// --- NoTrade + suppressor --------------------------------------------------------------------
test('refusals map to stable NO_TRADE codes; only capacity and circuit blocks are standing', () => {
  assert.equal(classifyRiskRefusal('risk-engine: portfolio_limits: symbol 127% (max 100%)'), 'PORTFOLIO_CAPACITY');
  assert.equal(classifyRiskRefusal('risk-engine: circuit_breaker: circuit state HALTED'), 'CIRCUIT_BREAKER');
  assert.equal(classifyRiskRefusal('something else'), 'OTHER_RISK');
  assert.equal(isStandingBlock('PORTFOLIO_CAPACITY'), true);
  assert.equal(isStandingBlock('RR_TOO_LOW'), false);
});

const held = (qty: number): Position => ({
  id: 'p', symbol: 'BTCUSDT', side: 'LONG', strategy: 'MOMENTUM-γ', entry: 100, qty, mark: 100, upnl: 0, upnlPct: 0, leverage: 5,
  marginType: 'ISOLATED', liqDistancePct: null, serverSl: '', serverTp: '',
});

test('a capacity refusal suppresses re-gating until the book, equity or circuit changes', () => {
  const s = new RefusalSuppressor();
  const sig = signal();
  const book = { equity: EQUITY, positions: [held(100)], circuit: 'NORMAL' };
  assert.equal(s.shouldSkip(sig, book), false);
  s.noteRefusal(sig, 'risk-engine: portfolio_limits: symbol 127% (max 100%)', book);
  assert.equal(s.shouldSkip(sig, book), true);
  assert.equal(s.shouldSkip(sig, { ...book, equity: EQUITY + 200 }), true); // sub-1% equity drift is not a change
  assert.equal(s.shouldSkip(sig, { ...book, positions: [held(60)] }), false);
  assert.equal(s.shouldSkip(sig, book), false); // cleared once the book moved
});

test('non-standing refusals are never suppressed', () => {
  const s = new RefusalSuppressor();
  const book = { equity: EQUITY, positions: [], circuit: 'NORMAL' };
  s.noteRefusal(signal(), 'risk-engine: min_rr: rr 0.03 (min 1.5)', book);
  assert.equal(s.shouldSkip(signal(), book), false);
});
