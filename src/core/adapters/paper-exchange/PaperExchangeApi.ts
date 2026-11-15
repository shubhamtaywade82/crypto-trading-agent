import { OrderRejectedError, PaperExchangeClient, VenueUnavailableError as ClientUnavailableError } from '../../../binance/paperExchangeClient.js';
import { VenueRejectedError, VenueUnavailableError } from '../../ports/PaperExecutionPort.js';

type Raw = Record<string, unknown>;

export interface ProtectionView {
  readonly id: number;
  readonly type: 'stop_loss' | 'take_profit' | 'trailing_stop';
  readonly triggerPrice: number | null;
  readonly status: string;
}

export interface ReplayBar {
  readonly bar_at: string;
  readonly open: number;
  readonly high: number;
  readonly low: number;
  readonly close: number;
  readonly volume: number;
}

export interface ReplayStepReply {
  readonly bar: ReplayBar;
  readonly bars_processed: number;
  readonly equity: number;
  readonly in_market: boolean;
  readonly position: { side: 'long' | 'short'; quantity: number; avg_price: number; unrealized_pnl: number } | null;
  readonly fills: ReadonlyArray<{ paper_order_id: number; side: string; quantity: number; price: number; commission: number; role: string | null; reason: string | null }>;
  readonly finished: boolean;
}

export interface ReplayRunReply {
  readonly id: number;
  readonly status: string;
  readonly account_id: string;
  readonly bars_processed: number;
  readonly metrics: Record<string, unknown> | null;
  readonly verdict: unknown;
  readonly failure_reason: string | null;
}

export interface ReplayTradeReply {
  readonly direction: string;
  readonly quantity: number;
  readonly entry_at: string;
  readonly entry_price: number;
  readonly exit_at: string;
  readonly exit_price: number;
  readonly net_pnl: number;
  readonly commission: number;
  readonly bars_held: number;
  readonly exit_reason: string | null;
}

/**
 * The repository's existing PaperExchange HTTP client (auth, timeouts, 4xx/5xx classification, order idempotency),
 * extended with the endpoints the paper core needs: position protections and the external backtest replay.
 */
export class PaperExchangeApi extends PaperExchangeClient {
  async listProtections(positionId: number): Promise<ProtectionView[]> {
    const rows = await this.request<Raw[]>('GET', `/api/positions/${positionId}/protections`);
    return rows.map((row) => ({
      id: Number(row.id),
      type: row.protection_type as ProtectionView['type'],
      triggerPrice: row.trigger_price === null || row.trigger_price === undefined ? null : Number(row.trigger_price),
      status: String(row.status),
    }));
  }

  async createProtection(positionId: number, type: 'stop_loss' | 'take_profit', triggerPrice: number, quantity: number): Promise<void> {
    await this.request('POST', `/api/positions/${positionId}/protections`, { protection: { protection_type: type, trigger_price: triggerPrice, quantity } });
  }

  createDataset(body: { name: string; symbol: string; timeframe: string; bars: readonly ReplayBar[] }): Promise<{ id: number; bars_count: number }> {
    return this.request('POST', '/api/backtest_datasets', { ...body, instrument_type: 'CRYPTO_PERPETUAL' });
  }

  createExternalRun(body: { dataset_id: number; name: string; initial_capital: number; leverage: number; slippage_bps: number; lot_size: number; manifest: Record<string, unknown> }): Promise<ReplayRunReply> {
    return this.request('POST', '/api/backtest_runs', { ...body, mode: 'external' });
  }

  advanceRun(runId: number): Promise<ReplayStepReply> {
    return this.request('POST', `/api/backtest_runs/${runId}/advance`);
  }

  finishRun(runId: number): Promise<ReplayRunReply> {
    return this.request('POST', `/api/backtest_runs/${runId}/finish`);
  }

  async runTrades(runId: number): Promise<ReplayTradeReply[]> {
    const trades: ReplayTradeReply[] = [];
    await this.walkPages(`/api/backtest_runs/${runId}/trades`, 200, (rows) => {
      trades.push(...(rows as unknown as ReplayTradeReply[]));
      return false;
    });
    return trades.sort((a, b) => Date.parse(a.entry_at) - Date.parse(b.entry_at));
  }

  async runEquity(runId: number): Promise<Array<{ at: number; equity: number }>> {
    const reply = await this.request<{ data: Array<{ at: string; equity: number }> }>('GET', `/api/backtest_runs/${runId}/equity`);
    return reply.data.map((point) => ({ at: Date.parse(point.at), equity: Number(point.equity) }));
  }

  async findReplayIntent(runId: number, clientOrderId: string): Promise<{ id: number; status: string } | null> {
    let match: Raw | undefined;
    await this.walkPages(`/api/backtest_runs/${runId}/intents`, 20, (rows) => {
      match = rows.find((row) => row.client_order_id === clientOrderId);
      return match !== undefined;
    });
    return match ? { id: Number(match.id), status: String(match.status) } : null;
  }

  /** An order on a replay account: no execution price (the replay fills at the next bar's open), stop and target on the order. */
  submitReplayOrder(order: { symbol: string; side: 'buy' | 'sell'; quantity: number; leverage: number; clientOrderId: string; stopLoss?: number; takeProfit?: number; reduceOnly?: boolean }): Promise<{ id: number; status: string }> {
    return this.request('POST', '/api/orders', {
      order: {
        symbol: order.symbol, side: order.side, quantity: order.quantity, order_type: 'market', instrument_type: 'CRYPTO_PERPETUAL',
        leverage: order.leverage, client_order_id: order.clientOrderId,
        ...(order.reduceOnly ? { reduce_only: true } : { stop_loss: order.stopLoss, take_profit: order.takeProfit }),
      },
    });
  }
}

/** Maps the HTTP client's errors onto the port's two outcomes: refused, or unknown. */
export async function translating<T>(action: () => Promise<T>): Promise<T> {
  try {
    return await action();
  } catch (error) {
    if (error instanceof OrderRejectedError) throw new VenueRejectedError(error.message, { cause: error });
    if (error instanceof ClientUnavailableError) throw new VenueUnavailableError(error.message, { cause: error });
    throw error;
  }
}
