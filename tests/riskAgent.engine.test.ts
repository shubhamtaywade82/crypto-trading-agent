import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BinanceService } from '../src/binance/client.js';
import { setSymbolRules } from '../src/binance/symbolRules.js';
import type { MarketContext } from '../src/agents/BaseAgent.js';
import { RiskAgent } from '../src/agents/RiskAgent.js';
import { config } from '../src/config.js';
import { PerformanceEngine } from '../src/risk/performanceEngine.js';
import { refreshPortfolio } from '../src/runtime/opsHooks.js';
import { deriveCircuitState, riskLimitsFromConfig, type RiskLimits } from '../src/risk/riskConfig.js';
import type { Candle, Position, Signal, TradeRecord } from '../src/types.js';

const risk = {
  minLeverage: 5, maxLeverage: 10, maxExposurePct: 80, riskPerTradePct: 1, maxDrawdownPct: 5, minLiqBufferAtr: 2,
  maxDailyLossPct: 3, maxLossStreak: 4, maxConcurrentPositions: 4, maxSymbolExposurePct: 80, maxCorrelatedExposurePct: 80,
  minRr: 0, takerFeeRate: 0.0004, slippageBufferRate: 0.0002,
};
// Pinned so the hand-computed numbers below do not depend on a local .env
Object.assign(config.risk, risk);
const limits = riskLimitsFromConfig(risk);

const NOW = Date.UTC(2026, 8, 22, 12);
const INITIAL_EQUITY = 100_000;
for (const symbol of ['BTCUSDT', 'AVAXUSDT']) {
  setSymbolRules(symbol, { pricePrecision: 2, quantityPrecision: 3, tickSize: 0.01, stepSize: 0.001, minQty: 0.001, minNotional: 5 });
}

const candles = (range: number): Candle[] =>
  Array.from({ length: 30 }, (_, i) => ({ openTime: i, open: 100, high: 100 + range / 2, low: 100 - range / 2, close: 100, volume: 1 }));
const lossToday = (pnl: number): TradeRecord =>
  ({ symbol: 'BTCUSDT', strategy: 'MOMENTUM-γ', side: 'LONG', entry: 100, exit: 99, qty: 1, pnl, reason: 'STOP LOSS', closedAt: NOW - 60_000 });

function performanceFor(trades: TradeRecord[], equity = INITIAL_EQUITY, lim: RiskLimits = limits): NonNullable<MarketContext['performance']> {
  const engine = new PerformanceEngine(INITIAL_EQUITY, () => NOW);
  engine.hydrate(trades);
  engine.onEquity(equity);
  const snapshot = engine.snapshot(equity);
  return { circuit: deriveCircuitState(snapshot.dailyLossPercent, snapshot.drawdownPercent, snapshot.lossStreak, lim), snapshot };
}

const ctx = (over: Partial<MarketContext> = {}): MarketContext => ({
  candles: { BTCUSDT: candles(0.5), AVAXUSDT: candles(0.5) }, funding: {}, marks: {}, spot: {}, equity: INITIAL_EQUITY,
  positions: [], performance: performanceFor([]), ...over,
});
const signal = (over: Partial<Signal> = {}): Signal =>
  ({ id: 's', agent: 'MOMENTUM-γ', symbol: 'BTCUSDT', type: 'OPEN_LONG', confidence: 0.75, entry: 100, stopLoss: 98, takeProfit: 106, reason: '', ts: 0, ...over });
const hedge = (notionalUsdt?: number): Signal =>
  signal({ type: 'OPEN_HEDGE', agent: 'FUNDING-ARB-α', entry: undefined, stopLoss: undefined, takeProfit: undefined, notionalUsdt });
const position = (symbol: string, qty: number, mark = 100, leverage = 5): Position => ({
  id: symbol, symbol, side: 'LONG', strategy: 'MOMENTUM-γ', entry: mark, qty, mark, upnl: 0, upnlPct: 0, leverage,
  marginType: 'ISOLATED', liqDistancePct: null, serverSl: '', serverTp: '',
});
const agentWith = (over: Partial<RiskLimits> = {}) =>
  new RiskAgent({} as BinanceService, { riskEngine: 'on', limits: { ...limits, ...over } });

test('should size by budget over effective risk per unit including fees and slippage', () => {
  // budget 1000 = 1% of 100k; stop distance 2 + fees 100 * (0.0004 + 0.0002) * 2 legs = 0.12 -> 2.12 per unit; 1000 / 2.12 floors to 471.698
  const decision = agentWith().gate(signal(), ctx());
  assert.equal(decision.approved, true, decision.reason);
  assert.ok(Math.abs(decision.positionSizeUsdt - 47_169.8) < 1e-6);
  assert.equal(decision.leverage, 9);
  assert.equal(decision.marginType, 'ISOLATED');
  assert.equal(decision.liqBufferAtr, 4);
  assert.equal(decision.reason, 'qty 471.698 notional $47170 lev 9x circuit NORMAL');
});

test('should scale the risk budget down in a REDUCED circuit', () => {
  const performance = performanceFor([lossToday(-2_250)]);
  assert.equal(performance.circuit, 'REDUCED');
  const decision = agentWith().gate(signal(), ctx({ performance }));
  assert.equal(decision.approved, true, decision.reason);
  assert.ok(decision.reason.startsWith('qty 235.849 '), decision.reason); // 500 / 2.12 floored to the lot
});

test('should charge funding for the expected holding periods', () => {
  // effective risk 2 + 0.12 + 100 * 0.0002 * 3 = 2.18 -> 1000 / 2.18 floors to 458.715
  const decision = agentWith().gate(signal(), ctx({ funding: { BTCUSDT: 0.0002 } }));
  assert.ok(decision.reason.startsWith('qty 458.715 '), decision.reason);
});

test('should reject a stop on the wrong side of entry before sizing', () => {
  const agent = agentWith();
  assert.equal(agent.gate(signal({ stopLoss: 104 }), ctx()).reason, 'stop on wrong side of entry');
  assert.equal(agent.gate(signal({ type: 'OPEN_SHORT', stopLoss: 96 }), ctx()).reason, 'stop on wrong side of entry');
  assert.equal(agent.gate(signal({ type: 'OPEN_SHORT', stopLoss: 102 }), ctx()).approved, true);
});

test('should keep the ATR liquidation buffer check as an additional guard', () => {
  const decision = agentWith().gate(signal({ stopLoss: 99.9 }), ctx());
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /^liq buffer/);
});

test('should keep the drawdown kill-switch as an additional guard', () => {
  const agent = agentWith();
  assert.equal(agent.gate(signal(), ctx()).approved, true);
  assert.match(agent.gate(signal(), ctx({ equity: 94_000 })).reason, /^drawdown kill-switch/);
});

test('should reject entries and hedges with a named reason when the circuit is HALTED', () => {
  const performance = performanceFor([lossToday(-3_100)]);
  assert.equal(performance.circuit, 'HALTED');
  const agent = agentWith();
  const entry = agent.gate(signal(), ctx({ performance }));
  assert.equal(entry.approved, false);
  assert.equal(entry.reason, 'risk-engine: circuit_breaker: circuit state HALTED');
  const harvest = agent.gate(hedge(5_000), ctx({ performance }));
  assert.equal(harvest.approved, false);
  assert.equal(harvest.reason, 'risk-engine: circuit_breaker: circuit state HALTED');
});

test('should reject hedges in an EMERGENCY circuit', () => {
  const performance = performanceFor([], 94_000);
  assert.equal(performance.circuit, 'EMERGENCY');
  assert.equal(agentWith().gate(hedge(5_000), ctx({ equity: 94_000, performance })).reason, 'risk-engine: circuit_breaker: circuit state EMERGENCY');
});

test('should approve a hedge on its own notional path when the circuit and limits allow it', () => {
  const decision = agentWith().gate(hedge(5_000), ctx());
  assert.deepEqual(
    { approved: decision.approved, size: decision.positionSizeUsdt, leverage: decision.leverage, reason: decision.reason },
    { approved: true, size: 5_000, leverage: 5, reason: 'funding harvest 5x isolated' },
  );
});

test('should reject a hedge that breaches the exposure or position-count limits', () => {
  const crowded = ctx({ positions: [position('SOLUSDT', 1), position('ETHUSDT', 1), position('XRPUSDT', 1), position('ADAUSDT', 1)] });
  assert.match(agentWith().gate(hedge(5_000), crowded).reason, /^risk-engine: position_count: 5 of max 4/);
  const loaded = ctx({ positions: [position('ETHUSDT', 700)] });
  assert.match(agentWith().gate(hedge(20_000), loaded).reason, /portfolio_limits: .*gross 90%/);
});

test('should reject an entry when the open position count is at the limit', () => {
  const positions = [position('SOLUSDT', 1), position('ETHUSDT', 1), position('XRPUSDT', 1), position('ADAUSDT', 1)];
  const decision = agentWith().gate(signal(), ctx({ positions }));
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /risk-engine: position_count: 5 of max 4/);
});

test('should reject an entry that pushes gross exposure past the limit', () => {
  const decision = agentWith().gate(signal(), ctx({ positions: [position('ETHUSDT', 400)] })); // 40k + 47.2k = 87%
  assert.match(decision.reason, /risk-engine: portfolio_limits: gross 87\.17%/);
});

test('should reject an entry that pushes one symbol past its cap', () => {
  const decision = agentWith({ maxSymbolExposurePercent: 50 }).gate(signal(), ctx({ positions: [position('BTCUSDT', 100)] }));
  assert.match(decision.reason, /symbol 57\.17% \(max 50%\)/);
});

test('should reject an entry that pushes a correlated cluster past its cap', () => {
  const decision = agentWith({ maxCorrelatedExposurePercent: 60 }).gate(signal({ symbol: 'AVAXUSDT' }), ctx({ positions: [position('SOLUSDT', 200)] }));
  assert.match(decision.reason, /cluster ALT 67\.17% \(max 60%\)/);
  assert.equal(agentWith({ maxCorrelatedExposurePercent: 60 }).gate(signal(), ctx({ positions: [position('SOLUSDT', 200)] })).approved, true); // BTC is its own cluster
});

test('should size against margin left after the open positions', () => {
  const decision = agentWith().gate(signal(), ctx({ positions: [position('ETHUSDT', 1_000, 100, 1)] })); // 100k of margin already in use
  assert.match(decision.reason, /sizing: insufficient available margin/);
});

test('should enforce the minimum reward:risk only when configured and derivable', () => {
  const agent = agentWith({ minRiskRewardRatio: 2 });
  assert.equal(agent.gate(signal({ takeProfit: 104 }), ctx()).approved, true); // rr 2
  assert.match(agent.gate(signal({ takeProfit: 101 }), ctx()).reason, /min_rr: rr 0\.50/);
  assert.match(agent.gate(signal({ takeProfit: undefined }), ctx()).reason, /min_rr: rr unavailable/);
  assert.equal(agent.gate(hedge(5_000), ctx()).approved, true); // a hedge has no stop, so rr does not apply
});

test('should fail closed when the flag is on but no performance snapshot is present', () => {
  const decision = agentWith().gate(signal(), ctx({ performance: undefined }));
  assert.equal(decision.approved, false);
  assert.match(decision.reason, /performance snapshot unavailable/);
});

test('should give the same decision after a restart that re-hydrates the same journal', () => {
  const journal = [lossToday(-500), lossToday(-600)];
  const [first, second] = [performanceFor(journal), performanceFor(journal)];
  assert.deepEqual(first, second);
  assert.deepEqual(agentWith().gate(signal(), ctx({ performance: first })), agentWith().gate(signal(), ctx({ performance: second })));
});

test('should read the limits from config at call time when none are injected', () => {
  const decision = new RiskAgent({} as BinanceService, { riskEngine: 'on' }).gate(signal(), ctx());
  assert.equal(decision.reason, 'qty 471.698 notional $47170 lev 9x circuit NORMAL');
});

// Stands in for the broker: `fill` is what the executor does between two gates of the same cycle
function brokerWith(held: Position[]) {
  const reads: boolean[] = [];
  const source = { getPositions: async (fresh = true) => { reads.push(fresh); return [...held]; }, getAccount: async () => ({ equity: INITIAL_EQUITY }) };
  return { source, reads, fill: (p: Position) => held.push(p) };
}

test('should refuse the second entry of a cycle once the first fill reaches the position cap', async () => {
  const agent = agentWith({ maxConcurrentPositions: 1 });
  const broker = brokerWith([]);
  const start = ctx();
  assert.equal(agent.gate(signal(), start).approved, true);
  broker.fill(position('BTCUSDT', 100));
  const next = await refreshPortfolio(start, broker.source);
  assert.match(agent.gate(signal({ symbol: 'AVAXUSDT' }), next).reason, /risk-engine: position_count: 2 of max 1/);
  assert.equal(agent.gate(signal({ symbol: 'AVAXUSDT' }), start).approved, true, 'the stale snapshot would have approved it');
});

test('should refuse the second entry of a cycle once the first fill uses up the exposure cap', async () => {
  const agent = agentWith();
  const broker = brokerWith([]);
  const start = ctx();
  assert.equal(agent.gate(signal(), start).approved, true); // 47k notional
  broker.fill(position('BTCUSDT', 471.698));
  const next = await refreshPortfolio(start, broker.source);
  assert.match(agent.gate(signal({ symbol: 'AVAXUSDT' }), next).reason, /risk-engine: portfolio_limits: gross 9\d\.\d+%/);
});

test('should read the cached positions and keep the rest of the context when refreshing', async () => {
  const broker = brokerWith([position('BTCUSDT', 1)]);
  const start = ctx({ funding: { BTCUSDT: 0.0001 } });
  const next = await refreshPortfolio(start, broker.source);
  assert.deepEqual(broker.reads, [false]);
  assert.equal(next.positions?.length, 1);
  assert.equal(next.funding, start.funding);
  assert.equal(next.performance, start.performance);
});

test('should not touch the broker when the engine is off', async () => {
  const broker = brokerWith([position('BTCUSDT', 1)]);
  const start = ctx({ performance: undefined });
  assert.equal(await refreshPortfolio(start, broker.source), start);
  assert.deepEqual(broker.reads, []);
});
