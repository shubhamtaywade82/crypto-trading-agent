import assert from 'node:assert/strict';
import { test } from 'node:test';
import { InMemoryOwnershipJournal } from '../src/core/adapters/persistence/OwnershipJournals.js';
import { InMemoryResearchRepository } from '../src/core/adapters/persistence/JsonlResearchRepository.js';
import { buildPipeline, type PipelineInput } from '../src/core/composition/buildPipeline.js';
import { OwnershipLedger } from '../src/core/application/ownership/OwnershipLedger.js';
import { barClosedEvent, type BarClosedEvent, type Candle } from '../src/core/domain/market.js';
import type { Strategy, StrategyContext, StrategySignal } from '../src/core/domain/strategy.js';
import type { AdvisorBrief, AdvisorOpinion, DecisionAdvisorPort } from '../src/core/ports/DecisionAdvisorPort.js';
import { VenueUnavailableError } from '../src/core/ports/PaperExecutionPort.js';
import { candlesFromCloses, FakeExecution, FakeMarketData, FakePortfolio, flat, LIMITS, TEST_ACCOUNT, TEST_SCOPE } from './support/coreFixtures.js';

/** Goes long on every bar it is shown, with a 2% stop and a 6% target. */
class AlwaysLong implements Strategy {
  readonly version = '1.0.0';
  readonly parameters = Object.freeze({ stopPct: 2 });
  readonly requirements = { primaryTimeframe: '15m' as const, timeframes: ['15m' as const], features: ['atr:5'], warmupBars: 10 };
  evaluations = 0;
  constructor(readonly id = 'always-long', private readonly direction: 'LONG' | 'SHORT' = 'LONG') {}

  evaluate({ market }: StrategyContext): StrategySignal[] {
    this.evaluations += 1;
    const last = market.candles['15m']!.at(-1)!;
    const sign = this.direction === 'LONG' ? 1 : -1;
    return [{
      strategyId: this.id, strategyVersion: this.version, symbol: market.symbol, direction: this.direction, entry: last.close,
      stopLoss: last.close * (1 - sign * 0.02), takeProfit: last.close * (1 + sign * 0.06), confidence: 0.7, reason: 'test', barTime: last.openTime,
    }];
  }
}

function rig(options: Partial<PipelineInput> & { series?: Record<string, Candle[]> } = {}) {
  const series = options.series ?? { BTCUSDT: candlesFromCloses(flat(30, 100)), ETHUSDT: candlesFromCloses(flat(30, 50)) };
  const marketData = new FakeMarketData(series);
  const execution = new FakeExecution();
  const portfolio = new FakePortfolio(execution);
  const ownership = new OwnershipLedger(new InMemoryOwnershipJournal(), TEST_ACCOUNT);
  const repository = new InMemoryResearchRepository();
  let now = 1_000;
  const pipeline = buildPipeline({
    runId: 'test-run', symbols: Object.keys(series), strategies: [new AlwaysLong()], limits: LIMITS, marketData, portfolio, execution,
    scope: TEST_SCOPE, ownership, clock: { now: () => (now += 1) }, repository, ...options,
  });
  const eventFor = (symbol: string, index = -1): BarClosedEvent => barClosedEvent(symbol, '15m', series[symbol].at(index)!);
  const types = () => repository.events.map((e) => e.type);
  return {
    pipeline, marketData, portfolio, execution, repository, ownership, series, eventFor, types,
    process: (e: BarClosedEvent) => pipeline.orchestrator.processMarketEvent(e),
  };
}

const advisorSaying = (verdict: AdvisorOpinion['verdict'], briefs: AdvisorBrief[] = []): DecisionAdvisorPort => ({
  review: async (brief) => {
    briefs.push(brief);
    return { verdict, reason: 'because', model: 'test-model' };
  },
});

test('a bar is traceable from market event to order result through one ordered event stream', async () => {
  const r = rig();
  const event = r.eventFor('BTCUSDT');
  const outcome = await r.process(event);
  assert.equal(outcome.status, 'EXECUTED');
  assert.equal(outcome.order?.state, 'FILLED');
  assert.equal(outcome.order?.protection, 'ATTACHED');
  assert.deepEqual(r.types(), ['market.bar.closed', 'strategy.signals', 'decision.proposed', 'risk.trade.approved', 'order.command.created', 'order.state.changed']);
  assert.deepEqual(r.repository.events.map((e) => e.sequence), [1, 2, 3, 4, 5, 6]);
  assert.ok(r.repository.events.every((e) => e.causeEventId === event.eventId && e.runId === 'test-run' && Object.isFrozen(e)));

  const [, signals, proposed, approved, created, changed] = r.repository.events;
  assert.ok(signals.type === 'strategy.signals' && proposed.type === 'decision.proposed' && approved.type === 'risk.trade.approved' && created.type === 'order.command.created' && changed.type === 'order.state.changed');
  // Every strategy result carries its version and parameters
  assert.deepEqual(signals.parameters, { 'always-long': { stopPct: 2 } });
  assert.equal(signals.signals[0].strategyVersion, '1.0.0');
  // One decision id links the proposal, the risk verdict, the command and the order outcome
  const id = proposed.proposal.decisionId;
  assert.deepEqual([approved.decision.decisionId, created.command.decisionId, changed.decisionId], [id, id, id]);
  assert.equal(created.command.commandId, changed.commandId);
  assert.equal(approved.decision.evaluatedRules.length, 19);
  assert.deepEqual(r.execution.submitted.map((c) => [c.symbol, c.side, c.stopLoss, c.takeProfit, c.accountId]), [['BTCUSDT', 'BUY', 98, 106, TEST_ACCOUNT]]);
  // The entry is owned by its episode, which is what protection and foreign-position checks rely on
  assert.equal(r.ownership.get(created.command.commandId)?.state, 'OWNED');
});

test('a repeated bar, an older bar, an unknown symbol and a malformed bar are skipped without a decision', async () => {
  const r = rig();
  await r.process(r.eventFor('BTCUSDT'));
  const before = r.execution.submitted.length;
  const skipped = [
    await r.process(r.eventFor('BTCUSDT')),
    await r.process(r.eventFor('BTCUSDT', -2)),
    await r.process(barClosedEvent('DOGEUSDT', '15m', r.series.BTCUSDT.at(-1)!)),
    await r.process(barClosedEvent('ETHUSDT', '15m', { ...r.series.ETHUSDT.at(-1)!, close: Number.NaN })),
  ];
  assert.deepEqual(skipped.map((o) => o.status), ['SKIPPED', 'SKIPPED', 'SKIPPED', 'SKIPPED']);
  assert.deepEqual(skipped.map((o) => o.detail), ['duplicate event', 'out-of-order bar: a later bar was already processed', 'DOGEUSDT is not a configured symbol', 'malformed bar: close is not a positive finite number']);
  assert.equal(r.execution.submitted.length, before);
});

test('events are decided one at a time against current account state, never concurrently', async () => {
  const r = rig({ limits: { ...LIMITS, maxConcurrentPositions: 1 } });
  let inFlight = 0, maxInFlight = 0;
  // The venue opens the slot when the fill is returned, and the next cycle reads it through the portfolio
  r.execution.submitScript = [async () => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, 20));
    inFlight -= 1;
    return FakeExecution.filled();
  }];
  const [first, second] = await Promise.all([r.process(r.eventFor('BTCUSDT')), r.process(r.eventFor('ETHUSDT'))]);
  assert.equal(first.status, 'EXECUTED');
  // Had both been decided at once, both would have seen zero positions and both would have traded
  assert.equal(second.status, 'REJECTED');
  assert.equal(second.detail, 'TOO_MANY_POSITIONS');
  assert.equal(maxInFlight, 1);
  assert.equal(r.execution.submitted.length, 1);
  const cause = r.repository.events.map((e) => e.causeEventId);
  assert.equal(cause.lastIndexOf(r.eventFor('BTCUSDT').eventId) < cause.indexOf(r.eventFor('ETHUSDT').eventId), true);
});

test('an advisor veto removes the candidate and nothing is sent', async () => {
  const briefs: AdvisorBrief[] = [];
  const r = rig({ advisor: advisorSaying('VETO', briefs) });
  const outcome = await r.process(r.eventFor('BTCUSDT'));
  assert.equal(outcome.status, 'VETOED');
  assert.deepEqual(r.execution.calls, []);
  assert.deepEqual(r.types().slice(-2), ['advisor.opinion', 'decision.none']);
  // The advisor sees prices and reasons only: no quantity, leverage, equity or limits
  assert.deepEqual(Object.keys(briefs[0]).sort(), ['decisionId', 'direction', 'entry', 'fundingRate', 'reason', 'rewardRisk', 'stopLoss', 'strategyId', 'symbol', 'takeProfit']);
});

test('an advisor PROCEED cannot override a risk rejection', async () => {
  const r = rig({ advisor: advisorSaying('PROCEED'), killSwitch: () => 'operator kill switch' });
  const outcome = await r.process(r.eventFor('BTCUSDT'));
  assert.equal(outcome.status, 'REJECTED');
  assert.equal(outcome.detail, 'TRADING_HALTED');
  assert.deepEqual(r.execution.calls, []);
  assert.deepEqual(r.types().slice(-2), ['advisor.opinion', 'risk.trade.rejected']);
});

test('an unavailable or failing advisor leaves the deterministic pipeline to decide', async () => {
  for (const advisor of [advisorSaying('UNAVAILABLE'), { review: async () => { throw new Error('socket hang up'); } } satisfies DecisionAdvisorPort]) {
    const r = rig({ advisor });
    assert.equal((await r.process(r.eventFor('BTCUSDT'))).status, 'EXECUTED');
    const opinion = r.repository.events.find((e) => e.type === 'advisor.opinion');
    assert.ok(opinion?.type === 'advisor.opinion' && opinion.opinion.verdict === 'UNAVAILABLE');
  }
});

test('the advisor is not consulted when there is nothing to review', async () => {
  const briefs: AdvisorBrief[] = [];
  const r = rig({ advisor: advisorSaying('PROCEED', briefs), strategies: [new AlwaysLong('a', 'LONG'), new AlwaysLong('b', 'SHORT')] });
  const outcome = await r.process(r.eventFor('BTCUSDT'));
  assert.equal(outcome.status, 'NO_DECISION');
  assert.match(outcome.detail, /conflicting signals/);
  assert.equal(briefs.length, 0);
});

test('an order whose outcome is unknown trips the breaker, and every later entry is refused without a submission', async () => {
  const r = rig();
  r.execution.submitScript = [new VenueUnavailableError('timeout')];
  const first = await r.process(r.eventFor('BTCUSDT'));
  assert.equal(first.order?.state, 'UNKNOWN');
  assert.equal(r.pipeline.breaker.snapshot.state, 'TRIPPED');
  assert.equal(r.types().at(-1), 'engine.halted');

  const submittedBefore = r.execution.submitted.length;
  const second = await r.process(r.eventFor('ETHUSDT'));
  assert.equal(second.status, 'REJECTED');
  assert.equal(second.detail, 'TRADING_HALTED');
  assert.equal(r.execution.submitted.length, submittedBefore);
});

test('a position left without a stop trips the breaker', async () => {
  const r = rig();
  r.execution.protectScript = [new VenueUnavailableError('down')];
  r.execution.flattenScript = [new VenueUnavailableError('down')];
  const outcome = await r.process(r.eventFor('BTCUSDT'));
  assert.match(outcome.detail, /UNPROTECTED POSITION/);
  assert.match(r.pipeline.breaker.haltReason()!, /UNPROTECTED POSITION/);
});

test('a drawdown breach halts trading before the strategy output is acted on', async () => {
  const r = rig();
  r.portfolio.account = { ...r.portfolio.account, equity: 10_000 };
  await r.pipeline.orchestrator.idle();
  r.pipeline.session.observe({ asOf: 0, equity: 11_000, availableMargin: 11_000, realizedPnl: 0, positions: [] });
  const outcome = await r.process(r.eventFor('BTCUSDT'));
  assert.equal(outcome.status, 'REJECTED');
  assert.ok(outcome.detail.includes('TRADING_HALTED') && outcome.detail.includes('DRAWDOWN_LIMIT'));
  assert.ok(r.types().includes('engine.halted'));
  assert.deepEqual(r.execution.calls, []);
});

test('missing market data or an unreachable account fails the cycle and never trades', async () => {
  const feedDown = rig();
  feedDown.marketData.failFor.add('BTCUSDT');
  const a = await feedDown.process(feedDown.eventFor('BTCUSDT'));
  assert.equal(a.status, 'FAILED');
  assert.match(a.detail, /feed down/);

  const accountDown = rig();
  accountDown.portfolio.fail = new VenueUnavailableError('paper_exchange unreachable');
  const b = await accountDown.process(accountDown.eventFor('BTCUSDT'));
  assert.equal(b.status, 'FAILED');
  assert.match(b.detail, /paper_exchange unreachable/);
  assert.deepEqual([...feedDown.execution.calls, ...accountDown.execution.calls], []);
});

test('a peer symbol with no data narrows the universe but does not stop the event symbol', async () => {
  const r = rig();
  r.marketData.failFor.add('ETHUSDT');
  assert.equal((await r.process(r.eventFor('BTCUSDT'))).status, 'EXECUTED');
});

test('a snapshot that does not end at the triggering bar is refused', async () => {
  const r = rig();
  const future: Candle = { ...r.series.BTCUSDT.at(-1)!, openTime: r.series.BTCUSDT.at(-1)!.openTime + 900_000 };
  const outcome = await r.process(barClosedEvent('BTCUSDT', '15m', future));
  assert.equal(outcome.status, 'FAILED');
  assert.match(outcome.detail, /does not end at the triggering bar/);
  assert.deepEqual(r.execution.calls, []);
});

test('a stale mark is refused by the risk pipeline', async () => {
  const r = rig();
  r.marketData.markLagMs = 5 * 60_000;
  const outcome = await r.process(r.eventFor('BTCUSDT'));
  assert.equal(outcome.status, 'REJECTED');
  assert.equal(outcome.detail, 'MARK_STALE');
});

test('a strategy is added and removed at the registry; the engine is not touched', async () => {
  const r = rig({ strategies: [] });
  assert.equal((await r.process(r.eventFor('BTCUSDT', -3))).status, 'NO_SIGNAL');
  const added = new AlwaysLong('added-later');
  r.pipeline.registry.register(added);
  const executed = await r.process(r.eventFor('BTCUSDT', -2));
  assert.equal(executed.status, 'EXECUTED');
  assert.equal(r.execution.submitted[0].strategyId, 'added-later');
  r.pipeline.registry.unregister('added-later');
  assert.equal((await r.process(r.eventFor('BTCUSDT'))).status, 'NO_SIGNAL');
  assert.equal(added.evaluations, 1);
});

test('a strategy that throws is recorded and the others still trade', async () => {
  const broken: Strategy = { id: 'broken', version: '1.0.0', parameters: {}, requirements: new AlwaysLong().requirements, evaluate: () => { throw new Error('bad maths'); } };
  const r = rig({ strategies: [broken, new AlwaysLong()] });
  assert.equal((await r.process(r.eventFor('BTCUSDT'))).status, 'EXECUTED');
  const failed = r.repository.events.find((e) => e.type === 'strategy.failed');
  assert.ok(failed?.type === 'strategy.failed' && failed.strategyId === 'broken' && failed.error === 'bad maths');
});

test('session and breaker state are handed to the persistence hook after every cycle', async () => {
  const saved: unknown[] = [];
  const r = rig({ onCycleEnd: (state) => saved.push(state) });
  await r.process(r.eventFor('BTCUSDT'));
  assert.equal(saved.length, 1);
  const state = saved[0] as { session: { peakEquity: number }; breaker: { state: string } };
  assert.equal(state.session.peakEquity, 10_000);
  assert.equal(state.breaker.state, 'ARMED');
});

test('a journal subscriber that throws cannot stop or alter execution', async () => {
  const r = rig();
  r.pipeline.bus.subscribe(() => { throw new Error('disk full'); });
  assert.equal((await r.process(r.eventFor('BTCUSDT'))).status, 'EXECUTED');
  assert.equal(r.pipeline.bus.listenerFailures, 6);
});

test('the pipeline refuses an execution port that is not the paper venue', () => {
  const impostor = Object.assign(new FakeExecution(), { venue: 'binance' });
  assert.throws(() => rig({ execution: impostor as unknown as FakeExecution }), /paper_exchange only/);
});

test('a position this process does not own blocks every entry, and nothing is sent', async () => {
  const r = rig();
  r.execution.openSlot('ETHUSDT', 0.4, 7);
  const outcome = await r.process(r.eventFor('BTCUSDT'));
  assert.equal(outcome.status, 'REJECTED');
  assert.match(outcome.detail, /FOREIGN_POSITION/);
  assert.equal(r.execution.submitted.length, 0);
});

test('a venue-initiated close of an owned position is recorded on the next cycle, and its slot is not inherited', async () => {
  const series = { BTCUSDT: candlesFromCloses(flat(40, 100)), ETHUSDT: candlesFromCloses(flat(40, 50)) };
  const r = rig({ series });
  const btc = (i: number) => barClosedEvent('BTCUSDT', '15m', series.BTCUSDT[i]);
  const eth = (i: number) => barClosedEvent('ETHUSDT', '15m', series.ETHUSDT[i]);
  const first = await r.process(btc(30));
  const commandId = first.order!.commandId;
  assert.equal(r.ownership.get(commandId)?.state, 'OWNED');
  // A protection or a liquidation closes the slot without any request from this process
  r.execution.slots.delete('BTCUSDT');
  await r.process(eth(31));
  assert.equal(r.ownership.get(commandId)?.state, 'CLOSED');
  // Flat ETH, so the next ETH decision reaches the risk pipeline; someone else then opens the BTC slot.
  // It is foreign, and it is not attributed to the closed episode.
  r.execution.slots.delete('ETHUSDT');
  r.execution.openSlot('BTCUSDT', 0.2, 99);
  const after = await r.process(eth(32));
  assert.equal(after.status, 'REJECTED');
  assert.match(after.detail, /FOREIGN_POSITION/);
  assert.equal(r.ownership.get(commandId)?.state, 'CLOSED');
});

test('a queued fill is attributed on the next cycle, once the venue reports it', async () => {
  const r = rig();
  r.execution.submitScript = [{ venueOrderId: 'intent-1', status: 'QUEUED', filledQuantity: 0, averagePrice: null, protectionCarried: true }];
  const first = await r.process(r.eventFor('BTCUSDT'));
  const commandId = first.order!.commandId;
  assert.equal(r.ownership.get(commandId)?.state, 'INTENT');
  // The replay fills the order at the next open and reports it; the slot is open when the cycle reads it
  r.execution.findScript = [{ venueOrderId: 'intent-1', status: 'FILLED', filledQuantity: 0.5, averagePrice: null, protectionCarried: false }];
  r.execution.openSlot('BTCUSDT', 0.5, 1);
  const second = await r.process(r.eventFor('ETHUSDT'));
  assert.equal(r.ownership.get(commandId)?.state, 'OWNED');
  assert.notEqual(second.detail, 'FOREIGN_POSITION');
});
