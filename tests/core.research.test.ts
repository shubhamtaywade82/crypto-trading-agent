import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import type { BinancePublicSource } from '../src/core/adapters/binance/BinanceMarketDataAdapter.js';
import { buildPaperTradingApplication } from '../src/core/composition/buildPaperTradingApplication.js';
import { validatePaperOnlyConfig } from '../src/core/composition/validatePaperOnlyConfig.js';
import { barClosedEvent, type Candle } from '../src/core/domain/market.js';
import type { ExperimentConfig } from '../src/core/research/ExperimentRunner.js';
import { barsDefect } from '../src/core/research/ExperimentRunner.js';
import { analyzePerformance, maxDrawdownPct, sharpeRatio } from '../src/core/research/PerformanceAnalyzer.js';
import { RangeBreakoutStrategy } from '../src/core/strategies/index.js';
import { candlesFromCloses, FakeLease, FakePaperExchange, ramp, T0 } from './support/coreFixtures.js';

const FRAME = 900_000;
const range = (n: number, mid: number): number[] => Array.from({ length: n }, (_, i) => mid + (i % 2 === 0 ? 0.3 : -0.3));
/** A range, an upside breakout that runs to its target, a second range, then a breakout that fails and stops out. */
const CLOSES = [...range(40, 100), 103, ...ramp(14, 104, 1), ...range(40, 117), 120, 119, 117.5, 116, 115, ...range(10, 115)];
const BARS = candlesFromCloses(CLOSES);

function app(options: { env?: Record<string, string>; series?: Record<string, Candle[]>; now?: () => number; lease?: FakeLease } = {}) {
  const dir = mkdtempSync(path.join(tmpdir(), 'paper-core-'));
  const server = new FakePaperExchange();
  const lease = options.lease ?? new FakeLease();
  const series = options.series ?? {};
  const binanceSource: BinancePublicSource = {
    klines: async (symbol, _interval, o) => (series[symbol] ?? []).filter((c) => (o.endTime === undefined || c.openTime <= o.endTime) && (o.startTime === undefined || c.openTime >= o.startTime)).slice(-(o.limit ?? 500)),
    premiumIndex: async (symbol) => ({ markPrice: series[symbol]?.at(-1)?.close ?? 0, lastFundingRate: 0.0001, nextFundingTime: T0 + 8 * 3_600_000, time: (options.now ?? (() => T0))() }),
    openInterest: async () => ({ openInterest: 1 }),
  };
  const config = validatePaperOnlyConfig({
    PAPER_EXCHANGE_URL: 'http://paper.test', PAPER_EXCHANGE_ACCOUNT_ID: 'acct', SYMBOLS: 'BTCUSDT,ETHUSDT',
    PAPER_CORE_STRATEGIES: 'range-breakout', PAPER_CORE_STRATEGY_PARAMS: JSON.stringify({ 'range-breakout': { timeframe: '15m', rangeBars: 10, atrPeriod: 5 } }),
    PAPER_CORE_JOURNAL: path.join(dir, 'events.jsonl'), PAPER_CORE_STATE: path.join(dir, 'state.json'), PAPER_CORE_KILL_FILE: path.join(dir, 'KILL'),
    PAPER_CORE_OWNERSHIP: path.join(dir, 'ownership.jsonl'),
    ...options.env,
  });
  const logs: string[] = [];
  const built = buildPaperTradingApplication(config, {
    fetchImpl: server.fetch, binanceSource, lease, log: (line) => logs.push(line), ...(options.now ? { clock: { now: options.now } } : {}),
  });
  return { app: built, server, config, logs, dir, lease };
}

const experiment = (overrides: Partial<ExperimentConfig> = {}): ExperimentConfig => ({
  name: 'breakout study', symbol: 'BTCUSDT', timeframe: '15m', bars: BARS,
  strategies: [new RangeBreakoutStrategy({ timeframe: '15m', rangeBars: 10, atrPeriod: 5 })],
  limits: { ...validatePaperOnlyConfig({ PAPER_EXCHANGE_URL: 'http://x', PAPER_EXCHANGE_ACCOUNT_ID: 'a' }).limits, allowedSymbols: ['BTCUSDT'] },
  initialCapital: 10_000, slippageBps: 5, ...overrides,
});

test('research replays through PaperExchange: orders queue, fill at the next bar open with slippage, and carry their stop', async () => {
  const { app: a, server } = app();
  const result = await a.runResearch(experiment());
  const run = [...server.runs.values()][0];
  const orders = server.requests.filter((r) => r.method === 'POST' && r.path === '/api/orders');

  assert.equal(result.barsProcessed, BARS.length);
  assert.equal(result.performance.trades, 2);
  assert.ok(orders.length >= 2);
  for (const { body, accountId } of orders) {
    // The replay sets the fill price: an order must not carry one, and it must carry its protection
    assert.ok(!('execution_price' in body.order));
    assert.ok(body.order.stop_loss > 0 && body.order.take_profit > 0);
    assert.equal(accountId, run.accountId);
  }
  // The breakout closed on bar 40; the entry filled at bar 41's open, plus 5 bps
  const [first, second] = run.trades;
  assert.equal(first.entry_at, new Date(BARS[41].openTime).toISOString());
  assert.ok(Math.abs(first.entry_price - BARS[41].open * 1.0005) < 1e-9);
  assert.equal(first.exit_reason, 'take_profit');
  assert.ok(first.net_pnl > 0);
  assert.equal(second.exit_reason, 'stop_loss');
  assert.ok(second.net_pnl < 0);

  assert.deepEqual([result.performance.wins, result.performance.losses, result.performance.winRate], [1, 1, 0.5]);
  assert.ok(Math.abs(result.performance.netPnl - (first.net_pnl + second.net_pnl)) < 1e-9);
  assert.ok(result.performance.maxDrawdownPct > 0);
  assert.equal(result.cycles.FAILED, 0);
  assert.ok(result.cycles.EXECUTED >= 2);
  assert.deepEqual(result.venueMetrics, null); // the run finished on its last bar; the venue was not asked again
});

test('every revealed bar was requested one at a time, and no decision saw a bar the venue had not revealed', async () => {
  const { app: a, server } = app();
  const result = await a.runResearch(experiment());
  assert.equal(server.count('POST', /\/advance$/), BARS.length);
  // Each proposal's signal bar is the bar that had just been revealed when it was made
  const proposals = result.events.filter((e) => e.type === 'decision.proposed');
  assert.ok(proposals.length >= 2);
  for (const event of proposals) {
    assert.ok(event.type === 'decision.proposed');
    assert.equal(event.causeEventId, `BTCUSDT:15m:${event.proposal.signal.barTime}`);
    assert.equal(event.at, event.proposal.signal.barTime + FRAME); // replay time is the bar's close
  }
});

test('the same experiment yields the same decisions, digest and performance', async () => {
  const one = await app().app.runResearch(experiment());
  const two = await app().app.runResearch(experiment());
  assert.equal(one.decisionDigest, two.decisionDigest);
  assert.deepEqual(one.performance, two.performance);
  assert.deepEqual(one.manifest, two.manifest);
  assert.match(one.decisionDigest, /^[0-9a-f]{64}$/);
  // A different parameter set is a different experiment
  const other = await app().app.runResearch(experiment({ strategies: [new RangeBreakoutStrategy({ timeframe: '15m', rangeBars: 10, atrPeriod: 5, stopAtr: 1 })] }));
  assert.notEqual(other.decisionDigest, one.decisionDigest);
});

test('the manifest records what was tested and is stored with the run at the venue', async () => {
  const { app: a, server } = app();
  const result = await a.runResearch(experiment());
  assert.deepEqual(result.manifest.strategies, [{ id: 'range-breakout', version: '1.0.0', parameters: { timeframe: '15m', rangeBars: 10, atrPeriod: 5, stopAtr: 2, targetAtr: 4, allowShort: true } }]);
  assert.deepEqual([result.manifest.bars, result.manifest.firstBarAt, result.manifest.lastBarAt], [BARS.length, BARS[0].openTime, BARS.at(-1)!.openTime]);
  assert.match(result.manifest.dataHash, /^[0-9a-f]{64}$/);
  const run = [...server.runs.values()][0];
  assert.deepEqual(run.manifest, JSON.parse(JSON.stringify(result.manifest)));
  assert.deepEqual([run.initial, run.slippageBps, run.lotSize, run.leverage], [10_000, 5, 0.001, 10]);
});

test('a lost advance stops the experiment; it is never repeated', async () => {
  const { app: a, server } = app();
  server.failNext(/POST \/api\/backtest_runs\/\d+\/advance/, 503);
  await assert.rejects(() => a.runResearch(experiment()), /advance/);
  assert.equal(server.count('POST', /\/advance$/), 1);
});

test('untrustworthy data and mismatched strategies are refused before anything is sent', async () => {
  const { app: a, server } = app();
  const gapped = BARS.filter((_, i) => i !== 20);
  await assert.rejects(() => a.runResearch(experiment({ bars: gapped })), /are not consecutive 15m bars/);
  await assert.rejects(() => a.runResearch(experiment({ bars: [] })), /no bars/);
  await assert.rejects(() => a.runResearch(experiment({ bars: BARS.map((b, i) => (i === 5 ? { ...b, low: -1 } : b)) })), /low is not a positive finite number/);
  await assert.rejects(() => a.runResearch(experiment({ strategies: [] })), /no strategies/);
  await assert.rejects(() => a.runResearch(experiment({ strategies: [new RangeBreakoutStrategy({ timeframe: '1h' })] })), /strategies not on 15m: range-breakout/);
  assert.equal(server.requests.length, 0);
  assert.equal(barsDefect(BARS, '15m'), null);
});

test('folds run the same strategy over consecutive periods from a fresh account each', async () => {
  const { app: a, server } = app();
  const folds = await a.experiments.runFolds(experiment(), 2);
  assert.equal(folds.length, 2);
  assert.equal(server.runs.size, 2);
  assert.equal(folds[0].manifest.bars + folds[1].manifest.bars, BARS.length);
  assert.equal(folds[0].manifest.lastBarAt + FRAME, folds[1].manifest.firstBarAt);
  assert.deepEqual(folds.map((f) => f.performance.trades), [1, 1]);
  await assert.rejects(() => a.experiments.runFolds(experiment(), 50), /cannot split/);
});

test('performance statistics are computed from the venue\'s trades and equity, with nulls where undefined', () => {
  const trade = (netPnl: number, barsHeld = 4) => ({ direction: 'LONG' as const, quantity: 1, entryAt: 0, entryPrice: 100, exitAt: 1, exitPrice: 100 + netPnl, netPnl, commission: 0.1, barsHeld, exitReason: null });
  const report = analyzePerformance([trade(30), trade(-10), trade(20), trade(-20)], [10_030, 10_020, 10_040, 10_020].map((equity) => ({ equity })), 10_000, '15m');
  assert.deepEqual([report.trades, report.wins, report.losses, report.winRate], [4, 2, 2, 0.5]);
  assert.deepEqual([report.netPnl, report.expectancy, report.averageWin, report.averageLoss, report.profitFactor], [20, 5, 25, -15, 50 / 30]);
  assert.ok(Math.abs(report.returnPct - 0.2) < 1e-9);
  assert.ok(Math.abs(report.maxDrawdownPct - (20 / 10_040) * 100) < 1e-9);
  assert.ok(Math.abs(report.commission - 0.4) < 1e-12);
  assert.equal(report.averageBarsHeld, 4);
  assert.ok(report.sharpe !== null && report.sharpe > 0);

  const empty = analyzePerformance([], [], 10_000, '15m');
  assert.deepEqual([empty.trades, empty.winRate, empty.expectancy, empty.profitFactor, empty.sharpe, empty.maxDrawdownPct, empty.returnPct], [0, null, null, null, null, 0, 0]);
  assert.equal(analyzePerformance([trade(5)], [{ equity: 10_005 }], 10_000, '15m').profitFactor, null); // no losing trade
  assert.equal(maxDrawdownPct([100, 120, 90, 130]), 25);
  assert.equal(sharpeRatio([100, 100, 100], '1h'), null);
});

test('paper trading end to end: a breakout bar becomes a protected PaperExchange position, journalled and persisted', async (t) => {
  const closes = [...range(40, 100), 103];
  const series = { BTCUSDT: candlesFromCloses(closes), ETHUSDT: candlesFromCloses(range(41, 50)) };
  const closedAt = series.BTCUSDT.at(-1)!.openTime + FRAME;
  const { app: a, server, config, logs } = app({ series, now: () => closedAt + 1500 });
  // Trading writes need the account's lease, which production takes at start(). The keeper's renewal loop stops with the test.
  await a.leaseKeeper.start();
  t.after(() => a.leaseKeeper.stop());

  const outcome = await a.processMarketEvent(barClosedEvent('BTCUSDT', '15m', series.BTCUSDT.at(-1)!));
  assert.equal(outcome.status, 'EXECUTED');
  assert.equal(outcome.order?.state, 'FILLED');
  assert.equal(outcome.order?.protection, 'ATTACHED');

  const [position] = server.live.positions;
  assert.deepEqual([position.symbol, position.side, position.avgPrice], ['BTCUSDT', 'long', 103]);
  const protections = server.live.protections.get(position.id)!;
  assert.deepEqual(protections.map((p) => p.protection_type), ['stop_loss', 'take_profit']);
  assert.ok(protections[0].trigger_price < 103 && protections[1].trigger_price > 103);
  // Every request went to the paper broker; nothing else was contacted
  assert.ok(server.requests.every((r) => r.accountId === 'acct'));

  const journal = readFileSync(config.journalPath, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(journal.map((e) => e.type), ['market.bar.closed', 'strategy.signals', 'decision.proposed', 'risk.trade.approved', 'order.command.created', 'order.state.changed']);
  assert.equal(JSON.parse(readFileSync(config.statePath, 'utf8')).breaker.state, 'ARMED');
  assert.ok(logs.some((line) => line.startsWith('[order]') && line.includes('FILLED')));
  assert.ok(logs.some((line) => line.startsWith('[venue] submitOrder BTCUSDT')));
  assert.ok(a.metrics.calls >= 2);
});

test('paper trading: the kill file refuses entries, and a tripped breaker survives a restart', async () => {
  const closes = [...range(40, 100), 103];
  const series = { BTCUSDT: candlesFromCloses(closes), ETHUSDT: candlesFromCloses(range(41, 50)) };
  const closedAt = series.BTCUSDT.at(-1)!.openTime + FRAME;
  const event = barClosedEvent('BTCUSDT', '15m', series.BTCUSDT.at(-1)!);

  const killed = app({ series, now: () => closedAt + 1500 });
  writeFileSync(killed.config.killFile, 'stop');
  const refused = await killed.app.processMarketEvent(event);
  assert.deepEqual([refused.status, refused.detail], ['REJECTED', 'TRADING_HALTED']);
  assert.equal(killed.server.live.positions.length, 0);

  const first = app({ series, now: () => closedAt + 1500 });
  first.app.pipeline.breaker.trip('order outcome unknown', closedAt);
  await first.app.processMarketEvent(event);
  assert.ok(existsSync(first.config.statePath));
  const restarted = app({ series, now: () => closedAt + 1500, env: { PAPER_CORE_STATE: first.config.statePath, PAPER_CORE_JOURNAL: first.config.journalPath, PAPER_CORE_KILL_FILE: first.config.killFile } });
  assert.equal(restarted.app.pipeline.breaker.snapshot.state, 'TRIPPED');
  const afterRestart = await restarted.app.processMarketEvent(event);
  assert.deepEqual([afterRestart.status, afterRestart.detail], ['REJECTED', 'TRADING_HALTED']);
});

test('paper trading: start pushes marks to the broker and stop is clean', async () => {
  const series = { BTCUSDT: candlesFromCloses(range(41, 100)), ETHUSDT: candlesFromCloses(range(41, 50)) };
  const { app: a, server, logs } = app({ series });
  await a.start();
  await a.stop();
  assert.deepEqual(server.live.marks, [{ BTCUSDT: series.BTCUSDT.at(-1)!.close, ETHUSDT: series.ETHUSDT.at(-1)!.close }]);
  assert.match(logs[0], /^\[paper-core\] PAPER_ONLY on http:\/\/paper\.test account acct/);
});
