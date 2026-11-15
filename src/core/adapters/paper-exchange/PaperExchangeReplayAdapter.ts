import type { PlaceOrderCommand } from '../../domain/execution.js';
import { TIMEFRAME_MS, type Candle, type MarketSnapshot, type Timeframe } from '../../domain/market.js';
import { MarketDataError, type MarketDataPort, type SnapshotRequest } from '../../ports/MarketDataPort.js';
import { VenueRejectedError, type PaperExecutionPort, type VenueOrderAck } from '../../ports/PaperExecutionPort.js';
import type { AccountView, PortfolioPort } from '../../ports/PortfolioPort.js';
import type { ReplayFill, ReplaySessionPort, ReplaySpec, ReplayStep, ReplaySummary, ReplayTrade } from '../../ports/ReplaySessionPort.js';
import { translating, type PaperExchangeApi, type ReplayStepReply } from './PaperExchangeApi.js';

/** Builds a client bound to one account id. `retries` must be honoured: a replayed `advance` would skip a bar. */
export type PaperExchangeApiFactory = (accountId: string, options: { retries: number }) => PaperExchangeApi;

const FINISHED = /no bar after the replay position/;

/**
 * Drives one PaperExchange external backtest run. The broker owns the clock and the fills: each `advance` reveals one
 * bar, and an order placed after it executes at the NEXT bar's open plus the run's slippage. This adapter is the
 * market data, the portfolio and the execution of that run at once, and it can only ever show bars the broker has
 * already revealed.
 */
export class PaperExchangeReplayAdapter implements ReplaySessionPort, MarketDataPort, PortfolioPort, PaperExecutionPort {
  readonly venue = 'paper_exchange' as const;
  private run: { id: number; api: PaperExchangeApi; symbol: string; timeframe: Timeframe } | null = null;
  private readonly bars: Candle[] = [];
  private lastStep: ReplayStepReply | null = null;
  private initialCapital = 0;
  /** Stops of the entries sent in this run, so the position view can report its protection. */
  private readonly stops = new Map<string, number>();

  constructor(private readonly admin: PaperExchangeApi, private readonly factory: PaperExchangeApiFactory) {}

  async open(spec: ReplaySpec): Promise<void> {
    if (this.run) throw new Error('this replay adapter already has an open run');
    await translating(async () => {
      const dataset = await this.admin.createDataset({
        name: spec.name, symbol: spec.symbol, timeframe: spec.timeframe,
        bars: spec.bars.map((bar) => ({ bar_at: new Date(bar.openTime).toISOString(), open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: bar.volume })),
      });
      const created = await this.admin.createExternalRun({
        dataset_id: dataset.id, name: spec.name, initial_capital: spec.initialCapital, leverage: spec.leverage,
        slippage_bps: spec.slippageBps, lot_size: spec.lotSize, manifest: spec.manifest,
      });
      this.initialCapital = spec.initialCapital;
      // No retries on the run's own client: `advance` is not idempotent, and a lost answer must stop the run
      this.run = { id: created.id, api: this.factory(created.account_id, { retries: 0 }), symbol: spec.symbol, timeframe: spec.timeframe };
    });
  }

  async advance(): Promise<ReplayStep | null> {
    const run = this.requireRun();
    let reply: ReplayStepReply;
    try {
      reply = await translating(() => run.api.advanceRun(run.id));
    } catch (error) {
      if (error instanceof VenueRejectedError && FINISHED.test(error.message)) return null;
      throw error;
    }
    const bar: Candle = { openTime: Date.parse(reply.bar.bar_at), open: reply.bar.open, high: reply.bar.high, low: reply.bar.low, close: reply.bar.close, volume: reply.bar.volume };
    this.bars.push(bar);
    this.lastStep = reply;
    if (!reply.position) this.stops.delete(run.symbol);
    const fills: ReplayFill[] = reply.fills.map((f) => ({ side: f.side === 'buy' ? 'BUY' : 'SELL', quantity: f.quantity, price: f.price, commission: f.commission, role: f.role, reason: f.reason }));
    return { bar, equity: reply.equity, fills, finished: reply.finished };
  }

  async finish(): Promise<ReplaySummary> {
    const run = this.requireRun();
    return translating(async () => {
      // A run that consumed its last bar is already finished; asking again is a conflict, not a failure
      const reply = this.lastStep?.finished ? null : await run.api.finishRun(run.id).catch((error: unknown) => {
        if (error instanceof Error && /-> 409/.test(error.message)) return null;
        throw error;
      });
      const [trades, equity] = await Promise.all([run.api.runTrades(run.id), run.api.runEquity(run.id)]);
      return {
        runId: String(run.id),
        barsProcessed: this.bars.length,
        venueMetrics: reply?.metrics ?? null,
        equity,
        trades: trades.map((t): ReplayTrade => ({
          direction: t.direction.toLowerCase().startsWith('l') ? 'LONG' : 'SHORT', quantity: t.quantity, entryAt: Date.parse(t.entry_at), entryPrice: t.entry_price,
          exitAt: Date.parse(t.exit_at), exitPrice: t.exit_price, netPnl: t.net_pnl, commission: t.commission, barsHeld: t.bars_held, exitReason: t.exit_reason,
        })),
      };
    });
  }

  async getSnapshot(request: SnapshotRequest): Promise<MarketSnapshot> {
    const run = this.requireRun();
    if (request.symbol !== run.symbol) throw new MarketDataError(`the replay holds ${run.symbol} only, not ${request.symbol}`);
    const frame = TIMEFRAME_MS[run.timeframe];
    const closed = this.bars.filter((bar) => bar.openTime + frame <= request.asOf).slice(-request.bars);
    const last = closed.at(-1);
    if (!last) throw new MarketDataError(`the replay has revealed no ${run.symbol} bar closed by ${request.asOf}`);
    // The replay's mark is the close of the bar just revealed; funding and open interest are not part of an OHLC replay
    return { symbol: run.symbol, asOf: request.asOf, candles: { [run.timeframe]: closed }, markPrice: last.close, markAt: request.asOf, fundingRate: null, openInterest: null };
  }

  getAccount(asOf: number): Promise<AccountView> {
    const run = this.requireRun();
    return translating(async () => {
      const account = await run.api.getAccount();
      if (!account) throw new VenueRejectedError(`replay account for run ${run.id} does not exist`);
      const position = this.lastStep?.position ?? null;
      const mark = this.bars.at(-1)?.close ?? 0;
      return {
        asOf,
        equity: this.lastStep?.equity ?? this.initialCapital,
        availableMargin: account.availableBalance,
        realizedPnl: account.realizedPnl,
        positions: position && position.quantity > 0 ? [{
          symbol: run.symbol, direction: position.side === 'long' ? 'LONG' : 'SHORT', quantity: position.quantity, entryPrice: position.avg_price,
          markPrice: mark, leverage: 1, unrealizedPnl: position.unrealized_pnl, stopLoss: this.stops.get(run.symbol) ?? null,
        }] : [],
      };
    });
  }

  submitOrder(command: PlaceOrderCommand): Promise<VenueOrderAck> {
    const run = this.requireRun();
    return translating(async () => {
      const intent = await run.api.submitReplayOrder({
        symbol: command.symbol, side: command.side === 'BUY' ? 'buy' : 'sell', quantity: command.quantity, leverage: command.leverage,
        clientOrderId: command.idempotencyKey, stopLoss: command.stopLoss, takeProfit: command.takeProfit,
      });
      this.stops.set(command.symbol, command.stopLoss);
      return { venueOrderId: `intent-${intent.id}`, status: 'QUEUED', filledQuantity: 0, averagePrice: null, protectionCarried: true };
    });
  }

  findOrder(idempotencyKey: string): Promise<VenueOrderAck | null> {
    const run = this.requireRun();
    return translating(async () => {
      const intent = await run.api.findReplayIntent(run.id, idempotencyKey);
      return intent ? { venueOrderId: `intent-${intent.id}`, status: 'QUEUED', filledQuantity: 0, averagePrice: null, protectionCarried: true } : null;
    });
  }

  /** The stop and target travel on the replay order itself. */
  async protect(): Promise<void> {}

  flatten(command: PlaceOrderCommand): Promise<void> {
    const run = this.requireRun();
    return translating(async () => {
      const quantity = this.lastStep?.position?.quantity ?? command.quantity;
      await run.api.submitReplayOrder({ symbol: command.symbol, side: command.side === 'BUY' ? 'sell' : 'buy', quantity, leverage: command.leverage, clientOrderId: `${command.idempotencyKey}-flat`, reduceOnly: true });
    });
  }

  private requireRun() {
    if (!this.run) throw new Error('open() the replay before using it');
    return this.run;
  }
}
