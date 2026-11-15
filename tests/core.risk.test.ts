import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decisionIdOf, DecisionBuilder } from '../src/core/application/decisions/DecisionBuilder.js';
import { CircuitBreaker } from '../src/core/application/risk/CircuitBreaker.js';
import { floorToStep, sizeProposal } from '../src/core/application/risk/PositionSizer.js';
import { RiskPipeline } from '../src/core/application/risk/RiskPipeline.js';
import { SessionTracker } from '../src/core/application/risk/SessionTracker.js';
import type { MarketSnapshot } from '../src/core/domain/market.js';
import type { PortfolioSnapshot } from '../src/core/domain/portfolio.js';
import type { RiskContext, RiskLimits, TradeProposal } from '../src/core/domain/risk.js';
import { defaultRiskRules } from '../src/core/risk/rules/index.js';
import { candlesFromCloses, LIMITS, portfolioOf, positionOf, signalOf, snapshotOf, T0 } from './support/coreFixtures.js';

const clock = { now: () => T0 };
const market = (overrides: Partial<MarketSnapshot> = {}): MarketSnapshot => snapshotOf('BTCUSDT', candlesFromCloses([100, 100]), '15m', overrides);

function sized(portfolio = portfolioOf(), limits: RiskLimits = LIMITS, signal = signalOf()): TradeProposal {
  const outcome = sizeProposal({ decisionId: decisionIdOf(signal), signal, supportingStrategies: [] }, portfolio, limits);
  assert.ok(outcome.ok, outcome.ok ? '' : outcome.reason);
  return outcome.proposal;
}

function evaluate(change: { proposal?: Partial<TradeProposal>; portfolio?: Partial<PortfolioSnapshot>; market?: Partial<MarketSnapshot>; limits?: Partial<RiskLimits>; context?: Partial<RiskContext> } = {}) {
  const portfolio = portfolioOf(change.portfolio);
  const limits = { ...LIMITS, ...change.limits };
  const proposal = { ...sized(portfolioOf(), LIMITS), ...change.proposal };
  const verdict = new RiskPipeline(defaultRiskRules(), clock).evaluate(proposal, { market: market(change.market), portfolio, limits, executedDecisionIds: new Set(), haltReason: null, ...change.context });
  return { verdict, codes: verdict.decision.findings.filter((f) => f.severity === 'block').map((f) => f.code) };
}

test('a clean proposal passes every rule and yields an approval', () => {
  const { verdict, codes } = evaluate();
  assert.deepEqual(codes, []);
  assert.equal(verdict.decision.approved, true);
  assert.ok(verdict.approved);
  assert.equal(verdict.decision.evaluatedRules.length, defaultRiskRules().length);
  assert.equal(verdict.decision.decidedAt, T0);
});

test('every hard limit blocks on its own violation', () => {
  const cases: Array<[string, Parameters<typeof evaluate>[0]]> = [
    ['TRADING_HALTED', { context: { haltReason: 'kill switch' } }],
    ['MARK_INVALID', { market: { markPrice: Number.NaN } }],
    ['MARK_STALE', { market: { markAt: T0 - 10 * 60_000 } }],
    ['BAR_STALE', { market: { markAt: T0 + 60 * 60_000 } }],
    ['MARK_UNDATED', { market: { markAt: Number.NaN } }],
    ['SYMBOL_NOT_ALLOWED', { limits: { allowedSymbols: ['ETHUSDT'] } }],
    ['DUPLICATE_DECISION', { context: { executedDecisionIds: new Set([decisionIdOf(signalOf())]) } }],
    ['POSITION_OPEN', { portfolio: { positions: [positionOf('BTCUSDT')] } }],
    ['TOO_MANY_POSITIONS', { portfolio: { positions: [positionOf('ETHUSDT'), positionOf('SOLUSDT')] } }],
    ['STOP_WRONG_SIDE', { proposal: { stopLoss: 101 } }],
    ['TARGET_WRONG_SIDE', { proposal: { takeProfit: 99 } }],
    ['NON_FINITE', { proposal: { quantity: 0 } }],
    ['NON_FINITE', { proposal: { stopLoss: Number.NaN } }],
    ['STOP_ALREADY_BREACHED', { market: { markPrice: 97.5 } }],
    ['REWARD_RISK_TOO_LOW', { proposal: { takeProfit: 101 } }],
    ['LEVERAGE_OUT_OF_RANGE', { proposal: { leverage: 11 } }],
    ['LEVERAGE_OUT_OF_RANGE', { proposal: { leverage: 0 } }],
    ['BELOW_MIN_NOTIONAL', { proposal: { notional: 5 } }],
    ['OVER_RISK_BUDGET', { proposal: { riskAmount: 150 } }],
    ['INSUFFICIENT_MARGIN', { portfolio: { availableMargin: 100 } }],
    ['OVER_GROSS_EXPOSURE', { limits: { maxGrossExposurePct: 10 } }],
    ['DAILY_LOSS_LIMIT', { portfolio: { equity: 9_700, dayStartEquity: 10_000 } }],
    ['DRAWDOWN_LIMIT', { portfolio: { equity: 9_500, peakEquity: 10_000 } }],
    ['LOSS_STREAK_LIMIT', { portfolio: { lossStreak: 4 } }],
  ];
  for (const [code, change] of cases) {
    const { verdict, codes } = evaluate(change);
    assert.ok(codes.includes(code), `expected ${code}, got ${codes.join(',') || 'approval'}`);
    assert.equal(verdict.decision.approved, false, code);
    assert.equal(verdict.approved, null, code);
  }
});

test('a rejection reports every violation, not only the first', () => {
  const { codes } = evaluate({ context: { haltReason: 'manual' }, portfolio: { lossStreak: 9, equity: 9_000, peakEquity: 10_000, dayStartEquity: 10_000 }, proposal: { leverage: 50 } });
  for (const code of ['TRADING_HALTED', 'LEVERAGE_OUT_OF_RANGE', 'DAILY_LOSS_LIMIT', 'DRAWDOWN_LIMIT', 'LOSS_STREAK_LIMIT']) assert.ok(codes.includes(code), code);
});

test('a warning is reported and does not block', () => {
  const { verdict } = evaluate({ portfolio: { positions: [positionOf('ETHUSDT', { stopLoss: null })] } });
  assert.equal(verdict.decision.approved, true);
  assert.deepEqual(verdict.decision.findings.map((f) => [f.severity, f.code]), [['warning', 'POSITION_WITHOUT_STOP']]);
});

test('a rule that throws blocks the trade', () => {
  const pipeline = new RiskPipeline([{ id: 'ok', evaluate: () => null }, { id: 'broken', evaluate: () => { throw new Error('boom'); } }], clock);
  const verdict = pipeline.evaluate(sized(), { market: market(), portfolio: portfolioOf(), limits: LIMITS, executedDecisionIds: new Set(), haltReason: null });
  assert.equal(verdict.approved, null);
  assert.deepEqual(verdict.decision.findings.map((f) => [f.ruleId, f.code]), [['broken', 'RULE_ERROR']]);
});

test('a pipeline needs rules, with unique ids', () => {
  assert.throws(() => new RiskPipeline([], clock), /at least one rule/);
  assert.throws(() => new RiskPipeline([{ id: 'a', evaluate: () => null }, { id: 'a', evaluate: () => null }], clock), /registered twice/);
  assert.equal(new Set(defaultRiskRules().map((r) => r.id)).size, defaultRiskRules().length);
});

test('sizing puts the per-trade budget at the stop, costs included', () => {
  const proposal = sized();
  // stop distance 2 + round-trip costs 100 * 0.0006 * 2 = 0.12 -> 2.12 per unit; budget 1% of 10,000 = 100
  assert.equal(proposal.quantity, 47.169);
  assert.ok(proposal.riskAmount <= 100 && proposal.riskAmount > 99.9);
  assert.ok(Math.abs(proposal.notional - 4716.9) < 1e-6);
  assert.equal(proposal.leverage, 1);
});

test('sizing shrinks to the margin available at the leverage cap and never rounds up', () => {
  const tight = sized(portfolioOf({ availableMargin: 100 }));
  assert.equal(tight.quantity, 10); // 100 margin * 10x / 100 entry
  assert.equal(tight.leverage, 10);
  assert.ok(tight.notional / tight.leverage <= 100);
  assert.equal(floorToStep(0.3, 0.1), 0.3);
  assert.equal(floorToStep(1.2399, 0.001), 1.239);
  assert.equal(floorToStep(47.1698, 0.001), 47.169);
  assert.equal(floorToStep(5.9, 1), 5);
});

test('sizing refuses what cannot be sized', () => {
  const draft = (signal = signalOf()) => ({ decisionId: 'd', signal, supportingStrategies: [] });
  const reason = (outcome: ReturnType<typeof sizeProposal>) => (outcome.ok ? 'ok' : outcome.reason);
  assert.match(reason(sizeProposal(draft(signalOf({ stopLoss: 100 })), portfolioOf(), LIMITS)), /stop distance is zero/);
  assert.match(reason(sizeProposal(draft(), portfolioOf({ equity: 0 }), LIMITS)), /no equity/);
  assert.match(reason(sizeProposal(draft(), portfolioOf({ availableMargin: 0 }), LIMITS)), /no equity or available margin/);
  assert.match(reason(sizeProposal(draft(), portfolioOf({ equity: 5, availableMargin: 5 }), LIMITS)), /below the minimum notional/);
});

test('conflicting signals produce no trade; agreeing signals pick the most confident deterministically', () => {
  const builder = new DecisionBuilder();
  const long = signalOf({ strategyId: 'a', confidence: 0.6 }), strongLong = signalOf({ strategyId: 'b', confidence: 0.8 });
  const short = signalOf({ strategyId: 'c', direction: 'SHORT', stopLoss: 102, takeProfit: 94 });
  assert.deepEqual(builder.build('BTCUSDT', [], portfolioOf()), { kind: 'none', reason: 'no signals' });
  const conflict = builder.build('BTCUSDT', [long, short], portfolioOf());
  assert.equal(conflict.kind, 'none');
  assert.match(conflict.kind === 'none' ? conflict.reason : '', /conflicting signals: a=LONG, c=SHORT/);
  const held = builder.build('BTCUSDT', [long], portfolioOf({ positions: [positionOf('BTCUSDT')] }));
  assert.match(held.kind === 'none' ? held.reason : '', /already open/);
  for (const order of [[long, strongLong], [strongLong, long]]) {
    const built = builder.build('BTCUSDT', order, portfolioOf());
    assert.ok(built.kind === 'draft');
    assert.equal(built.draft.signal.strategyId, 'b');
    assert.deepEqual(built.draft.supportingStrategies, ['a']);
    assert.equal(built.draft.decisionId, decisionIdOf(strongLong));
  }
  const tie = builder.build('BTCUSDT', [signalOf({ strategyId: 'z' }), signalOf({ strategyId: 'm' })], portfolioOf());
  assert.equal(tie.kind === 'draft' ? tie.draft.signal.strategyId : '', 'm');
  assert.notEqual(decisionIdOf(long), decisionIdOf({ ...long, barTime: long.barTime + 1 }));
});

test('the circuit breaker latches and only an operator resets it', () => {
  const breaker = new CircuitBreaker(5);
  assert.equal(breaker.observe(portfolioOf({ equity: 9_600, peakEquity: 10_000 })), false);
  assert.equal(breaker.haltReason(), null);
  assert.equal(breaker.observe(portfolioOf({ equity: 9_500, peakEquity: 10_000 })), true);
  assert.match(breaker.haltReason()!, /drawdown 5\.00% reached the 5% limit/);
  // Equity recovering does not re-arm it, and a second trip keeps the first reason
  assert.equal(breaker.observe(portfolioOf({ equity: 10_000, peakEquity: 10_000 })), false);
  assert.equal(breaker.trip('other', T0), false);
  assert.equal(breaker.snapshot.state, 'TRIPPED');
  assert.match(breaker.haltReason()!, /drawdown/);
  assert.throws(() => breaker.reset('  '), /operator/);
  breaker.reset('shubham');
  assert.equal(breaker.snapshot.state, 'ARMED');
  // A restored snapshot stays tripped across a restart
  assert.match(new CircuitBreaker(5, { state: 'TRIPPED', reason: 'order outcome unknown', trippedAt: T0 }).haltReason()!, /order outcome unknown/);
});

test('the session tracker derives day start, peak and the losing streak from account views', () => {
  const tracker = new SessionTracker();
  const view = (asOf: number, equity: number, realizedPnl: number, symbols: string[]) =>
    tracker.observe({ asOf, equity, availableMargin: equity, realizedPnl, positions: symbols.map((s) => positionOf(s)) });
  const day = 86_400_000;
  let p = view(T0, 10_000, 0, []);
  assert.deepEqual([p.dayStartEquity, p.peakEquity, p.lossStreak], [10_000, 10_000, 0]);
  p = view(T0 + 1000, 10_050, 0, ['BTCUSDT']);
  assert.deepEqual([p.dayStartEquity, p.peakEquity, p.lossStreak], [10_000, 10_050, 0]);
  p = view(T0 + 2000, 9_950, -100, []); // BTC closed at a loss
  assert.equal(p.lossStreak, 1);
  p = view(T0 + 3000, 9_950, -100, ['ETHUSDT', 'SOLUSDT']);
  p = view(T0 + 4000, 9_900, -150, []); // both closed, net loss
  assert.equal(p.lossStreak, 3);
  p = view(T0 + 5000, 9_900, -150, ['XRPUSDT']);
  p = view(T0 + 6000, 9_960, -90, []); // closed at a profit
  assert.equal(p.lossStreak, 0);
  assert.equal(p.peakEquity, 10_050);
  p = view(T0 + day, 9_960, -90, []);
  assert.equal(p.dayStartEquity, 9_960); // new UTC day
  assert.equal(p.peakEquity, 10_050); // the peak is not a daily figure
  const restored = new SessionTracker(tracker.serialize());
  assert.equal(restored.observe({ asOf: T0 + day + 1, equity: 9_900, availableMargin: 9_900, realizedPnl: -90, positions: [] }).dayStartEquity, 9_960);
});
