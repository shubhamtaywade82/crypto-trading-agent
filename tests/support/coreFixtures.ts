import type { PlaceOrderCommand } from '../../src/core/domain/execution.js';
import { TIMEFRAME_MS, type Candle, type MarketSnapshot, type Timeframe } from '../../src/core/domain/market.js';
import type { PortfolioSnapshot, PositionView } from '../../src/core/domain/portfolio.js';
import type { RiskLimits } from '../../src/core/domain/risk.js';
import type { StrategySignal } from '../../src/core/domain/strategy.js';
import type { MarketDataPort, SnapshotRequest } from '../../src/core/ports/MarketDataPort.js';
import { MarketDataError } from '../../src/core/ports/MarketDataPort.js';
import type { PaperExecutionPort, VenueOrderAck } from '../../src/core/ports/PaperExecutionPort.js';
import type { AccountView, PortfolioPort } from '../../src/core/ports/PortfolioPort.js';

export const T0 = Date.UTC(2026, 0, 5);

export const LIMITS: RiskLimits = Object.freeze({
  allowedSymbols: ['BTCUSDT', 'ETHUSDT', 'SOLUSDT', 'XRPUSDT'],
  riskPerTradePct: 1,
  maxLeverage: 10,
  maxConcurrentPositions: 2,
  maxGrossExposurePct: 800,
  maxDailyLossPct: 3,
  maxDrawdownPct: 5,
  maxLossStreak: 4,
  minRewardRisk: 1,
  maxMarkAgeMs: 60_000,
  costRatePerLeg: 0.0006,
  minNotional: 10,
  quantityStep: 0.001,
});

/** Candles from a list of closes: each bar opens at the previous close, with a fixed wick either side. */
export function candlesFromCloses(closes: readonly number[], timeframe: Timeframe = '15m', start = T0, wick = 0.5): Candle[] {
  return closes.map((close, i) => {
    const open = i === 0 ? close : closes[i - 1];
    return { openTime: start + i * TIMEFRAME_MS[timeframe], open, high: Math.max(open, close) + wick, low: Math.min(open, close) - wick, close, volume: 100 };
  });
}

export const flat = (n: number, price: number): number[] => Array.from({ length: n }, () => price);
export const ramp = (n: number, from: number, step: number): number[] => Array.from({ length: n }, (_, i) => from + i * step);

export function snapshotOf(symbol: string, candles: readonly Candle[], timeframe: Timeframe = '15m', overrides: Partial<MarketSnapshot> = {}): MarketSnapshot {
  const last = candles[candles.length - 1];
  const asOf = last.openTime + TIMEFRAME_MS[timeframe];
  return { symbol, asOf, candles: { [timeframe]: candles }, markPrice: last.close, markAt: asOf, fundingRate: 0.0001, openInterest: 1000, ...overrides };
}

export function portfolioOf(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return { asOf: T0, equity: 10_000, availableMargin: 10_000, positions: [], dayStartEquity: 10_000, peakEquity: 10_000, lossStreak: 0, ...overrides };
}

export const positionOf = (symbol: string, overrides: Partial<PositionView> = {}): PositionView =>
  ({ symbol, direction: 'LONG', quantity: 0.01, entryPrice: 100, markPrice: 100, leverage: 2, unrealizedPnl: 0, stopLoss: 95, ...overrides });

export const signalOf = (overrides: Partial<StrategySignal> = {}): StrategySignal => ({
  strategyId: 'test-strategy', strategyVersion: '1.0.0', symbol: 'BTCUSDT', direction: 'LONG', entry: 100, stopLoss: 98, takeProfit: 106,
  confidence: 0.7, reason: 'test', barTime: T0, ...overrides,
});

/** Market data served from per-symbol candle arrays; only bars closed at `asOf` are returned, like the real adapter. */
export class FakeMarketData implements MarketDataPort {
  readonly requests: SnapshotRequest[] = [];
  failFor = new Set<string>();
  /** Offset applied to the snapshot's markAt relative to asOf. */
  markLagMs = 0;

  constructor(private readonly series: Record<string, Candle[]>, private readonly timeframe: Timeframe = '15m') {}

  async getSnapshot(request: SnapshotRequest): Promise<MarketSnapshot> {
    this.requests.push(request);
    if (this.failFor.has(request.symbol)) throw new MarketDataError(`${request.symbol}: feed down`);
    const frame = TIMEFRAME_MS[this.timeframe];
    const closed = (this.series[request.symbol] ?? []).filter((c) => c.openTime + frame <= request.asOf).slice(-request.bars);
    const last = closed.at(-1);
    if (!last) throw new MarketDataError(`${request.symbol}: no bars`);
    return { symbol: request.symbol, asOf: request.asOf, candles: { [this.timeframe]: closed }, markPrice: last.close, markAt: request.asOf - this.markLagMs, fundingRate: 0.0001, openInterest: null };
  }
}

export class FakePortfolio implements PortfolioPort {
  account: Omit<AccountView, 'asOf'> = { equity: 10_000, availableMargin: 10_000, realizedPnl: 0, positions: [] };
  calls = 0;
  fail: Error | null = null;

  async getAccount(asOf: number): Promise<AccountView> {
    this.calls += 1;
    if (this.fail) throw this.fail;
    return { asOf, ...this.account };
  }
}

type Scripted<T> = T | Error | (() => T | Promise<T>);

/** A paper venue whose answers are scripted per call; the last script entry repeats. Records every call in order. */
export class FakeExecution implements PaperExecutionPort {
  readonly venue = 'paper_exchange' as const;
  readonly calls: string[] = [];
  readonly submitted: PlaceOrderCommand[] = [];
  submitScript: Scripted<VenueOrderAck>[] = [];
  findScript: Scripted<VenueOrderAck | null>[] = [null];
  protectScript: Scripted<void>[] = [undefined];
  flattenScript: Scripted<void>[] = [undefined];
  /** When set, every call waits on it; lets a test hold an order in flight. */
  gate: Promise<void> | null = null;

  static filled(quantity = 1): VenueOrderAck {
    return { venueOrderId: 'v-1', status: 'FILLED', filledQuantity: quantity, averagePrice: null, protectionCarried: false };
  }

  private async play<T>(script: Scripted<T>[]): Promise<T> {
    if (this.gate) await this.gate;
    const next = script.length > 1 ? script.shift()! : script[0];
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? (next as () => T | Promise<T>)() : next;
  }

  async submitOrder(command: PlaceOrderCommand): Promise<VenueOrderAck> {
    this.calls.push('submitOrder');
    this.submitted.push(command);
    if (this.submitScript.length === 0) return FakeExecution.filled(command.quantity);
    return this.play(this.submitScript);
  }

  async findOrder(): Promise<VenueOrderAck | null> {
    this.calls.push('findOrder');
    return this.play(this.findScript);
  }

  async protect(): Promise<void> {
    this.calls.push('protect');
    return this.play(this.protectScript);
  }

  async flatten(): Promise<void> {
    this.calls.push('flatten');
    return this.play(this.flattenScript);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// FakePaperExchange: an in-memory stand-in for the paper_exchange HTTP API, speaking the request and response shapes
// of its controllers (orders, positions, protections, mark prices, funding, backtest datasets and external runs).
// ---------------------------------------------------------------------------------------------------------------

interface FakePosition {
  id: number; symbol: string; side: 'long' | 'short'; quantity: number; avgPrice: number; leverage: number;
  stop?: number; target?: number; entryAt?: string; entryBar?: number; entryFee?: number;
}

interface FakeRun {
  id: number; accountId: string; symbol: string; bars: Array<{ bar_at: string; open: number; high: number; low: number; close: number; volume: number }>;
  cursor: number; cash: number; initial: number; slippageBps: number; position: FakePosition | null; realized: number;
  intents: Array<Record<string, any>>; trades: Array<Record<string, any>>; equity: Array<{ at: string; equity: number; in_market: boolean }>;
  finished: boolean; manifest: unknown; lotSize: number; leverage: number;
}

export interface FakeRequest {
  method: string;
  path: string;
  accountId: string | undefined;
  apiKey: string | undefined;
  body: any;
}

const FEE_RATE = 0.0004;

export class FakePaperExchange {
  readonly requests: FakeRequest[] = [];
  readonly live = {
    account: { equity: 10_000, available: 10_000, realized: 0 } as { equity: number; available: number; realized: number } | null,
    positions: [] as FakePosition[],
    orders: [] as Array<Record<string, any>>,
    protections: new Map<number, Array<Record<string, any>>>(),
    marks: [] as Array<Record<string, number>>,
    funding: [] as Array<Record<string, any>>,
  };
  readonly runs = new Map<number, FakeRun>();
  private readonly datasets = new Map<number, { symbol: string; timeframe: string; bars: FakeRun['bars'] }>();
  private nextId = 1;
  /** One-shot failures: the first request whose "METHOD path" matches is answered with the status, or throws. */
  private readonly failures: Array<{ match: RegExp; outcome: number | Error }> = [];

  failNext(match: RegExp, outcome: number | Error): void {
    this.failures.push({ match, outcome });
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const request: FakeRequest = { method, path: url.pathname, accountId: headers['X-Account-Id'], apiKey: headers['X-API-Key'], body: init?.body ? JSON.parse(String(init.body)) : undefined };
    this.requests.push(request);
    const failure = this.failures.findIndex((f) => f.match.test(`${method} ${url.pathname}`));
    if (failure >= 0) {
      const [{ outcome }] = this.failures.splice(failure, 1);
      if (outcome instanceof Error) throw outcome;
      return new Response(JSON.stringify({ error: 'injected failure' }), { status: outcome });
    }
    const [status, payload] = this.route(request);
    return new Response(payload === undefined ? '' : JSON.stringify(payload), { status });
  };

  count(method: string, path: RegExp): number {
    return this.requests.filter((r) => r.method === method && path.test(r.path)).length;
  }

  private route(req: FakeRequest): [number, unknown] {
    const run = [...this.runs.values()].find((r) => r.accountId === req.accountId);
    const { method, path, body } = req;
    let m: RegExpExecArray | null;
    if (method === 'GET' && path === '/api/account') return run ? [200, this.replayAccount(run)] : this.liveAccount();
    if (method === 'GET' && path === '/api/positions') return [200, this.live.positions.map((p) => this.positionJson(p))];
    if (method === 'GET' && path === '/api/orders') return [200, { data: [...this.live.orders].reverse(), next_cursor: null }];
    if (method === 'POST' && path === '/api/orders') return run ? this.queueIntent(run, body.order) : this.liveOrder(body.order);
    if ((m = /^\/api\/positions\/(\d+)\/protections$/.exec(path))) {
      const id = Number(m[1]);
      if (!this.live.positions.some((p) => p.id === id)) return [404, { error: 'Position not found' }];
      const list = this.live.protections.get(id) ?? [];
      if (method === 'GET') return [200, list];
      const protection = { id: this.nextId++, position_id: id, status: 'active', ...body.protection };
      this.live.protections.set(id, [...list, protection]);
      return [201, protection];
    }
    if (method === 'POST' && path === '/api/mark_prices') {
      if (run) return [422, { error: 'mark prices writes global market state' }];
      this.live.marks.push(body.prices);
      for (const p of this.live.positions) if (body.prices[p.symbol]) (p as any).mark = body.prices[p.symbol];
      return [200, { ok: true }];
    }
    if (method === 'POST' && path === '/api/funding_events') {
      this.live.funding.push(body);
      return [200, { ok: true }];
    }
    if (method === 'POST' && path === '/api/backtest_datasets') {
      const id = this.nextId++;
      this.datasets.set(id, { symbol: body.symbol, timeframe: body.timeframe, bars: body.bars });
      return [201, { id, bars_count: body.bars.length }];
    }
    if (method === 'POST' && path === '/api/backtest_runs') {
      const dataset = this.datasets.get(body.dataset_id);
      if (!dataset) return [422, { error: 'invalid backtest run', details: ['dataset does not exist'] }];
      if (body.mode !== 'external' || body.strategy) return [422, { error: 'invalid backtest run' }];
      const id = this.nextId++;
      const created: FakeRun = {
        id, accountId: `bt-run-${id}`, symbol: dataset.symbol, bars: dataset.bars, cursor: 0, cash: body.initial_capital, initial: body.initial_capital,
        slippageBps: body.slippage_bps, position: null, realized: 0, intents: [], trades: [], equity: [], finished: false, manifest: body.manifest,
        lotSize: body.lot_size, leverage: body.leverage,
      };
      this.runs.set(id, created);
      return [201, this.runJson(created)];
    }
    if ((m = /^\/api\/backtest_runs\/(\d+)\/(advance|finish|trades|equity|intents)$/.exec(path))) {
      const target = this.runs.get(Number(m[1]));
      if (!target) return [404, { error: 'Backtest run not found' }];
      switch (m[2]) {
        case 'advance': return this.advance(target);
        case 'finish':
          if (target.finished) return [409, { error: 'run is already finished' }];
          target.finished = true;
          return [200, this.runJson(target)];
        case 'trades': return [200, { data: target.trades, next_cursor: null }];
        case 'equity': return [200, { data: target.equity }];
        default: return [200, { data: target.intents, next_cursor: null }];
      }
    }
    return [404, { error: `no route for ${method} ${path}` }];
  }

  // --- live paper account ---------------------------------------------------------------------------------------

  private liveAccount(): [number, unknown] {
    const a = this.live.account;
    if (!a) return [404, { error: 'Account not found' }];
    return [200, {
      account_id: 'acct', currency: 'USDT', margin: a.equity, available_balance: a.available, locked_margin: a.equity - a.available,
      equity: a.equity, unrealized_pnl: 0, realized_pnl: a.realized, positions_count: this.live.positions.length,
    }];
  }

  private positionJson(p: FakePosition) {
    return {
      id: p.id, symbol: p.symbol, side: p.side, net_quantity: p.quantity, average_price: p.avgPrice, current_price: (p as any).mark ?? p.avgPrice,
      leverage: p.leverage, margin_type: 'isolated', liquidation_price: null, unrealized_pnl: 0,
    };
  }

  private liveOrder(order: Record<string, any>): [number, unknown] {
    const existing = this.live.orders.find((o) => o.client_order_id === order.client_order_id);
    if (existing) return [201, existing];
    if (order.stop_loss !== undefined || order.take_profit !== undefined) return [422, { error: 'stop_loss/take_profit on an order are set on backtest replay accounts' }];
    if (!(order.execution_price > 0)) return [422, { error: 'execution_price is required' }];
    const held = this.live.positions.find((p) => p.symbol === order.symbol);
    if (order.reduce_only) {
      if (!held) return [422, { error: 'reduce_only order has no position to reduce' }];
      this.live.positions.splice(this.live.positions.indexOf(held), 1);
    } else {
      this.live.positions.push({ id: this.nextId++, symbol: order.symbol, side: order.side === 'buy' ? 'long' : 'short', quantity: order.quantity, avgPrice: order.execution_price, leverage: order.leverage });
    }
    const row = { id: this.nextId++, client_order_id: order.client_order_id, symbol: order.symbol, side: order.side, status: 'filled', quantity: order.quantity, filled_quantity: order.quantity };
    this.live.orders.push(row);
    return [201, row];
  }

  // --- external backtest replay ---------------------------------------------------------------------------------

  private runJson(run: FakeRun) {
    return { id: run.id, status: run.finished ? 'completed' : 'pending', account_id: run.accountId, bars_processed: run.cursor, metrics: run.finished ? { total_trades: run.trades.length } : null, verdict: null, failure_reason: null, manifest: run.manifest };
  }

  private replayAccount(run: FakeRun) {
    const margin = run.position ? (run.position.quantity * run.position.avgPrice) / run.position.leverage : 0;
    return {
      account_id: run.accountId, currency: 'USDT', margin: run.cash, available_balance: run.cash - margin, locked_margin: margin,
      equity: run.equity.at(-1)?.equity ?? run.initial, unrealized_pnl: 0, realized_pnl: run.realized, positions_count: run.position ? 1 : 0,
    };
  }

  private queueIntent(run: FakeRun, order: Record<string, any>): [number, unknown] {
    if (run.finished) return [409, { error: 'run is finished' }];
    if (order.execution_price !== undefined) return [422, { error: "execution_price is not accepted on a replay account: fills happen at the next bar's open, plus slippage_bps" }];
    if (run.intents.some((i) => i.client_order_id === order.client_order_id)) return [422, { error: 'client_order_id is already used in this run' }];
    const intent = { id: this.nextId++, status: 'queued', client_order_id: order.client_order_id, side: order.side, quantity: order.quantity, reduce_only: Boolean(order.reduce_only), stop_loss: order.stop_loss, take_profit: order.take_profit, leverage: order.leverage };
    run.intents.push(intent);
    return [202, intent];
  }

  private advance(run: FakeRun): [number, unknown] {
    if (run.finished || run.cursor >= run.bars.length) return [409, { error: 'no bar after the replay position; the run is finished' }];
    const index = run.cursor;
    const bar = run.bars[index];
    const fills: Array<Record<string, any>> = [];
    const slip = run.slippageBps / 10_000;
    const close = (price: number, reason: string) => {
      const p = run.position!;
      const fee = price * p.quantity * FEE_RATE;
      const gross = (price - p.avgPrice) * p.quantity * (p.side === 'long' ? 1 : -1);
      const net = gross - fee - (p.entryFee ?? 0);
      run.cash += gross - fee;
      run.realized += net;
      run.trades.push({
        direction: p.side, quantity: p.quantity, entry_at: p.entryAt, entry_price: p.avgPrice, exit_at: bar.bar_at, exit_price: price,
        net_pnl: net, commission: fee + (p.entryFee ?? 0), bars_held: index - (p.entryBar ?? index), exit_reason: reason,
      });
      fills.push({ paper_order_id: this.nextId++, side: p.side === 'long' ? 'sell' : 'buy', quantity: p.quantity, price, commission: fee, role: 'exit', reason });
      run.position = null;
    };

    // 1. queued intents execute at this bar's open
    for (const intent of run.intents.filter((i) => i.status === 'queued')) {
      intent.status = 'submitted';
      if (intent.reduce_only) {
        if (run.position) close(bar.open, 'api');
        continue;
      }
      if (run.position) continue;
      const price = bar.open * (intent.side === 'buy' ? 1 + slip : 1 - slip);
      const fee = price * intent.quantity * FEE_RATE;
      run.cash -= fee;
      run.position = { id: this.nextId++, symbol: run.symbol, side: intent.side === 'buy' ? 'long' : 'short', quantity: intent.quantity, avgPrice: price, leverage: intent.leverage, stop: intent.stop_loss, target: intent.take_profit, entryAt: bar.bar_at, entryBar: index, entryFee: fee };
      fills.push({ paper_order_id: this.nextId++, side: intent.side, quantity: intent.quantity, price, commission: fee, role: 'entry', reason: null });
    }
    // 2. resting protection resolves against the bar; the stop is checked first, which is the conservative order
    const p = run.position;
    if (p?.stop !== undefined && p.target !== undefined) {
      const long = p.side === 'long';
      if (long ? bar.low <= p.stop : bar.high >= p.stop) close(long ? Math.min(bar.open, p.stop) : Math.max(bar.open, p.stop), 'stop_loss');
      else if (long ? bar.high >= p.target : bar.low <= p.target) close(p.target, 'take_profit');
    }
    // 3. the close is the mark
    const open = run.position;
    const unrealized = open ? (bar.close - open.avgPrice) * open.quantity * (open.side === 'long' ? 1 : -1) : 0;
    const equity = run.cash + unrealized;
    run.equity.push({ at: bar.bar_at, equity, in_market: open !== null });
    run.cursor += 1;
    const finished = run.cursor >= run.bars.length;
    if (finished) run.finished = true;
    return [200, {
      bar, bars_processed: run.cursor, equity, in_market: open !== null,
      position: open ? { side: open.side, quantity: open.quantity, avg_price: open.avgPrice, unrealized_pnl: unrealized } : null,
      submitted: [], fills, finished, verdict: null,
    }];
  }
}
